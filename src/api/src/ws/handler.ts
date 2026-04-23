import type { Server as SocketServer } from 'socket.io';
import { logger } from '../logger.js';

export function setupWebSocket(io: SocketServer): void {
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    socket.on('subscribe:task', (taskId: string) => {
      socket.join(`task:${taskId}`);
      logger.debug({ socketId: socket.id, taskId }, 'Subscribed to task');
    });

    socket.on('unsubscribe:task', (taskId: string) => {
      socket.leave(`task:${taskId}`);
      logger.debug({ socketId: socket.id, taskId }, 'Unsubscribed from task');
    });

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Client disconnected');
    });
  });
}
