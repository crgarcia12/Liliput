/**
 * SQLite connection + schema setup.
 *
 * One process, one DB. Path is configurable via DB_PATH:
 *   - production / k8s:  /data/liliput.db   (Azure Disk PVC)
 *   - local dev:         ./liliput.db
 *   - tests:             :memory:
 *
 * better-sqlite3 is fully synchronous, which is fine for our workload
 * (single-process, modest write rate). WAL mode keeps reads concurrent
 * with writes.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

let _db: Database.Database | null = null;

/** Resolve DB path, creating parent dir if needed. */
function resolveDbPath(): string {
  const raw = process.env['DB_PATH'] ?? './liliput.db';
  if (raw === ':memory:') return raw;
  const abs = path.resolve(raw);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return abs;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  repository  TEXT,
  status      TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_repository ON tasks(repository);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  data      TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agents_task_id ON agents(task_id, position);

CREATE TABLE IF NOT EXISTS agent_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  TEXT NOT NULL,
  ts        TEXT NOT NULL,
  level     TEXT NOT NULL,
  message   TEXT NOT NULL,
  command   TEXT,
  output    TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs(agent_id, id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  ts        TEXT NOT NULL,
  data      TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_task ON chat_messages(task_id, ts);
`;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.exec(SCHEMA);
  logger.info({ dbPath }, '🗄️  SQLite store initialised');
  return _db;
}

/** Test-only: drop everything and re-init schema. */
export function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM agent_logs;
    DELETE FROM agents;
    DELETE FROM chat_messages;
    DELETE FROM tasks;
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
