/**
 * Routes — ทุก Endpoint รวมกัน
 *
 * Auth:
 *   POST /api/auth/login
 *
 * Requests:
 *   POST   /api/requests/import      (admin)
 *   GET    /api/requests             (admin)
 *   GET    /api/requests/:id         (admin, packer)
 *   GET    /api/requests/:id/my-sku  (packer)
 *   GET    /api/requests/:id/progress
 *
 * Packing:
 *   POST   /api/packing/scan         (packer)
 *   GET    /api/packing/boxes/:requestId
 *   GET    /api/packing/box/:boxId
 *   PATCH  /api/packing/box/:boxId/close
 *   POST   /api/packing/box/:boxId/label
 *   POST   /api/packing/submit       (packer)
 *
 * Inbound:
 *   POST   /api/inbound/scan         (receiver)
 *   POST   /api/inbound/confirm      (receiver, admin)
 *   GET    /api/inbound/summary/:requestId
 *
 * POS:
 *   POST   /api/pos/sync/:posDocId   (admin)
 *   GET    /api/pos/export/:requestId
 */

const router  = require('express').Router();
const multer  = require('multer');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Joi     = require('joi');

const { authenticate, authorize } = require('../middleware/auth');
const requestSvc   = require('../services/request/requestService');
const packingSvc   = require('../services/packing/packingService');
const barcodeSvc   = require('../services/barcode/barcodeService');
const inboundSvc   = require('../services/inbound/inboundService');
const posSvc       = require('../services/pos/posService');
const db           = require('../config/database');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Validation helper
const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
};

// ─── AUTH ─────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const { rows: [user] } = await db.query(
    `SELECT * FROM users WHERE username = $1 AND is_active = TRUE`, [username]
  );
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, fullName: user.full_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.json({ token, user: { id: user.id, username: user.username, role: user.role, fullName: user.full_name } });
});

// ─── REQUESTS ────────────────────────────────────────────────────────────────
router.post(
  '/requests/import',
  authenticate, authorize('admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'กรุณาแนบไฟล์ Excel หรือ CSV' });
    const result = await requestSvc.importRequest({
      fileBuffer:  req.file.buffer,
      mimetype:    req.file.mimetype,
      description: req.body.description,
      createdBy:   req.user.id,
    });
    res.status(result.success ? 201 : 422).json(result);
  }
);

router.get('/requests', authenticate, authorize('admin'), async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  res.json(await requestSvc.listRequests({ page: +page, limit: +limit, status }));
});

router.get('/requests/:id', authenticate, async (req, res) => {
  const data = await requestSvc.getRequest(req.params.id);
  if (!data) return res.status(404).json({ error: 'Request not found' });
  res.json(data);
});

router.get('/requests/:id/my-sku', authenticate, authorize('packer'), async (req, res) => {
  res.json(await requestSvc.getMySkuList(req.params.id, req.user.id));
});

router.get('/requests/:id/progress', authenticate, async (req, res) => {
  res.json(await packingSvc.getProgress(req.params.id));
});

// ─── PACKING ──────────────────────────────────────────────────────────────────
const scanSchema = Joi.object({
  requestId: Joi.string().uuid().required(),
  barcode:   Joi.string().min(1).max(200).required(),
});

router.post('/packing/scan', authenticate, authorize('packer'), validate(scanSchema), async (req, res) => {
  const result = await packingSvc.scanSku({
    requestId: req.body.requestId,
    barcode:   req.body.barcode,
    packerId:  req.user.id,
  });
  res.status(result.success ? 200 : 422).json(result);
});

router.get('/packing/boxes/:requestId', authenticate, async (req, res) => {
  const packerId = req.user.role === 'packer' ? req.user.id : req.query.packerId || null;
  res.json(await packingSvc.listBoxes(req.params.requestId, packerId));
});

router.get('/packing/box/:boxId', authenticate, async (req, res) => {
  const data = await packingSvc.getBoxDetail(req.params.boxId);
  if (!data) return res.status(404).json({ error: 'Box not found' });
  res.json(data);
});

router.patch('/packing/box/:boxId/close', authenticate, authorize('packer'), async (req, res) => {
  res.json(await packingSvc.closeBox(req.params.boxId, req.user.id));
});

// Generate + stream PDF label
router.post('/packing/box/:boxId/label', authenticate, async (req, res) => {
  const result = await barcodeSvc.generateBoxLabel(req.params.boxId);
  if (!result.success) return res.status(422).json(result);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="label-${result.boxNo}.pdf"`);
  res.send(result.pdfBuffer);
});

// Packer submits all their boxes
router.post('/packing/submit', authenticate, authorize('packer'), async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  await db.query(
    `UPDATE packing_boxes SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
     WHERE request_id = $1 AND packed_by = $2 AND status IN ('full','label_printed')`,
    [requestId, req.user.id]
  );
  res.json({ success: true, message: 'ส่งลังเรียบร้อยแล้ว' });
});

// ─── INBOUND ──────────────────────────────────────────────────────────────────
router.post('/inbound/scan', authenticate, authorize('receiver', 'admin'), async (req, res) => {
  const { qrPayload, posDocumentId } = req.body;
  if (!qrPayload) return res.status(400).json({ error: 'qrPayload required' });

  const payload = typeof qrPayload === 'string' ? JSON.parse(qrPayload) : qrPayload;
  const result  = await inboundSvc.scanBoxBarcode({
    qrPayload:    payload,
    receiverId:   req.user.id,
    posDocumentId,
  });
  res.status(result.success ? 200 : 422).json(result);
});

router.post('/inbound/confirm', authenticate, authorize('receiver', 'admin'), async (req, res) => {
  const schema = Joi.object({
    requestId:  Joi.string().uuid().required(),
    posDocNo:   Joi.string().min(1).required(),
    posDocDate: Joi.string().isoDate().required(),
  });
  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const result = await inboundSvc.confirmInbound({
    ...req.body,
    confirmedBy: req.user.id,
  });
  res.status(result.success ? 200 : 422).json(result);
});

router.get('/inbound/summary/:requestId', authenticate, async (req, res) => {
  res.json(await inboundSvc.getReceiptSummary(req.params.requestId));
});

// ─── POS ──────────────────────────────────────────────────────────────────────
router.post('/pos/sync/:posDocId', authenticate, authorize('admin'), async (req, res) => {
  res.json(await posSvc.syncToPOS(req.params.posDocId));
});

router.get('/pos/export/:requestId', authenticate, authorize('admin', 'receiver'), async (req, res) => {
  res.json(await posSvc.exportToJson(req.params.requestId));
});

router.post('/auth/change-password', authenticate, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสผ่านเดิมและใหม่' });
  }
  const { rows: [user] } = await db.query(
    'SELECT * FROM users WHERE id = $1', [req.user.id]
  );
  const ok = await require('bcryptjs').compare(oldPassword, user.password);
  if (!ok) return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });

  const hash = await require('bcryptjs').hash(newPassword, 10);
  await db.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
});

module.exports = router;
