/**
 * Packing Service
 * - สร้าง / เปิด / ปิดลัง
 * - สแกน Barcode เพิ่ม SKU เข้าลัง (max 20 SKU/ลัง)
 * - ตรวจ SKU ซ้ำ / SKU ไม่ใช่ของ Packer คนนี้
 * - อัปเดต progress ใน Redis สำหรับ Real-time
 */

const { query, withTransaction } = require('../../config/database');
const { getRedis, keys }         = require('../../config/redis');
const { emitToRequest }          = require('../notification/notificationService');

const MAX_SKU_PER_BOX = parseInt(process.env.MAX_SKU_PER_BOX) || 20;

// ─── Generate Box Number ──────────────────────────────────────────────────────
const nextBoxNo = async (client, requestId) => {
  const { rows } = await client.query(
    `SELECT COUNT(*) as cnt FROM packing_boxes WHERE request_id = $1`,
    [requestId]
  );
  const seq = parseInt(rows[0].cnt) + 1;
  return `BOX-${String(seq).padStart(3, '0')}`;
};

// ─── Get or Create Active Box for Packer ─────────────────────────────────────
const getOrCreateActiveBox = async (requestId, packerId) => {
  return withTransaction(async (client) => {
    // Try to find the packer's latest open box
    const { rows: [existingBox] } = await client.query(
      `SELECT * FROM packing_boxes
       WHERE request_id = $1 AND packed_by = $2 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [requestId, packerId]
    );

    if (existingBox && existingBox.sku_count < MAX_SKU_PER_BOX) {
      return { box: existingBox, isNew: false };
    }

    // Create a new box
    const boxNo = await nextBoxNo(client, requestId);
    const { rows: [newBox] } = await client.query(
      `INSERT INTO packing_boxes (request_id, box_no, packed_by, status, sku_count)
       VALUES ($1, $2, $3, 'open', 0) RETURNING *`,
      [requestId, boxNo, packerId]
    );

    return { box: newBox, isNew: true };
  });
};

// ─── Scan SKU into Box ────────────────────────────────────────────────────────
const scanSku = async ({ requestId, barcode, packerId }) => {
  const redis = await getRedis();

  // Distributed lock: prevent double-scan of same barcode within 5 seconds
  const lockKey = keys.scanLock(barcode);
  const locked  = await redis.set(lockKey, packerId, { NX: true, EX: 5 });
  if (!locked) {
    return { success: false, error: 'Barcode กำลังถูกสแกนโดยคนอื่น กรุณารอสักครู่' };
  }

  try {
    return await withTransaction(async (client) => {

      // 1) Find SKU in this request assigned to this packer
      const { rows: [item] } = await client.query(
        `SELECT * FROM request_items
         WHERE request_id = $1 AND (barcode = $2 OR sku_code = $2) AND assigned_to = $3`,
        [requestId, barcode, packerId]
      );

      if (!item) {
        // Check if SKU exists but belongs to someone else
        const { rows: [otherItem] } = await client.query(
          `SELECT u.full_name FROM request_items ri
           JOIN users u ON u.id = ri.assigned_to
           WHERE ri.request_id = $1 AND (ri.barcode = $2 OR ri.sku_code = $2)`,
          [requestId, barcode]
        );
        if (otherItem) {
          return { success: false, error: `SKU นี้เป็นของ ${otherItem.full_name} ไม่ใช่ของคุณ` };
        }
        return { success: false, error: 'ไม่พบ SKU นี้ใน Request — กรุณาตรวจสอบ Barcode' };
      }

      if (item.is_packed) {
        // Find which box it's in
        const { rows: [bi] } = await client.query(
          `SELECT pb.box_no FROM box_items bi
           JOIN packing_boxes pb ON pb.id = bi.box_id
           WHERE bi.request_item_id = $1`,
          [item.id]
        );
        return { success: false, error: `สแกนซ้ำ — SKU ${item.sku_code} อยู่ใน ${bi?.box_no || 'ลังอื่น'} แล้ว` };
      }

      // 2) Get or create active box
      const { box } = await getOrCreateActiveBox(requestId, packerId);

      if (box.sku_count >= MAX_SKU_PER_BOX) {
        return { success: false, error: `ลัง ${box.box_no} เต็มแล้ว (${MAX_SKU_PER_BOX} SKU) — ระบบกำลังเปิดลังใหม่ให้` };
      }

      // 3) Add item to box
      await client.query(
        `INSERT INTO box_items (box_id, request_item_id, sku_code, sku_name, quantity_packed, scanned_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [box.id, item.id, item.sku_code, item.sku_name, item.quantity, packerId]
      );

      // 4) Update box SKU count
      const newCount = box.sku_count + 1;
      const boxStatus = newCount >= MAX_SKU_PER_BOX ? 'full' : 'open';
      await client.query(
        `UPDATE packing_boxes SET sku_count = $1, status = $2, updated_at = NOW()
         WHERE id = $3`,
        [newCount, boxStatus, box.id]
      );

      // 5) Mark item as packed
      await client.query(
        `UPDATE request_items SET is_packed = TRUE WHERE id = $1`,
        [item.id]
      );

      // 6) Log scan
      await client.query(
        `INSERT INTO scan_logs (user_id, action, reference_id, barcode, metadata)
         VALUES ($1, 'pack_scan', $2, $3, $4)`,
        [packerId, box.id, barcode, JSON.stringify({ skuCode: item.sku_code, boxNo: box.box_no })]
      );

      // 7) Update Redis progress counter
      const progressKey = keys.requestProgress(requestId);
      await redis.hIncrBy(progressKey, packerId, 1);
      await redis.expire(progressKey, 86400); // 24h TTL

      // 8) Emit real-time event via Socket.io
      await emitToRequest(requestId, 'packing:scan', {
        boxId:    box.id,
        boxNo:    box.box_no,
        skuCode:  item.sku_code,
        skuName:  item.sku_name,
        boxCount: newCount,
        boxStatus,
        packerId,
      });

      return {
        success:  true,
        boxNo:    box.box_no,
        boxId:    box.id,
        skuCode:  item.sku_code,
        skuName:  item.sku_name,
        boxCount: newCount,
        boxFull:  boxStatus === 'full',
      };
    });
  } finally {
    await redis.del(lockKey);
  }
};

