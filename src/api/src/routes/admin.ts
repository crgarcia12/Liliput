import { type Express } from 'express';
import { getAllUsers } from '../models/user-store.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

export function mapAdminEndpoints(app: Express): void {
  app.get('/api/admin/users', authMiddleware, requireRole('admin'), (_req, res) => {
    const users = getAllUsers().map(u => ({
      username: u.username,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
    }));
    res.status(200).json(users);
  });
}
