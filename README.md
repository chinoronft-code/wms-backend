# WMS Backend — Inbound/Outbound System

## Tech Stack
- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Database**: PostgreSQL 15+
- **Cache/Queue**: Redis 7+
- **Real-time**: Socket.io
- **Barcode/PDF**: qrcode + pdfkit
- **File Import**: xlsx (SheetJS)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# แก้ไข DB_HOST, DB_PASSWORD, JWT_SECRET ใน .env

# 3. Create database
psql -U postgres -c "CREATE USER wms_user WITH PASSWORD 'your_password';"
psql -U postgres -c "CREATE DATABASE wms_db OWNER wms_user;"
psql -U wms_user -d wms_db -f docs/schema.sql

# 4. Start development server
npm run dev

# 5. Run tests
npm test
```

## API Endpoints

### Auth
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | all | Login, get JWT token |

### Requests (จัดซื้อ)
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/requests/import` | admin | Import Excel/CSV (multipart `file`) |
| GET | `/api/requests` | admin | List all requests |
| GET | `/api/requests/:id` | admin,packer | Request detail |
| GET | `/api/requests/:id/my-sku` | packer | My assigned SKU list |
| GET | `/api/requests/:id/progress` | all | Packing progress per packer |

### Packing (แพ็คลัง)
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/packing/scan` | packer | Scan SKU barcode into box |
| GET | `/api/packing/boxes/:requestId` | all | List boxes |
| GET | `/api/packing/box/:boxId` | all | Box detail + SKU list |
| PATCH | `/api/packing/box/:boxId/close` | packer | Close box manually |
| POST | `/api/packing/box/:boxId/label` | packer | Generate + download PDF label |
| POST | `/api/packing/submit` | packer | Submit all boxes for receiving |

### Inbound (รับสินค้า)
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/inbound/scan` | receiver | Scan box QR → verify + receive |
| POST | `/api/inbound/confirm` | receiver | Confirm all received + POS doc no |
| GET | `/api/inbound/summary/:requestId` | all | Receipt summary per box |

### POS Integration
| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/pos/sync/:posDocId` | admin | Push to POS API |
| GET | `/api/pos/export/:requestId` | admin | Export JSON manifest |

## Socket.io Events

**Client → Server**
```js
socket.emit('join:request', { requestId })   // subscribe to request room
socket.emit('leave:request', { requestId })
```

**Server → Client**
```js
socket.on('packing:scan', { boxId, boxNo, skuCode, skuName, boxCount, boxStatus })
socket.on('inbound:received', { boxId, boxNo, status, discrepancies })
```

## File Structure
```
src/
├── config/
│   ├── database.js        PostgreSQL pool
│   └── redis.js           Redis client + key builders
├── middleware/
│   └── auth.js            JWT + role guard
├── services/
│   ├── request/           Import + assign SKU
│   ├── packing/           Scan + box management
│   ├── barcode/           QR + PDF label generation
│   ├── inbound/           Scan box + receive
│   ├── notification/      Socket.io wrapper
│   └── pos/               POS API integration
├── routes/
│   └── index.js           All routes
└── server.js              Express + Socket.io entry
docs/
└── schema.sql             PostgreSQL schema
tests/
└── services.test.js       Unit tests
```

## Business Rules
- **200 SKU per Packer** — configured via `SKU_PER_PACKER` env
- **20 SKU per Box max** — configured via `MAX_SKU_PER_BOX` env
- Boxes auto-create when current box is full
- Double-scan protection via Redis distributed lock (5s TTL)
- SKU can only be scanned by the assigned packer
