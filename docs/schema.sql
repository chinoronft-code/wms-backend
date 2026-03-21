-- WMS Database Schema
-- Run: psql -U wms_user -d wms_db -f schema.sql

-- ─────────────────────────────────────────
-- Users & Roles
-- ─────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('admin', 'packer', 'receiver');

CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username    VARCHAR(50) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  full_name   VARCHAR(100) NOT NULL,
  role        user_role NOT NULL DEFAULT 'packer',
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- Purchase Request (from จัดซื้อ)
-- ─────────────────────────────────────────
CREATE TYPE request_status AS ENUM ('draft', 'assigned', 'packing', 'completed', 'cancelled');

CREATE TABLE purchase_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no        VARCHAR(30) UNIQUE NOT NULL,   -- e.g. REQ-2026-0321
  description   TEXT,
  total_sku     INT NOT NULL DEFAULT 0,
  status        request_status NOT NULL DEFAULT 'draft',
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- SKU Master (สินค้า 1,000 SKU ต่อรอบ)
-- ─────────────────────────────────────────
CREATE TABLE request_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  sku_code      VARCHAR(50) NOT NULL,
  sku_name      VARCHAR(200) NOT NULL,
  barcode       VARCHAR(100),
  quantity      INT NOT NULL DEFAULT 1,        -- จำนวนชิ้นที่สั่ง
  assigned_to   UUID REFERENCES users(id),     -- Packer ที่ได้รับมอบหมาย
  is_packed     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(request_id, sku_code)
);

CREATE INDEX idx_request_items_request ON request_items(request_id);
CREATE INDEX idx_request_items_packer  ON request_items(assigned_to);
CREATE INDEX idx_request_items_barcode ON request_items(barcode);

-- ─────────────────────────────────────────
-- Packing Boxes (ลัง)
-- ─────────────────────────────────────────
CREATE TYPE box_status AS ENUM ('open', 'full', 'label_printed', 'submitted', 'received');

CREATE TABLE packing_boxes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES purchase_requests(id),
  box_no          VARCHAR(30) NOT NULL,        -- e.g. BOX-001
  barcode_data    TEXT,                        -- JSON payload ฝังใน QR
  label_url       TEXT,                        -- URL ไฟล์ PDF Label
  status          box_status NOT NULL DEFAULT 'open',
  packed_by       UUID REFERENCES users(id),
  sku_count       INT NOT NULL DEFAULT 0,      -- จำนวน SKU ปัจจุบัน (max 20)
  submitted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(request_id, box_no)
);

CREATE INDEX idx_boxes_request ON packing_boxes(request_id);
CREATE INDEX idx_boxes_packer  ON packing_boxes(packed_by);

-- ─────────────────────────────────────────
-- Box Items — SKU ในแต่ละลัง
-- ─────────────────────────────────────────
CREATE TABLE box_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id          UUID NOT NULL REFERENCES packing_boxes(id) ON DELETE CASCADE,
  request_item_id UUID NOT NULL REFERENCES request_items(id),
  sku_code        VARCHAR(50) NOT NULL,
  sku_name        VARCHAR(200) NOT NULL,
  quantity_packed INT NOT NULL DEFAULT 1,
  scanned_at      TIMESTAMPTZ DEFAULT NOW(),
  scanned_by      UUID REFERENCES users(id),

  UNIQUE(box_id, request_item_id)
);

CREATE INDEX idx_box_items_box ON box_items(box_id);

-- ─────────────────────────────────────────
-- POS Documents
-- ─────────────────────────────────────────
CREATE TYPE pos_doc_status AS ENUM ('pending', 'synced', 'error');

CREATE TABLE pos_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES purchase_requests(id),
  pos_doc_no      VARCHAR(50) NOT NULL,        -- เลขที่เอกสาร POS เช่น GR-2026-03210001
  pos_doc_date    DATE NOT NULL,
  status          pos_doc_status DEFAULT 'pending',
  synced_at       TIMESTAMPTZ,
  error_message   TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- Inbound Receipts (การรับสินค้าเข้า)
-- ─────────────────────────────────────────
CREATE TYPE inbound_status AS ENUM ('pending', 'complete', 'shortage', 'overage', 'discrepancy');

CREATE TABLE inbound_receipts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_document_id UUID REFERENCES pos_documents(id),
  box_id          UUID NOT NULL REFERENCES packing_boxes(id),
  received_by     UUID REFERENCES users(id),
  status          inbound_status DEFAULT 'pending',
  notes           TEXT,
  received_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inbound_discrepancies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id      UUID NOT NULL REFERENCES inbound_receipts(id),
  sku_code        VARCHAR(50) NOT NULL,
  expected_qty    INT NOT NULL,
  actual_qty      INT NOT NULL,
  diff            INT GENERATED ALWAYS AS (actual_qty - expected_qty) STORED,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- Scan Audit Log
-- ─────────────────────────────────────────
CREATE TABLE scan_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id),
  action          VARCHAR(50) NOT NULL,        -- 'pack_scan', 'inbound_scan', 'label_print'
  reference_id    UUID,                        -- box_id หรือ receipt_id
  barcode         VARCHAR(200),
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scan_logs_user ON scan_logs(user_id);
CREATE INDEX idx_scan_logs_ref  ON scan_logs(reference_id);
CREATE INDEX idx_scan_logs_time ON scan_logs(created_at DESC);

-- ─────────────────────────────────────────
-- Trigger: auto-update updated_at
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_purchase_requests BEFORE UPDATE ON purchase_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_packing_boxes     BEFORE UPDATE ON packing_boxes     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
