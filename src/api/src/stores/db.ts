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
import { seedDefaultPricing } from './pricing-seed.js';
import { backfillUsageCalls } from './usage-backfill.js';

let _db: Database.Database | null = null;

/** Read BCRYPT_ROUNDS from env, defaulting to 12. Honoured by the default
 *  admin seeder so tests can speed up bcrypt without changing production. */
function bcryptRounds(): number {
  const raw = process.env['BCRYPT_ROUNDS'];
  if (!raw) return 12;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 4 ? parsed : 12;
}

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
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'USER',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS workstreams (
  id          TEXT PRIMARY KEY,
  repository  TEXT NOT NULL,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workstreams_repository ON workstreams(repository);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  repository    TEXT,
  workstream_id TEXT,
  status        TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (workstream_id) REFERENCES workstreams(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_repository ON tasks(repository);
-- idx_tasks_workstream is created in the migration block in getDb() after
-- ensuring the workstream_id column exists on legacy databases.
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

CREATE TABLE IF NOT EXISTS activity_entries (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  ts        TEXT NOT NULL,
  data      TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_entries(task_id, ts);

-- Tool wishes: agents emit "TOOL-WISH: <tool> - <reason>" lines in their chat
-- when they wish a CLI was available in the runtime image. We capture them so
-- the operator can review and bake popular requests into the next image.
CREATE TABLE IF NOT EXISTS tool_wishes (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  agent_id  TEXT,
  ts        TEXT NOT NULL,
  tool      TEXT NOT NULL,
  reason    TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_wishes_tool ON tool_wishes(tool);
CREATE INDEX IF NOT EXISTS idx_tool_wishes_ts ON tool_wishes(ts);

CREATE TABLE IF NOT EXISTS features (
  id             TEXT PRIMARY KEY,
  workstream_id  TEXT NOT NULL,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,
  status         TEXT NOT NULL,
  branch         TEXT,
  namespace      TEXT,
  spec_path      TEXT,
  data           TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_features_workstream ON features(workstream_id);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);

CREATE TABLE IF NOT EXISTS agent_verdicts (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  agent_id  TEXT,
  ts        TEXT NOT NULL,
  status    TEXT NOT NULL,  -- 'done' | 'blocked' | 'continue'
  reason    TEXT,
  raw       TEXT,           -- the matched line as the agent emitted it
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_verdicts_task ON agent_verdicts(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_verdicts_status ON agent_verdicts(status);
CREATE INDEX IF NOT EXISTS idx_agent_verdicts_ts ON agent_verdicts(ts);

-- Turns: each user chat input opens one. Agents/activity entries inherit
-- turn_id so the UI can group them. Token + duration rollups happen on
-- this table; workstream/repo aggregates are SUMs across rows here.
CREATE TABLE IF NOT EXISTS turns (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  position        INTEGER NOT NULL,
  status          TEXT NOT NULL, -- 'open' | 'completed'
  title           TEXT NOT NULL,
  user_message    TEXT NOT NULL,
  model           TEXT,
  reasoning_effort TEXT,
  reviewer_model  TEXT,
  reviewer_reasoning_effort TEXT,
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  duration_ms     INTEGER,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  nano_aiu        REAL,
  call_count      INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id, position);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);

-- Per-LLM-call usage rows. One row per SDK assistant.usage event.
-- The turns row is still updated as a running aggregate for cheap display,
-- but this table is the source of truth for cost computation because:
--   1. Prices change over time (rows are matched by occurred_at)
--   2. One turn can mix multiple models (coder + ops-fixer + reviewer)
CREATE TABLE IF NOT EXISTS turn_usage_call (
  id                  TEXT PRIMARY KEY,
  turn_id             TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  agent_id            TEXT,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  nano_aiu            REAL,
  duration_ms         INTEGER,
  occurred_at         TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_turn_usage_call_turn ON turn_usage_call(turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_usage_call_task ON turn_usage_call(task_id);
CREATE INDEX IF NOT EXISTS idx_turn_usage_call_model_ts ON turn_usage_call(model, occurred_at);

-- Per-model price book. Prices are per 1,000,000 tokens (matches GitHub's
-- published units at docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
-- Multiple rows per model: the row with the largest effective_from <= occurred_at
-- (and min_input_tokens <= callInputTokens) wins. tier is free-form display
-- (default, long_context); the threshold is enforced by min_input_tokens.
CREATE TABLE IF NOT EXISTS model_pricing (
  id                       TEXT PRIMARY KEY,
  model                    TEXT NOT NULL,
  tier                     TEXT NOT NULL DEFAULT 'default',
  min_input_tokens         INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'USD',
  input_per_mtok           REAL NOT NULL,
  cached_input_per_mtok    REAL,
  cache_write_per_mtok     REAL,
  output_per_mtok          REAL NOT NULL,
  effective_from           TEXT NOT NULL,
  source                   TEXT,
  notes                    TEXT,
  created_at               TEXT NOT NULL,
  UNIQUE(model, tier, min_input_tokens, effective_from, currency)
);
CREATE INDEX IF NOT EXISTS idx_model_pricing_lookup
  ON model_pricing(model, effective_from, min_input_tokens);

-- Per-user agent model defaults. One row per (user_id, agent_role). NULL
-- columns mean "fall through to env / server default" for that field.
-- Resolution order at turn-open is: task pin -> this table -> env -> server
-- constant. Rows are read live, so changing the profile takes effect on the
-- next turn (existing snapshots in the turns table are unaffected -- they
-- capture the resolved values at the time the turn opened).
CREATE TABLE IF NOT EXISTS user_agent_defaults (
  user_id          TEXT NOT NULL,
  agent_role       TEXT NOT NULL,        -- 'rewriter' | 'architect' | 'critic' | 'coder' | 'reviewer'
  model            TEXT,                 -- NULL = use env / server default
  reasoning_effort TEXT,                 -- NULL = auto-derive from model id
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_role),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_agent_defaults_user ON user_agent_defaults(user_id);

CREATE TABLE IF NOT EXISTS autonomous_campaigns (
  id                             TEXT PRIMARY KEY,
  repository                     TEXT NOT NULL,
  base_branch                    TEXT NOT NULL,
  status                         TEXT NOT NULL,
  release_policy                 TEXT NOT NULL,
  idea_sources_json              TEXT NOT NULL,
  model_config_json              TEXT NOT NULL,
  max_turns_per_attempt          INTEGER NOT NULL,
  max_minutes_per_attempt        INTEGER NOT NULL,
  max_cost_usd_per_attempt       REAL NOT NULL,
  retry_backoff_cap_minutes      INTEGER NOT NULL,
  success_cooldown_minutes       INTEGER NOT NULL,
  failed_attempt_alert_threshold INTEGER NOT NULL,
  cumulative_cost_alert_usd      REAL NOT NULL,
  cumulative_cost_usd            REAL NOT NULL DEFAULT 0,
  next_sequence                  INTEGER NOT NULL DEFAULT 1,
  current_cycle_id               TEXT,
  lease_owner                    TEXT,
  lease_expires_at               INTEGER,
  pause_requested_at             TEXT,
  stop_requested_at              TEXT,
  created_by                     TEXT NOT NULL,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomous_campaigns_active_target
  ON autonomous_campaigns(repository, base_branch)
  WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_autonomous_campaigns_status
  ON autonomous_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_autonomous_campaigns_lease
  ON autonomous_campaigns(lease_expires_at);

CREATE TABLE IF NOT EXISTS autonomous_cycles (
  id                    TEXT PRIMARY KEY,
  campaign_id           TEXT NOT NULL,
  sequence              INTEGER NOT NULL,
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL,
  proposal_json         TEXT,
  proposal_fingerprint  TEXT,
  base_sha              TEXT,
  evidence_snapshot_json TEXT,
  workstream_id         TEXT,
  task_id               TEXT,
  branch_name           TEXT,
  pull_request_url      TEXT,
  review_decision_json  TEXT,
  release_gates_json    TEXT,
  merge_sha             TEXT,
  next_retry_at         TEXT,
  retry_delay_minutes   INTEGER,
  started_at            TEXT NOT NULL,
  completed_at          TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(campaign_id, sequence),
  FOREIGN KEY (campaign_id) REFERENCES autonomous_campaigns(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomous_cycles_one_active
  ON autonomous_cycles(campaign_id)
  WHERE status NOT IN ('succeeded', 'stopped');
CREATE INDEX IF NOT EXISTS idx_autonomous_cycles_status
  ON autonomous_cycles(status);

CREATE TABLE IF NOT EXISTS autonomous_attempts (
  id                  TEXT PRIMARY KEY,
  cycle_id            TEXT NOT NULL,
  attempt_number      INTEGER NOT NULL,
  status              TEXT NOT NULL,
  turns_used          INTEGER NOT NULL DEFAULT 0,
  elapsed_ms          INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd  REAL NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  completed_at        TEXT,
  failure_stage       TEXT,
  failure_message     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(cycle_id, attempt_number),
  FOREIGN KEY (cycle_id) REFERENCES autonomous_cycles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_autonomous_attempts_cycle
  ON autonomous_attempts(cycle_id, attempt_number);

CREATE TABLE IF NOT EXISTS autonomous_attempt_idempotency (
  idempotency_key  TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES autonomous_attempts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS autonomous_campaign_transitions (
  idempotency_key  TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL,
  expected_status  TEXT NOT NULL,
  next_status      TEXT NOT NULL,
  applied          INTEGER NOT NULL,
  result_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES autonomous_campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS autonomous_attempt_usage_events (
  attempt_id          TEXT NOT NULL,
  usage_event_id      TEXT NOT NULL,
  turns               INTEGER NOT NULL,
  estimated_cost_usd  REAL NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (attempt_id, usage_event_id),
  FOREIGN KEY (attempt_id) REFERENCES autonomous_attempts(id) ON DELETE CASCADE
);
`;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.exec(SCHEMA);
  // Lightweight forward migration: add workstream_id column to tasks if it
  // doesn't already exist (older databases predate the workstream concept).
  try {
    const cols = _db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'workstream_id')) {
      _db.exec(`ALTER TABLE tasks ADD COLUMN workstream_id TEXT`);
      logger.info({}, 'Migrated: added workstream_id column to tasks');
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks(workstream_id)`);
    if (!cols.some((c) => c.name === 'feature_id')) {
      _db.exec(`ALTER TABLE tasks ADD COLUMN feature_id TEXT`);
      logger.info({}, 'Migrated: added feature_id column to tasks');
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id)`);
    // Pod-ownership / lease columns. Forward-compat for multi-replica scale-out.
    // Today (single replica) the columns are written by reconcileOrphanedRuns +
    // autoResumeInterruptedTasks for telemetry only — no enforcement. Scale-out
    // would gate task claims on `lease_expires_at < now()` to prevent two pods
    // from racing on the same workspace.
    if (!cols.some((c) => c.name === 'owner_pod_id')) {
      _db.exec(`ALTER TABLE tasks ADD COLUMN owner_pod_id TEXT`);
      logger.info({}, 'Migrated: added owner_pod_id column to tasks');
    }
    if (!cols.some((c) => c.name === 'lease_expires_at')) {
      _db.exec(`ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER`);
      logger.info({}, 'Migrated: added lease_expires_at column to tasks');
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(lease_expires_at)`);

    // Turn entity: add turn_id columns to child tables so existing rows can be
    // backfilled, then synthesise one initial turn per task that doesn't have
    // any turns yet.
    const agentCols = _db
      .prepare(`PRAGMA table_info(agents)`)
      .all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === 'turn_id')) {
      _db.exec(`ALTER TABLE agents ADD COLUMN turn_id TEXT`);
      logger.info({}, 'Migrated: added turn_id column to agents');
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_turn ON agents(turn_id)`);

    const activityCols = _db
      .prepare(`PRAGMA table_info(activity_entries)`)
      .all() as Array<{ name: string }>;
    if (!activityCols.some((c) => c.name === 'turn_id')) {
      _db.exec(`ALTER TABLE activity_entries ADD COLUMN turn_id TEXT`);
      logger.info({}, 'Migrated: added turn_id column to activity_entries');
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_turn ON activity_entries(turn_id)`);

    const chatCols = _db
      .prepare(`PRAGMA table_info(chat_messages)`)
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === 'turn_id')) {
      _db.exec(`ALTER TABLE chat_messages ADD COLUMN turn_id TEXT`);
      logger.info({}, 'Migrated: added turn_id column to chat_messages');
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_turn ON chat_messages(turn_id)`);

    const turnCols = _db
      .prepare(`PRAGMA table_info(turns)`)
      .all() as Array<{ name: string }>;
    if (!turnCols.some((c) => c.name === 'reviewer_model')) {
      _db.exec(`ALTER TABLE turns ADD COLUMN reviewer_model TEXT`);
      logger.info({}, 'Migrated: added reviewer_model column to turns');
    }
    if (!turnCols.some((c) => c.name === 'reviewer_reasoning_effort')) {
      _db.exec(`ALTER TABLE turns ADD COLUMN reviewer_reasoning_effort TEXT`);
      logger.info({}, 'Migrated: added reviewer_reasoning_effort column to turns');
    }

    const cycleCols = _db
      .prepare(`PRAGMA table_info(autonomous_cycles)`)
      .all() as Array<{ name: string }>;
    if (!cycleCols.some((c) => c.name === 'evidence_snapshot_json')) {
      _db.exec(
        `ALTER TABLE autonomous_cycles ADD COLUMN evidence_snapshot_json TEXT`,
      );
      logger.info(
        {},
        'Migrated: added evidence_snapshot_json column to autonomous_cycles',
      );
    }

    // ─── PM / Dev / RM agent loop — issue + webhook tracking ───────────────
    //
    // Per-repo bootstrap state: tracks whether the Liliput overlay has been
    // installed on a target repo (labels created, webhook configured, etc).
    // Dev/RM agents only act on a repo whose state is 'ready'.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS target_repos (
        repository      TEXT PRIMARY KEY,
        bootstrap_state TEXT NOT NULL,           -- 'pending' | 'pending_setup_pr' | 'ready' | 'failed'
        webhook_status  TEXT NOT NULL DEFAULT 'unconfigured',
                                                  -- 'unconfigured' | 'active' | 'polling_fallback' | 'failed'
        webhook_id      INTEGER,                  -- GitHub webhook id, if created
        last_error      TEXT,
        last_poll_at    TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_target_repos_state ON target_repos(bootstrap_state);`);

    // Webhook delivery dedup: GitHub redelivers events; the X-GitHub-Delivery
    // header is a stable uuid per delivery. We persist every accepted delivery
    // so a redelivery is a no-op.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS github_deliveries (
        delivery_id   TEXT PRIMARY KEY,           -- X-GitHub-Delivery header
        event         TEXT NOT NULL,              -- X-GitHub-Event header
        action        TEXT,                       -- payload.action if present
        repository    TEXT,                       -- owner/repo
        received_at   TEXT NOT NULL,
        processed_at  TEXT,
        status        TEXT NOT NULL,              -- 'received' | 'processed' | 'skipped' | 'error'
        error         TEXT
      );
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_github_deliveries_repo ON github_deliveries(repository);`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_github_deliveries_received ON github_deliveries(received_at);`);

    // Idempotent action queue: every Dev pickup / RM review is claimed via a
    // row here so webhook + reconciler can't race. state_key is unique per
    // (repo, kind, target).
    _db.exec(`
      CREATE TABLE IF NOT EXISTS github_jobs (
        id              TEXT PRIMARY KEY,
        repository      TEXT NOT NULL,
        kind            TEXT NOT NULL,            -- 'dev-pickup' | 'rm-review'
        state_key       TEXT NOT NULL,            -- repo + kind + issue_or_pr_number
        issue_number    INTEGER,
        pr_number       INTEGER,
        status          TEXT NOT NULL,            -- 'queued' | 'running' | 'done' | 'failed'
        locked_by       TEXT,
        locked_until    INTEGER,
        last_error      TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE(state_key)
      );
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_github_jobs_repo_kind ON github_jobs(repository, kind, status);`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_github_jobs_locked ON github_jobs(locked_until);`);

    // Forward-compat columns on workstreams + features. Issue/PR identifiers
    // are kept as first-class columns so webhook lookups by (repo,number) are
    // an index hit, not a JSON-blob scan.
    const wsCols = _db
      .prepare(`PRAGMA table_info(workstreams)`)
      .all() as Array<{ name: string }>;
    if (!wsCols.some((c) => c.name === 'github_label')) {
      _db.exec(`ALTER TABLE workstreams ADD COLUMN github_label TEXT`);
      logger.info({}, 'Migrated: added github_label column to workstreams');
    }
    if (!wsCols.some((c) => c.name === 'tracker_issue_number')) {
      _db.exec(`ALTER TABLE workstreams ADD COLUMN tracker_issue_number INTEGER`);
      logger.info({}, 'Migrated: added tracker_issue_number column to workstreams');
    }

    const featureCols = _db
      .prepare(`PRAGMA table_info(features)`)
      .all() as Array<{ name: string }>;
    if (!featureCols.some((c) => c.name === 'github_issue_number')) {
      _db.exec(`ALTER TABLE features ADD COLUMN github_issue_number INTEGER`);
      logger.info({}, 'Migrated: added github_issue_number column to features');
    }
    if (!featureCols.some((c) => c.name === 'github_issue_url')) {
      _db.exec(`ALTER TABLE features ADD COLUMN github_issue_url TEXT`);
      logger.info({}, 'Migrated: added github_issue_url column to features');
    }
    if (!featureCols.some((c) => c.name === 'github_pr_number')) {
      _db.exec(`ALTER TABLE features ADD COLUMN github_pr_number INTEGER`);
      logger.info({}, 'Migrated: added github_pr_number column to features');
    }
    _db.exec(
      `CREATE INDEX IF NOT EXISTS idx_features_issue ON features(github_issue_number);`,
    );
    _db.exec(
      `CREATE INDEX IF NOT EXISTS idx_features_pr ON features(github_pr_number);`,
    );

    // Backfill: every task that has no turn yet gets one synthetic "Initial
    // turn" containing all its existing agents/activity/chat. This is run
    // every startup but is a no-op once each task has at least one turn.
    backfillInitialTurns(_db);

    // Backfill: every historical turn that has token aggregates but no
    // per-call rows in `turn_usage_call` gets one synthetic row, so the
    // cost rollup can price historical traffic. Idempotent on subsequent
    // boots (the WHERE clause filters out already-backfilled turns).
    try {
      backfillUsageCalls(_db);
    } catch (e) {
      logger.warn({ err: e }, 'turn_usage_call backfill failed (non-fatal)');
    }

    // Seed the default GitHub Copilot price book if rows are missing. The
    // seed is idempotent — re-runs only matter if SEED_ROWS itself changes.
    try {
      const seedResult = seedDefaultPricing();
      logger.info(seedResult, 'Seeded default model_pricing rows');
    } catch (e) {
      logger.warn({ err: e }, 'model_pricing seed failed (non-fatal)');
    }

    // Initialize default admin user if no users exist yet
    ensureDefaultAdminUser(_db);
  } catch (err) {
    logger.warn({ err }, 'Workstream migration check failed (non-fatal)');
  }
  logger.info({ dbPath }, '🗄️  SQLite store initialised');
  return _db;
}

/** Test-only: drop everything and re-init schema. */
export function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM autonomous_attempt_usage_events;
    DELETE FROM autonomous_attempt_idempotency;
    DELETE FROM autonomous_campaign_transitions;
    DELETE FROM autonomous_attempts;
    DELETE FROM autonomous_cycles;
    DELETE FROM autonomous_campaigns;
    DELETE FROM agent_logs;
    DELETE FROM agents;
    DELETE FROM chat_messages;
    DELETE FROM activity_entries;
    DELETE FROM tool_wishes;
    DELETE FROM agent_verdicts;
    DELETE FROM features;
    DELETE FROM turns;
    DELETE FROM tasks;
    DELETE FROM workstreams;
    DELETE FROM target_repos;
    DELETE FROM github_deliveries;
    DELETE FROM github_jobs;
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Backfill: synth a single "Initial turn" for any task that has no turns yet.
 *
 *  - userMessage = task.description (best-effort from the JSON `data` blob)
 *  - title       = task.title (truncated)
 *  - model       = task.model
 *  - status      = 'completed' if the task itself is in a terminal state; 'open' otherwise
 *  - completedAt = task.updatedAt for completed
 *
 *  All existing agents / activity_entries / chat_messages of that task get
 *  turn_id pointed at the new turn. This makes the UI immediately useful for
 *  pre-existing data without re-hydrating history into per-message turns. */
function backfillInitialTurns(db: Database.Database): void {
  type TaskRow = {
    id: string;
    status: string;
    data: string;
    created_at: string;
    updated_at: string;
  };
  const taskRows = db
    .prepare(
      `SELECT t.id, t.status, t.data, t.created_at, t.updated_at
         FROM tasks t
         LEFT JOIN turns tu ON tu.task_id = t.id
         WHERE tu.id IS NULL
         GROUP BY t.id`,
    )
    .all() as TaskRow[];

  if (taskRows.length === 0) return;

  const insertTurn = db.prepare(
    `INSERT INTO turns (
       id, task_id, position, status, title, user_message, model, reasoning_effort,
       started_at, completed_at, duration_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       nano_aiu, call_count
     ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, 0)`,
  );
  const setAgentTurn = db.prepare(
    `UPDATE agents SET turn_id = ? WHERE task_id = ? AND (turn_id IS NULL OR turn_id = '')`,
  );
  const setActivityTurn = db.prepare(
    `UPDATE activity_entries SET turn_id = ? WHERE task_id = ? AND (turn_id IS NULL OR turn_id = '')`,
  );
  const setChatTurn = db.prepare(
    `UPDATE chat_messages SET turn_id = ? WHERE task_id = ? AND (turn_id IS NULL OR turn_id = '')`,
  );

  // Lazy uuid import to avoid pulling it into hot path for fresh DBs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { v4: uuidV4 } = require('uuid') as { v4: () => string };

  const TERMINAL = new Set(['completed', 'failed', 'review', 'reviewing']);

  const txn = db.transaction((rows: TaskRow[]) => {
    for (const row of rows) {
      let title = 'Initial turn';
      let description = '';
      let model: string | null = null;
      let reasoningEffort: string | null = null;
      try {
        const parsed = JSON.parse(row.data) as {
          title?: string;
          description?: string;
          model?: string;
          reasoningEffort?: string;
        };
        if (parsed.title) title = parsed.title.slice(0, 80);
        description = parsed.description ?? '';
        model = parsed.model ?? null;
        reasoningEffort = parsed.reasoningEffort ?? null;
      } catch {
        // ignore malformed task data — synth a turn anyway
      }
      const turnId = uuidV4();
      const isTerminal = TERMINAL.has(row.status);
      const startedAt = row.created_at;
      const completedAt = isTerminal ? row.updated_at : null;
      let durationMs: number | null = null;
      if (completedAt) {
        const dur = new Date(completedAt).getTime() - new Date(startedAt).getTime();
        durationMs = Number.isFinite(dur) && dur > 0 ? dur : null;
      }
      insertTurn.run(
        turnId,
        row.id,
        isTerminal ? 'completed' : 'open',
        title,
        description.slice(0, 4000), // cap to keep size sane
        model,
        reasoningEffort,
        startedAt,
        completedAt,
        durationMs,
      );
      setAgentTurn.run(turnId, row.id);
      setActivityTurn.run(turnId, row.id);
      setChatTurn.run(turnId, row.id);
    }
  });

  txn(taskRows);
  logger.info({ count: taskRows.length }, 'Backfilled initial turns for legacy tasks');
}

/** Ensure default admin user exists if no users are present. */
function ensureDefaultAdminUser(db: Database.Database): void {
  try {
    // Check if any users exist
    const userCount = (
      db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }
    ).count;

    if (userCount > 0) {
      return; // Users already exist
    }

    // Import bcryptjs for hashing
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bcryptjs = require('bcryptjs') as {
      hashSync(password: string, rounds: number): string;
    };

    // Import uuid for ID generation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { v4: uuidV4 } = require('uuid') as { v4: () => string };

    // The default admin password is read from DEFAULT_ADMIN_PASSWORD. If not
    // set we generate a random one and log it once — the operator must capture
    // it from the logs and change it via the UI. We deliberately do NOT bake a
    // default password into source: the only canonical store for the password
    // is the bcrypt hash in the users table.
    let adminPassword = process.env['DEFAULT_ADMIN_PASSWORD'];
    let passwordSource: 'env' | 'generated' = 'env';
    if (!adminPassword || adminPassword.length < 8) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require('crypto') as typeof import('crypto');
      // 18 random bytes → 24 url-safe base64 chars. Plenty of entropy and
      // does not contain characters that get mangled by shells or YAML.
      adminPassword = crypto.randomBytes(18).toString('base64url');
      passwordSource = 'generated';
    }

    const passwordHash = bcryptjs.hashSync(adminPassword, bcryptRounds());
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(uuidV4(), 'admin', passwordHash, 'ADMIN', now, now);

    if (passwordSource === 'generated') {
      // Print the generated password to stdout exactly once so an operator
      // can capture it on first boot. Subsequent boots will not regenerate
      // it because the users table will no longer be empty.
      logger.warn(
        { username: 'admin', generatedPassword: adminPassword },
        '🔐 Default admin user created with generated password — change it via the UI immediately',
      );
    } else {
      logger.info('🔐 Default admin user initialized from DEFAULT_ADMIN_PASSWORD');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Failed to initialize default admin user (non-fatal)');
  }
}
