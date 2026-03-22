/**
 * Request Service
 * - Import Excel/CSV จากจัดซื้อ
 * - สร้าง Purchase Request + รายการ SKU
 * - แบ่ง SKU ให้ Packer อัตโนมัติ (ค่า default = 200 SKU/คน)
 */

const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../../config/database');

const SKU_PER_PACKER = parseInt(process.env.SKU_PER_PACKER) || 200;

// ─── Generate Document Number ────────────────────────────────────────────────
const generateDocNo = () => {
  const d = new Date();
  const yy   = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `REQ-${yy}-${mm}${dd}-${rand}`;
};

// ─── Parse Excel / CSV Buffer ────────────────────────────────────────────────
const parseImportFile = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];

  // อ่านเป็น array (header:1) เพื่อใช้ตำแหน่ง column
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const items  = [];
  const errors = [];

  // R=17, W=22, AB=27, AC=28 (0-based index)
  const COL_BARCODE  = 17;  // R
  const COL_QTY      = 22;  // W
  const COL_SKU      = 27;  // AB
  const COL_NAME     = 28;  // AC

  // เริ่มจาก row ที่ 2 (index 1) ข้าม header
  rows.slice(1).forEach((row, idx) => {
    const lineNo  = idx + 2;
    const skuCode = String(row[COL_SKU]  || '').trim();
    const skuName = String(row[COL_NAME] || '').trim();
    const barcode = String(row[COL_BARCODE] || '').trim();
    const qty     = parseInt(row[COL_QTY]) || 1;

    if (!skuCode) { errors.push(`Row ${lineNo}: missing SKU Code (col AB)`); return; }
    if (!skuName) { errors.push(`Row ${lineNo}: missing SKU Name (col AC)`); return; }

    items.push({ skuCode, skuName, barcode, quantity: qty });
  });

  return { items, errors };
};

// ─── Assign SKU blocks round-robin to active packers ────────────────────────
const assignSkuToPackers = (items, packerIds) => {
  if (!packerIds.length) throw new Error('No active packers available');

  const assignments = [];
  packerIds.forEach((packerId, i) => {
    const start = i * SKU_PER_PACKER;
    const slice = items.slice(start, start + SKU_PER_PACKER);
    slice.forEach((item) => assignments.push({ ...item, assignedTo: packerId }));
  });

  // Items beyond packer capacity go to last packer
  const covered = packerIds.length * SKU_PER_PACKER;
  items.slice(covered).forEach((item) =>
    assignments.push({ ...item, assignedTo: packerIds[packerIds.length - 1] })
  );

  return assignments;
};

