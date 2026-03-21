/**
 * Inbound Service
 * - สแกน QR Code บนลัง → ดึง manifest
 * - เปรียบเทียบกับ Request เดิม
 * - บันทึก receipt + discrepancy
 * - อัปเดตสถานะลัง → 'received'
 */

const { query, withTransaction } = require('../../config/database');
const { emitToRequest }          = require('../notification/notificationService');

// ─── Scan Box Barcode ─────────────────────────────────────────────────────────
const scanBoxBarcode = async ({ qrPayload, receiverId, posDocumentId }) => {
  // qrPayload คือ JSON ที่ parse จาก QR บนลัง
  const { boxId, items: manifestItems } = qrPayload;

  if (!boxId) return { success: false, error: 'QR payload ไม่ถูกต้อง — ไม่พบ boxId' };

  // Verify box exists and is submitted
  const { rows: [box] } = await query(
    `SELECT pb.*, r.doc_no as request_doc_no
     FROM packing_boxes pb
     JOIN purchase_requests r ON r.id = pb.request_id
     WHERE pb.id = $1`,
    [boxId]
  );

  if (!box)                     return { success: false, error: 'ไม่พบลังในระบบ — Barcode อาจไม่ถูกต้อง' };
  if (box.status === 'received') return { success: false, error: `ลัง ${box.box_no} รับเข้าแล้ว` };
  if (!['submitted', 'label_printed', 'full'].includes(box.status)) {
    return { success: false, error: `ลัง ${box.box_no} ยังไม่พร้อมรับเข้า (สถานะ: ${box.status})` };
  }

  // Fetch actual items in DB (source of truth)
  const { rows: actualItems } = await query(
    `SELECT bi.sku_code, bi.sku_name, bi.quantity_packed
     FROM box_items bi WHERE bi.box_id = $1`,
    [boxId]
  );

  // ─── Compare manifest vs actual ──────────────────────────────────────────
  const actualMap = Object.fromEntries(
    actualItems.map((i) => [i.sku_code, i.quantity_packed])
  );
  const manifestMap = Object.fromEntries(
    (manifestItems || []).map((i) => [i.sku, i.qty])
  );

  const allSkus = new Set([...Object.keys(actualMap), ...Object.keys(manifestMap)]);
  const discrepancies = [];

  for (const sku of allSkus) {
    const expected = manifestMap[sku] ?? 0;
    const actual   = actualMap[sku]   ?? 0;
    if (expected !== actual) {
      discrepancies.push({ skuCode: sku, expectedQty: expected, actualQty: actual });
    }
  }

  const inboundStatus = discrepancies.length === 0 ? 'complete' : 'discrepancy';

  const receipt = await withTransaction(async (client) => {
    // Create inbound receipt
    const { rows: [rec] } = await client.query(
      `INSERT INTO inbound_receipts (pos_document_id, box_id, received_by, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [posDocumentId || null, boxId, receiverId, inboundStatus]
    );

    // Insert discrepancies if any
    if (discrepancies.length > 0) {
      const vals = discrepancies.map((_, i) => {
        const b = i * 4;
        return `($${b+1},$${b+2},$${b+3},$${b+4})`;
      }).join(',');
      await client.query(
        `INSERT INTO inbound_discrepancies (receipt_id, sku_code, expected_qty, actual_qty)
         VALUES ${vals}`,
        discrepancies.flatMap((d) => [rec.id, d.skuCode, d.expectedQty, d.actualQty])
      );
    }

    // Mark box as received
    await client.query(
      `UPDATE packing_boxes SET status = 'received', updated_at = NOW() WHERE id = $1`,
      [boxId]
    );

    // Scan log
    await client.query(
      `INSERT INTO scan_logs (user_id, action, reference_id, barcode, metadata)
       VALUES ($1, 'inbound_scan', $2, $3, $4)`,
      [receiverId, rec.id, boxId, JSON.stringify({ boxNo: box.box_no, status: inboundStatus })]
    );

    return rec;
  });

  // Emit real-time notification
  await emitToRequest(box.request_id, 'inbound:received', {
    boxId,
    boxNo:          box.box_no,
    receiptId:      receipt.id,
    status:         inboundStatus,
    discrepancies,
    requestDocNo:   box.request_doc_no,
  });

  return {
    success:        true,
    receiptId:      receipt.id,
    boxNo:          box.box_no,
    requestDocNo:   box.request_doc_no,
    status:         inboundStatus,
    totalSkus:      actualItems.length,
    discrepancies,
    message:        inboundStatus === 'complete'
                      ? `รับเข้าสำเร็จ ✓ ลัง ${box.box_no} ครบถ้วน`
                      : `พบความไม่ตรงกัน ${discrepancies.length} รายการ`,
  };
};

// ─── Confirm Inbound with POS Document No. ────────────────────────────────────
const confirmInbound = async ({ requestId, posDocNo, posDocDate, confirmedBy }) => {
  // Verify all boxes in request are received
  const { rows: pending } = await query(
    `SELECT COUNT(*) as cnt FROM packing_boxes
     WHERE request_id = $1 AND status NOT IN ('received','cancelled')`,
    [requestId]
  );

  if (parseInt(pending[0].cnt) > 0) {
    return { success: false, error: `ยังมี ${pending[0].cnt} ลังที่ยังไม่ได้รับเข้า` };
  }

  return withTransaction(async (client) => {
    // Create POS document record
    const { rows: [posDoc] } = await client.query(
      `INSERT INTO pos_documents (request_id, pos_doc_no, pos_doc_date, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [requestId, posDocNo, posDocDate, confirmedBy]
    );

    // Mark request as completed
    await client.query(
      `UPDATE purchase_requests SET status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    return { success: true, posDocId: posDoc.id, posDocNo };
  });
};

// ─── Get Receipt Summary for a Request ────────────────────────────────────────
const getReceiptSummary = async (requestId) => {
  const { rows: boxes } = await query(
    `SELECT
       pb.id, pb.box_no, pb.status, pb.sku_count,
       ir.id as receipt_id, ir.status as receipt_status,
       ir.received_at,
       COUNT(id2.id) as discrepancy_count
     FROM packing_boxes pb
     LEFT JOIN inbound_receipts ir ON ir.box_id = pb.id
     LEFT JOIN inbound_discrepancies id2 ON id2.receipt_id = ir.id
     WHERE pb.request_id = $1
     GROUP BY pb.id, pb.box_no, pb.status, pb.sku_count,
              ir.id, ir.status, ir.received_at
     ORDER BY pb.box_no`,
    [requestId]
  );

  const totalBoxes    = boxes.length;
  const received      = boxes.filter((b) => b.status === 'received').length;
  const withIssues    = boxes.filter((b) => parseInt(b.discrepancy_count) > 0).length;

  return {
    requestId,
    totalBoxes,
    received,
    pending: totalBoxes - received,
    complete: received === totalBoxes,
    withIssues,
    boxes,
  };
};

module.exports = {
  scanBoxBarcode,
  confirmInbound,
  getReceiptSummary,
};
