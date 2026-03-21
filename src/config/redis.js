const { createClient } = require('redis');

let client = null;

const getRedis = async () => {
  if (client && client.isReady) return client;

  client = createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });

  client.on('error', (err) => console.error('[Redis] Error:', err.message));
  client.on('ready', () => console.log('[Redis] Connected'));

  await client.connect();
  return client;
};

// Key builders — centralised to avoid typos
const keys = {
  packingSession: (userId) => `packing:session:${userId}`,
  activeBox:      (boxId)  => `packing:box:${boxId}:active`,
  scanLock:       (barcode) => `scan:lock:${barcode}`,
  requestProgress:(reqId)  => `request:progress:${reqId}`,
};

module.exports = { getRedis, keys };
