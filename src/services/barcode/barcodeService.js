/**
 * Barcode Service
 * - สร้าง QR Code payload จากข้อมูลลัง
 * - Render PDF Label (A6) พร้อม Barcode ติดลัง
 * - บันทึก label_url กลับใน packing_boxes
 */

const QRCode  = require('qrcode');
const PDFDoc  = require('pdfkit');
const path    = require('path');
const fs      = require('fs');
const { query }            = require('../../config/database');
const { getBoxDetail }     = require('../packing/packingService');

// Local fallback storage (ใน production ใช้ S3/MinIO แทน)
const LABEL_DIR = path.join(process.cwd(), 'labels');
if (!fs.existsSync(LABEL_DIR)) fs.mkdirSync(LABEL_DIR, { recursive: true });

// ─── Build QR Payload ─────────────────────────────────────────────────────────
const buildQrPayload = (box, items) => ({
  v:         1,                           // schema version
  boxId:     box.id,
  boxNo:     box.box_no,
  requestId: box.request_id,
  docNo:     box.request_doc_no,
  packedBy:  box.packer_name,
  skuCount:  box.sku_count,
  items:     items.map((i) => ({
    sku:  i.sku_code,
    name: i.sku_name,
    qty:  i.quantity_packed,
  })),
  ts: new Date().toISOString(),
});

// ─── Generate QR PNG Buffer ───────────────────────────────────────────────────
const generateQrBuffer = async (payload) => {
  const data = JSON.stringify(payload);
  return QRCode.toBuffer(data, {
    type:          'png',
    width:         300,
    margin:        2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
};

// ─── Render PDF Label (A6 = 148×105mm) ───────────────────────────────────────
const renderPdfLabel = async (box, items, qrBuffer) => {
  return new Promise((resolve, reject) => {
    const chunks = [];

    // A6 in points (1mm = 2.8346pt)
    const doc = new PDFDoc({
      size:    [419.53, 297.64],  // A6 landscape
      margins: { top: 14, left: 14, right: 14, bottom: 14 },
    });

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 419.53;
    const H = 297.64;

    // Header bar
    doc.rect(0, 0, W, 44).fill('#1B3A6B');
    doc.fillColor('white').fontSize(16).font('Helvetica-Bold')
       .text('WMS PRO — PACKING LABEL', 0, 12, { align: 'center', width: W });

    // Box number (large)
    doc.fillColor('#1B3A6B').fontSize(28).font('Helvetica-Bold')
       .text(box.box_no, 14, 54, { width: 180 });

    // Document ref
    doc.fillColor('#444').fontSize(9).font('Helvetica')
       .text(`Document: ${box.request_doc_no || '—'}`, 14, 90)
       .text(`Packer: ${box.packer_name || '—'}`,      14, 104)
       .text(`Packed: ${new Date().toLocaleDateString('th-TH')}`, 14, 118)
       .text(`SKU Count: ${items.length} items`,        14, 132);

    // QR Code
    doc.image(qrBuffer, W - 145, 50, { width: 130, height: 130 });
    doc.fillColor('#888').fontSize(7)
       .text('Scan to receive', W - 145, 185, { width: 130, align: 'center' });

    // Divider
    doc.moveTo(14, 154).lineTo(W - 14, 154).lineWidth(0.5).strokeColor('#ccc').stroke();

    // SKU list (up to 10 rows visible)
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#333')
       .text('#', 14, 162)
       .text('SKU Code', 32, 162)
       .text('Name', 130, 162)
       .text('Qty', W - 60, 162, { width: 40, align: 'right' });

    doc.moveTo(14, 172).lineTo(W - 14, 172).lineWidth(0.3).stroke();

    const displayItems = items.slice(0, 12);
    displayItems.forEach((item, i) => {
      const y = 176 + i * 10;
      const bg = i % 2 === 0 ? '#F9FAFB' : '#FFFFFF';
      doc.rect(14, y - 1, W - 28, 10).fill(bg);
      doc.fillColor('#222').font('Helvetica').fontSize(7.5)
         .text(String(i + 1), 14, y, { width: 16 })
         .text(item.sku_code,  32, y, { width: 96 })
         .text(item.sku_name.substring(0, 26), 130, y, { width: 190 })
         .text(String(item.quantity_packed), W - 60, y, { width: 40, align: 'right' });
    });

    if (items.length > 12) {
      doc.fillColor('#888').fontSize(7)
         .text(`... and ${items.length - 12} more items`, 14, 176 + 12 * 10);
    }

    // Footer
    doc.rect(0, H - 22, W, 22).fill('#F0F4F9');
    doc.fillColor('#666').fontSize(7)
       .text(`Box ID: ${box.id}`, 14, H - 16, { width: W - 28 });

    doc.end();
  });
};

// ─── Generate Label for Box ───────────────────────────────────────────────────
const generateBoxLabel = async (boxId) => {
  const box = await getBoxDetail(boxId);
  if (!box)       return { success: false, error: 'ไม่พบลัง' };
  if (!box.items?.length) return { success: false, error: 'ลังว่าง — ไม่มี SKU' };

  const payload   = buildQrPayload(box, box.items);
  const qrBuffer  = await generateQrBuffer(payload);
  const pdfBuffer = await renderPdfLabel(box, box.items, qrBuffer);

  // Save PDF locally (swap with S3 upload in production)
  const filename  = `label-${box.box_no}-${Date.now()}.pdf`;
  const filepath  = path.join(LABEL_DIR, filename);
  fs.writeFileSync(filepath, pdfBuffer);

  const labelUrl = `/labels/${filename}`;  // served as static

  // Persist QR payload + label URL in DB
  await query(
    `UPDATE packing_boxes
     SET barcode_data = $1, label_url = $2, status = CASE WHEN status = 'full' THEN 'label_printed' ELSE status END, updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify(payload), labelUrl, boxId]
  );

  return {
    success:  true,
    boxNo:    box.box_no,
    labelUrl,
    pdfBuffer,
    payload,
  };
};

// ─── Generate Labels for All Boxes in a Request ───────────────────────────────
const generateAllLabels = async (requestId, packerId = null) => {
  const cond   = packerId ? 'AND packed_by = $2' : '';
  const params = packerId ? [requestId, packerId] : [requestId];

  const { rows: boxes } = await query(
    `SELECT id FROM packing_boxes
     WHERE request_id = $1 ${cond} AND status IN ('full','label_printed','submitted')
     ORDER BY box_no`,
    params
  );

  const results = [];
  for (const { id } of boxes) {
    const result = await generateBoxLabel(id);
    results.push({ boxId: id, ...result });
  }
  return results;
};

module.exports = {
  generateBoxLabel,
  generateAllLabels,
  buildQrPayload,
};