// ─── Close Box Manually ───────────────────────────────────────────────────────
const closeBox = async (boxId, packerId) => {
  const { rows: [box] } = await query(
    `SELECT * FROM packing_boxes WHERE id = $1 AND packed_by = $2`,
    [boxId, packerId]
  );
  if (!box) return { success: false, error: 'ไม่พบลัง หรือคุณไม่มีสิทธิ์ปิดลังนี้' };
  if (box.status !== 'open') return { success: false, error: `ลังนี้ไม่ได้อยู่ในสถานะ open (${box.status})` };
  if (box.sku_count === 0) return { success: false, error: 'ลังว่าง — ไม่สามารถปิดได้' };

  await query(
    `UPDATE packing_boxes SET status = 'full', updated_at = NOW() WHERE id = $1`,
    [boxId]
  );
  return { success: true, boxNo: box.box_no };
};

// ─── Get Box Detail ────────────────────────────────────────────────────────────
const getBoxDetail = async (boxId) => {
  const { rows: [box] } = await query(
    `SELECT pb.*, u.full_name as packer_name, r.doc_no as request_doc_no
     FROM packing_boxes pb
     LEFT JOIN users u ON u.id = pb.packed_by
     LEFT JOIN purchase_requests r ON r.id = pb.request_id
     WHERE pb.id = $1`,
    [boxId]
  );
  if (!box) return null;

  const { rows: items } = await query(
    `SELECT bi.*, ri.quantity as ordered_qty
     FROM box_items bi
     JOIN request_items ri ON ri.id = bi.request_item_id
     WHERE bi.box_id = $1
     ORDER BY bi.scanned_at ASC`,
    [boxId]
  );

  return { ...box, items };
};

// ─── List Boxes for a Request ─────────────────────────────────────────────────
const listBoxes = async (requestId, packerId = null) => {
  const conditions = packerId
    ? 'WHERE pb.request_id = $1 AND pb.packed_by = $2'
    : 'WHERE pb.request_id = $1';
  const params = packerId ? [requestId, packerId] : [requestId];

  const { rows } = await query(
    `SELECT pb.*, u.full_name as packer_name
     FROM packing_boxes pb
     LEFT JOIN users u ON u.id = pb.packed_by
     ${conditions}
     ORDER BY pb.box_no ASC`,
    params
  );
  return rows;
};

// ─── Get Packing Progress Summary ─────────────────────────────────────────────
const getProgress = async (requestId) => {
  const { rows } = await query(
    `SELECT
       u.id as packer_id,
       u.full_name,
       COUNT(ri.id) as total,
       COUNT(ri.id) FILTER (WHERE ri.is_packed) as packed,
       COUNT(DISTINCT pb.id) FILTER (WHERE pb.status = 'full') as full_boxes,
       COUNT(DISTINCT pb.id) FILTER (WHERE pb.status = 'open') as open_boxes
     FROM users u
     JOIN request_items ri ON ri.assigned_to = u.id AND ri.request_id = $1
     LEFT JOIN box_items bi ON bi.request_item_id = ri.id
     LEFT JOIN packing_boxes pb ON pb.id = bi.box_id
     GROUP BY u.id, u.full_name
     ORDER BY u.full_name`,
    [requestId]
  );
  return rows;
};

module.exports = {
  scanSku,
  closeBox,
  getBoxDetail,
  listBoxes,
  getProgress,
  getOrCreateActiveBox,
};
