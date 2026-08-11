import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getDb } from '../stores/db.js';

export interface User {
  id: string;
  username: string;
  role: string;
}

export interface SessionToken {
  userId: string;
  username: string;
  role: string;
}

/** Get JWT secret from environment, or generate one for dev */
function getJwtSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (secret) return secret;

  // Dev-only: generate a random secret if not provided
  // In production, this should always be set via environment variable
  const generated = randomBytes(32).toString('hex');
  console.warn(
    'JWT_SECRET not set — using generated secret. This will change on restart!',
  );
  return generated;
}

const BCRYPT_ROUNDS = parseInt(process.env['BCRYPT_ROUNDS'] ?? '12', 10);
const JWT_SECRET = getJwtSecret();
const JWT_EXPIRY = '24h';

/** Hash a password using bcrypt */
export async function hashPassword(password: string): Promise<string> {
  return bcryptjs.hash(password, BCRYPT_ROUNDS);
}

/** Verify a password against its hash */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcryptjs.compare(password, hash);
}

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'user-not-found' | 'current-password-incorrect' | 'weak-password' };

/** Minimum acceptable length for a new password. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Change the password for a user.
 *
 * Verifies the supplied current password against the stored bcrypt hash,
 * then writes a fresh bcrypt hash for the new password. The plaintext
 * password is never persisted, never logged, and never returned.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'weak-password' };
  }

  const db = getDb();
  const row = db
    .prepare('SELECT id, password_hash FROM users WHERE id = ?')
    .get(userId) as { id: string; password_hash: string } | undefined;

  if (!row) {
    return { ok: false, reason: 'user-not-found' };
  }

  const currentValid = await verifyPassword(currentPassword, row.password_hash);
  if (!currentValid) {
    return { ok: false, reason: 'current-password-incorrect' };
  }

  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
  ).run(newHash, now, userId);

  return { ok: true };
}

/** Validate credentials against the database */
export async function validateCredentials(
  username: string,
  password: string,
): Promise<User | null> {
  try {
    const db = getDb();
    const user = db
      .prepare(
        'SELECT id, username, role, password_hash FROM users WHERE LOWER(username) = LOWER(?)',
      )
      .get(username) as
      | {
          id: string;
          username: string;
          role: string;
          password_hash: string;
        }
      | undefined;

    if (!user) return null;

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) return null;

    return {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  } catch (err) {
    console.error('Error validating credentials:', err);
    return null;
  }
}

/** Generate a JWT session token */
export function generateSessionToken(user: User): string {
  const payload: SessionToken = {
    userId: user.id,
    username: user.username,
    role: user.role,
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  });
}

/** Verify and decode a JWT session token */
export function verifySessionToken(token: string): SessionToken | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionToken;
    return decoded;
  } catch {
    return null;
  }
}
