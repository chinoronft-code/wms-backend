/**
 * POS Integration Service
 * - ส่งข้อมูล Request ที่เสร็จสิ้นไปยังระบบ POS
 * - Retry logic + error logging
 */

const { query } = require('../../config/database');

// ─── Build POS Payload ────────────────────────────────────────────────────────
const buildPosPayload = async (requestId, posDocNo) => {
  const { rows: items } = await query(
    `SELECT ri.sku_code, ri.sku_name, SUM(bi.quantity_packed) as qty
     FROM request_items ri
     JOIN box_items bi ON bi.request_item_id = ri.id
     JOIN packing_boxes pb ON pb.id = bi.box_id
     WHERE ri.request_id = $1 AND pb.status = 'received'
     GROUP BY ri.sku_code, ri.sku_name
     ORDER BY ri.sku_code`,
    [requestId]
  );

  const { rows: [req] } = await query(
    `SELECT * FROM purchase_requests WHERE id = $1`, [requestId]
  );

  return {
    docType:    'GOODS_RECEIPT',
    docNo:      posDocNo,
    refDocNo:   req.doc_no,
    docDate:    new Date().toISOString().split('T')[0],
    items:      items.map((i) => ({
      skuCode: i.sku_code,
      skuName: i.sku_name,
      qty:     parseInt(i.qty),
    })),
    createdAt: new Date().toISOString(),
  };
};

// ─── Send to POS API ──────────────────────────────────────────────────────────
const syncToPOS = async (posDocumentId) => {
  const { rows: [doc] } = await query(
    `SELECT pd.*, r.id as request_id
     FROM pos_documents pd
     JOIN purchase_requests r ON r.id = pd.request_id
     WHERE pd.id = $1`,
    [posDocumentId]
  );

  if (!doc) return { success: false, error: 'ไม่พบ POS Document' };
  if (doc.status === 'synced') return { success: true, message: 'ส่งไป POS แล้ว' };

  const payload = await buildPosPayload(doc.request_id, doc.pos_doc_no);

  try {
    // ─── ส่วนนี้ปรับให้ตรงกับ API ของ POS ที่ใช้งาน ───────────────────────
    const response = await fetch(process.env.POS_API_URL + '/goods-receipt', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    process.env.POS_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),   // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`POS API responded ${response.status}: ${await response.text()}`);
    }

    await query(
      `UPDATE pos_documents SET status = 'synced', synced_at = NOW() WHERE id = $1`,
      [posDocumentId]
    );

    return { success: true, posDocNo: doc.pos_doc_no, payload };

  } catch (err) {
    await query(
      `UPDATE pos_documents SET status = 'error', error_message = $1 WHERE id = $2`,
      [err.message, posDocumentId]
    );
    console.error('[POS Sync] Failed:', err.message);
    return { success: false, error: err.message };
  }
};

// ─── Export to JSON (fallback เมื่อไม่มี POS API) ─────────────────────────────
const exportToJson = async (requestId) => {
  const { rows: [req] } = await query(
    `SELECT * FROM purchase_requests WHERE id = $1`, [requestId]
  );

  const { rows: boxes } = await query(
    `SELECT pb.box_no, pb.sku_count,
       json_agg(json_build_object(
         'sku_code', bi.sku_code,
         'sku_name', bi.sku_name,
         'qty', bi.quantity_packed
       ) ORDER BY bi.sku_code) as items
     FROM packing_boxes pb
     JOIN box_items bi ON bi.box_id = pb.id
     WHERE pb.request_id = $1
     GROUP BY pb.id, pb.box_no, pb.sku_count
     ORDER BY pb.box_no`,
    [requestId]
  );

  return {
    request: {
      id:    req.id,
      docNo: req.doc_no,
      date:  req.created_at,
    },
    boxes,
    exportedAt: new Date().toISOString(),
  };
};

module.exports = { syncToPOS, exportToJson, buildPosPayload };
