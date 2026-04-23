import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.js';
import { setupWebSocket } from './ws/handler.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '5001', 10);

const server = http.createServer();
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const app = createApp(io);
server.on('request', app);

setupWebSocket(io);

server.listen(PORT, () => {
  logger.info({ port: PORT }, '🏝️  Liliput API listening');
});
