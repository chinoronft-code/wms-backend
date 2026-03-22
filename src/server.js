require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const routes          = require('./routes');
const notification    = require('./services/notification/notificationService');

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
notification.init(io);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Static label files
app.use('/labels', express.static(path.join(process.cwd(), 'labels')));

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
}));

// Tighter limit on scan endpoint (prevent spam)
app.use('/api/packing/scan', rateLimit({
  windowMs: 1000,
  max: 5,
  message: { error: 'Scan rate limit exceeded' },
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', routes);

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'WMS Backend',
  time: new Date().toISOString(),
}));

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WMS Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Mode:   ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = { app, server };
