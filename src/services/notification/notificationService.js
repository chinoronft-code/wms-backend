/**
 * Notification Service
 * - Wrap Socket.io emit
 * - Packer join ห้อง request_id ของตัวเอง
 * - Events: packing:scan, packing:box_full, inbound:received
 */

let _io = null;

const init = (io) => {
  _io = io;

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Client ส่ง { requestId } เพื่อ subscribe ห้อง
    socket.on('join:request', ({ requestId }) => {
      if (requestId) {
        socket.join(`request:${requestId}`);
        console.log(`[Socket] ${socket.id} joined request:${requestId}`);
      }
    });

    socket.on('leave:request', ({ requestId }) => {
      socket.leave(`request:${requestId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });
};

// Emit event ไปยัง clients ที่ join ห้อง request_id นั้น
const emitToRequest = async (requestId, event, data) => {
  if (!_io) return;
  _io.to(`request:${requestId}`).emit(event, data);
};

// Emit ไปยัง user คนเดียว (ใช้ userId เป็น room)
const emitToUser = async (userId, event, data) => {
  if (!_io) return;
  _io.to(`user:${userId}`).emit(event, data);
};

module.exports = { init, emitToRequest, emitToUser };