// ─── Import Request ──────────────────────────────────────────────────────────
const importRequest = async ({ fileBuffer, mimetype, description, createdBy }) => {
  const { items, errors } = parseImportFile(fileBuffer, mimetype);
  if (errors.length) return { success: false, errors };
  if (!items.length) return { success: false, errors: ['File contains no data rows'] };

  // Check for duplicate SKU codes in this import
  const skuCodes = items.map((i) => i.skuCode);
  const dupes = skuCodes.filter((v, i, a) => a.indexOf(v) !== i);
  if (dupes.length) {
    return { success: false, errors: [`Duplicate SKU codes: ${[...new Set(dupes)].join(', ')}`] };
  }

  // Fetch active packers (role = 'packer')
  const { rows: packers } = await query(
    `SELECT id FROM users WHERE role = 'packer' AND is_active = TRUE ORDER BY username`
  );
  if (!packers.length) {
    return { success: false, errors: ['No active packers in the system'] };
  }

  const packerIds   = packers.map((p) => p.id);
  const assignments = assignSkuToPackers(items, packerIds);
  const docNo       = generateDocNo();

  const request = await withTransaction(async (client) => {
    // Create Purchase Request
    const { rows: [req] } = await client.query(
      `INSERT INTO purchase_requests (doc_no, description, total_sku, status, created_by)
       VALUES ($1, $2, $3, 'assigned', $4) RETURNING *`,
      [docNo, description || null, items.length, createdBy]
    );

    // Bulk insert request items
    if (assignments.length > 0) {
      const values = assignments.map((_, i) => {
        const base = i * 5;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6})`;
      }).join(',');

      const params = assignments.flatMap((a) => [
        uuidv4(), req.id, a.skuCode, a.skuName, a.barcode || null,
        a.quantity
      ]);
      // rebuild with assignedTo
      const vals2 = assignments.map((_, i) => {
        const b = i * 6;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
      }).join(',');
      const params2 = assignments.flatMap((a) => [
        uuidv4(), req.id, a.skuCode, a.skuName,
        a.barcode || null, a.quantity, a.assignedTo,
      ]);

      await client.query(
        `INSERT INTO request_items
           (id, request_id, sku_code, sku_name, barcode, quantity, assigned_to)
         VALUES ${vals2}`,
        params2
      );
    }

    return req;
  });

  return {
    success: true,
    request: {
      id:        request.id,
      docNo:     request.doc_no,
      totalSku:  items.length,
      packers:   packerIds.length,
      skuPerPacker: SKU_PER_PACKER,
    },
  };
};

// ─── Get Request Detail ───────────────────────────────────────────────────────
const getRequest = async (requestId) => {
  const { rows: [req] } = await query(
    `SELECT r.*, u.full_name as created_by_name
     FROM purchase_requests r
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.id = $1`,
    [requestId]
  );
  if (!req) return null;

  const { rows: items } = await query(
    `SELECT ri.*, u.full_name as packer_name
     FROM request_items ri
     LEFT JOIN users u ON u.id = ri.assigned_to
     WHERE ri.request_id = $1
     ORDER BY ri.sku_code`,
    [requestId]
  );

  // Summary per packer
  const packerSummary = items.reduce((acc, item) => {
    const key = item.assigned_to || 'unassigned';
    if (!acc[key]) acc[key] = { packerName: item.packer_name, total: 0, packed: 0 };
    acc[key].total++;
    if (item.is_packed) acc[key].packed++;
    return acc;
  }, {});

  return { ...req, items, packerSummary };
};

// ─── List Requests ────────────────────────────────────────────────────────────
const listRequests = async ({ page = 1, limit = 20, status } = {}) => {
  const offset = (page - 1) * limit;
  const conditions = status ? `WHERE r.status = $3` : '';
  const params = status
    ? [limit, offset, status]
    : [limit, offset];

  const { rows } = await query(
    `SELECT r.*, u.full_name as created_by_name,
       COUNT(ri.id) as total_sku,
       COUNT(ri.id) FILTER (WHERE ri.is_packed) as packed_sku
     FROM purchase_requests r
     LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN request_items ri ON ri.request_id = r.id
     ${conditions}
     GROUP BY r.id, u.full_name
     ORDER BY r.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*) FROM purchase_requests ${status ? 'WHERE status = $1' : ''}`,
    status ? [status] : []
  );

  return { data: rows, total: parseInt(count), page, limit };
};

// ─── Get My SKU List (for Packer) ─────────────────────────────────────────────
const getMySkuList = async (requestId, packerId) => {
  const { rows } = await query(
    `SELECT ri.*, pb.box_no
     FROM request_items ri
     LEFT JOIN box_items bi ON bi.request_item_id = ri.id
     LEFT JOIN packing_boxes pb ON pb.id = bi.box_id
     WHERE ri.request_id = $1 AND ri.assigned_to = $2
     ORDER BY ri.is_packed ASC, ri.sku_code ASC`,
    [requestId, packerId]
  );
  return rows;
};

module.exports = {
  importRequest,
  getRequest,
  listRequests,
  getMySkuList,
  parseImportFile,
  assignSkuToPackers,
};
