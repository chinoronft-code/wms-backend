const { createClient } = require("redis");

let client = null;

const getRedis = async () => {
  if (client && client.isReady) return client;

  client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
  });

  client.on("error", (err) => console.error("[Redis] Error:", err.message));
  client.on("ready", () => console.log("[Redis] Connected"));

  await client.connect();
  return client;
};

const keys = {
  packingSession: (userId) => `packing:session:${userId}`,
  activeBox:      (boxId)  => `packing:box:${boxId}:active`,
  scanLock:       (barcode) => `scan:lock:${barcode}`,
  requestProgress:(reqId)  => `request:progress:${reqId}`,
};

module.exports = { getRedis, keys };
