import { type Express } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { getUserByUsername, addUser, getUserById, getUsers } from '../models/user-store.js';
import { authMiddleware } from '../middleware/auth.js';

const getSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
};
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,30}$/;

export function mapAuthEndpoints(app: Express): void {
  app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };

    // Validate username first
    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }
    if (!USERNAME_REGEX.test(username)) {
      res.status(400).json({ error: 'Username must be between 3 and 30 characters and contain only letters, numbers, and underscores' });
      return;
    }

    // Validate password
    if (!password) {
      res.status(400).json({ error: 'Password is required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Check uniqueness
    if (getUserByUsername(username)) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const role = getUsers().size === 0 ? 'admin' : 'user';

    const userId = crypto.randomUUID();
    addUser({
      id: userId,
      username,
      passwordHash,
      role,
      createdAt: new Date(),
    });

    const token = jwt.sign(
      { sub: userId, username, role },
      getSecret(),
      { expiresIn: '24h' },
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 86400 * 1000,
    });

    res.status(201).json({ message: 'Registration successful', role });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const user = getUserByUsername(username);
    if (!user) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      getSecret(),
      { expiresIn: '24h' },
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 86400 * 1000,
    });

    res.status(200).json({ message: 'Login successful' });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.cookie('token', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    });
    res.status(200).json({ message: 'Logged out successfully' });
  });

  app.get('/api/auth/me', authMiddleware, (req, res) => {
    const user = getUserById(req.user!.sub);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.status(200).json({
      username: user.username,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    });
  });
}
