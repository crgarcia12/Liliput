// Liliput Shared Types — used by both API and Web

// ─── Workstream (groups Tasks for a repo) ─────────────────────

export interface Workstream {
  id: string;
  repository: string;          // Owner/repo this workstream belongs to
  name: string;                // Short label (e.g. "auth", "billing")
  description?: string;
  /** GitHub label applied to every issue/PR that belongs to this workstream
   *  on the target repo (e.g. `workstream:billing`). Set by the PM flow once
   *  the label has been ensured on GitHub. */
  githubLabel?: string;
  /** Issue number of the optional umbrella/tracker issue that groups all
   *  Feature issues for this workstream. Empty until PR-7 wires it. */
  trackerIssueNumber?: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Feature (a slice of a Workstream's spec) ──────────────────
// A Workstream may decompose into multiple Features. Each Feature owns its
// own spec file, branch, dev namespace, and one or more Tasks. The integration
// Feature exists per Workstream and orchestrates merging across siblings.

export type FeatureStatus =
  | 'pending'      // Decomposed, no task spawned yet
  | 'scaffolding'  // Sequential dep/route stub task in flight
  | 'in-progress'  // Task running the mega-prompt loop
  | 'integrating'  // Integration agent is merging
  | 'done'
  | 'failed';

export type FeatureKind = 'feature' | 'integration';

export interface Feature {
  id: string;
  workstreamId: string;
  name: string;                // Human label (e.g. "User Login")
  slug: string;                // Stable ID (e.g. "01-user-login")
  kind: FeatureKind;
  status: FeatureStatus;
  description?: string;
  branch?: string;             // e.g. feat/01-user-login
  namespace?: string;          // dev namespace
  specPath?: string;           // e.g. specs/features/01-user-login.feature.md
  position: number;            // Display order
  dependsOn?: string[];        // Feature IDs that must complete first
  /** GitHub issue number created by the PM flow for this Feature on the
   *  target repo. Empty until the PM flow runs. The webhook receiver looks
   *  up Features by this column when an issue/PR event fires. */
  githubIssueNumber?: number;
  /** Full html_url of the GitHub issue — handy for activity messages. */
  githubIssueUrl?: string;
  /** PR number opened against this Feature's branch (set when dev opens the
   *  PR; used by RM to find the feature on `pull_request.*` events). */
  githubPrNumber?: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Task (Feature Request) ───────────────────────────────────

export type TaskStatus =
  | 'clarifying'
  | 'specifying'
  | 'building'
  | 'deploying'
  | 'review'        // Built + deployed to dev env, awaiting user ship/discard
  | 'shipping'      // PR being opened or direct push in flight
  | 'completed'
  | 'discarded'
  | 'failed'
  | 'deleting';     // Hidden from UI; external state being torn down (sweeper retries)

export type CommitMode = 'pr' | 'direct';

/**
 * Lifecycle state for a per-task dev environment (k8s namespace + deployment + nginx route).
 *  - `active`  — deployment + service running, nginx route live, public URL serves the app.
 *  - `stopped` — deployment + service deleted, nginx route removed; namespace + image kept
 *                so a quick `start` redeploys without rebuilding.
 *  - `deleted` — namespace fully torn down; metadata (namespace name, path, port, image)
 *                preserved on the Task so it can be resurrected from cache.
 *
 * Tasks created before this field existed are treated as `active`.
 */
export type DevEnvState = 'active' | 'stopped' | 'deleted';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  workstreamId?: string;      // Parent workstream (auto-assigned if missing)
  featureId?: string;         // Parent feature (set when fan-out spawns this task)
  spec?: string;              // Generated specification markdown
  repository?: string;        // Target GitHub repo (e.g. "owner/repo") — what the agent edits
  baseBranch?: string;        // Branch to fork from (default "main")
  branch?: string;            // Working branch the agent commits to
  commitMode?: CommitMode;    // 'pr' (default) or 'direct'
  pullRequestUrl?: string;    // Created PR URL (commitMode='pr') or direct commit URL
  pullRequestNumber?: number; // PR number (set together with pullRequestUrl)
  commitSha?: string;         // SHA of the agent's last commit
  imageRef?: string;          // ACR image reference built for the dev env
  devNamespace?: string;      // K8s namespace hosting the dev env
  devUrl?: string;            // Public URL where the dev env is reachable
  devPort?: number;           // Container port the dev env app listens on (needed to restart from `stopped`/`deleted`)
  devEnvState?: DevEnvState;  // Lifecycle state of the dev env. Missing = legacy task = treated as 'active'.
  errorMessage?: string;      // Populated when status='failed'
  model?: string;             // Copilot SDK model id to use for agent turns (e.g. "gpt-5", "claude-sonnet-4.5"). Falls back to server default when missing.
  reasoningEffort?: ReasoningEffort;  // Optional reasoning-effort hint for the SDK. When undefined, the server auto-derives from the model id (e.g. `*-xhigh` -> 'xhigh') so models that only accept one effort (like claude-opus-4.7-xhigh) work out of the box.
  agents: Agent[];
  chatHistory: ChatMessage[];
  activityHistory?: ActivityEntry[];
  /** Conversation turns. Each user chat input opens a turn; agents/activity spawned
   *  by it inherit `turnId`. The most recent open turn (no `completedAt`) is the
   *  "current" turn that newly-spawned agents attach to. */
  turns?: Turn[];
  /** ID of the currently-open turn, if any. Convenience field hydrated by the store. */
  currentTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A "Turn" groups everything that happened in response to a single user input.
 *
 *  Hierarchy: Repo → Workstream → Task → Turn → Agents.
 *
 *  A turn is opened when the task is created (the original description acts as
 *  the first user message) and on every subsequent `gulliver` chat message.
 *  When the next user message arrives or the task moves to a terminal status,
 *  the previous turn is closed (gets a `completedAt`).
 *
 *  Token usage is captured by listening to the SDK's `assistant.usage` event in
 *  `agent-loop.ts` and aggregating onto the agent's owning turn. */
export interface Turn {
  id: string;
  taskId: string;
  /** 1-based ordinal within the task — useful for display ("Turn 3"). */
  index: number;
  /** First-pass human-readable title; today truncated user message, later LLM-generated. */
  title: string;
  /** The full user message that opened this turn. */
  userMessage: string;
  /** Snapshot of `task.model` at the time the turn was opened. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  status: 'open' | 'completed';
  startedAt: string;
  completedAt?: string;
  /** Wall-clock duration. Set when the turn is closed; undefined while open. */
  durationMs?: number;
  /** Aggregated token usage across all agents+SDK calls of this turn. */
  usage: TurnUsage;
  /** IDs of agents spawned during this turn — for quick scoping in the UI. */
  agentIds: string[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of (input+output+cacheRead+cacheWrite) — handy single-number display. */
  totalTokens: number;
  /** Total Copilot "nano-AIU" cost when the SDK reports it. */
  nanoAiu?: number;
  /** Number of LLM API calls aggregated into this turn (one per `assistant.usage` event). */
  callCount: number;
}

/** A single event in the persistent activity feed for a task. Surfaced in the
 *  Live Activity panel so the user can see what happened even after a page
 *  reload or pod restart. Mirrors the live socket events one-to-one. */
export interface ActivityEntry {
  id: string;
  taskId: string;
  /** Owning turn — set when the entry was created. Older rows may be undefined. */
  turnId?: string;
  timestamp: string;
  kind:
    | 'agent-spawned'
    | 'agent-status'
    | 'agent-log'
    | 'agent-completed'
    | 'agent-failed'
    | 'task-status'
    | 'task-spec';
  agentId?: string;
  agentName?: string;
  level?: 'info' | 'warn' | 'error';
  message: string;
  command?: string;
  output?: string;
}

// ─── Agent (Liliputian Worker) ────────────────────────────────

export type AgentRole =
  | 'architect'     // Plans the work, breaks into subtasks
  | 'coder'         // Writes code
  | 'reviewer'      // Reviews PRs
  | 'builder'       // Runs builds/CI
  | 'deployer'      // Deploys to AKS
  | 'tester'        // Runs tests
  | 'researcher'    // Looks up docs, patterns
  | 'fixer';        // Investigates failures and edits files to make scripted ops succeed

export type AgentStatus = 'idle' | 'working' | 'completed' | 'failed' | 'waiting';

export interface Agent {
  id: string;
  taskId: string;
  /** Owning turn (the user message that triggered this agent). Undefined for legacy rows. */
  turnId?: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  currentAction?: string;     // What the agent is doing right now
  logs: AgentLogEntry[];
  progress: number;           // 0-100
  createdAt: string;
  updatedAt: string;
  /** Set when the agent transitions to `working` for the current run. Cleared on completion. */
  startedAt?: string;
  /** Cumulative count of tool invocations during the current run — used as a liveness signal. */
  toolCallCount?: number;
  /** Most recent useful action label — mirrors `currentAction` but is preserved across heartbeat noise. */
  lastUsefulAction?: string;
  /** Reason the run ended (e.g. "interrupted by API restart"). */
  errorMessage?: string;
}

// ─── Agent Events (WebSocket) ─────────────────────────────────

/**
 * High-level activity event emitted by the SDK during a session.
 * Surfaced to the UI so the user can watch the agent work in real time.
 */
export interface AgentToolEvent {
  taskId: string;
  agentId: string;
  /** Monotonic id within an agent session, used to correlate start/complete events. */
  callId: string;
  kind:
    | 'tool-start'        // Agent invoked a tool (read, write, bash, grep, glob, edit…)
    | 'tool-complete'     // Tool finished
    | 'tool-progress'     // Long-running tool emitted a progress update
    | 'skill-invoked'     // A skill from .github/skills/ kicked in
    | 'subagent-start'    // A custom sub-agent (tester, reviewer…) was spawned
    | 'subagent-complete'
    | 'reasoning'         // Model "thinking" content
    | 'message';          // Final assistant message
  tool?: string;          // Tool / skill / sub-agent name
  /** Short one-line summary suitable for the activity log. */
  summary: string;
  /** Optional structured details (truncated stdout, file path, etc). */
  details?: string;
  timestamp: string;
}

export type AgentEventType =
  | 'agent:spawned'
  | 'agent:status'
  | 'agent:log'
  | 'agent:progress'
  | 'agent:completed'
  | 'agent:failed'
  | 'task:status'
  | 'task:spec'
  | 'turn:opened'
  | 'turn:updated'
  | 'turn:closed'
  | 'chat:message';

export interface AgentEvent {
  type: AgentEventType;
  taskId: string;
  agentId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface AgentLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  command?: string;
  output?: string;
}

// ─── Chat Messages ────────────────────────────────────────────

export type ChatRole = 'gulliver' | 'liliput' | 'agent' | 'system';

export interface ChatMessage {
  id: string;
  taskId: string;
  /** Owning turn. For `gulliver` messages this is the turn they themselves open. */
  turnId?: string;
  role: ChatRole;
  agentId?: string;
  agentName?: string;
  content: string;
  timestamp: string;
}

// ─── API Request/Response Types ───────────────────────────────

export interface CreateTaskRequest {
  title: string;
  description: string;
  repository?: string;
  baseBranch?: string;
  commitMode?: CommitMode;
  workstreamId?: string;       // Optional explicit parent; auto-assigned otherwise
  model?: string;              // Optional Copilot SDK model id (e.g. "gpt-5"). Server falls back to default when missing.
  reasoningEffort?: ReasoningEffort;  // Optional reasoning-effort hint. Auto-derived from model id when missing.
}

/** Curated list of Copilot SDK model ids surfaced in the new-task UI.
 *  Update this when GitHub Copilot exposes new models. The first entry is
 *  the default. Server-side `COPILOT_MODEL` env var still overrides for
 *  tasks that don't explicitly specify one.
 */
export interface ModelOption {
  id: string;          // SDK model id (passed to client.createSession)
  label: string;       // Human-readable label for the picker
  family: 'gpt' | 'claude' | 'gemini' | 'other';
  note?: string;       // Optional hint shown in the dropdown
}

/** Static fallback list. The live list comes from `client.listModels()` —
 *  see `src/api/src/engine/copilot-client.ts#listAvailableModels`. This
 *  array is only used when the SDK call fails (no auth, offline, etc).
 *  Keep ids here strictly to ones the Copilot SDK actually accepts. */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5',     family: 'claude', note: 'default fallback' },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6',     family: 'claude' },
  { id: 'claude-haiku-4.5',  label: 'Claude Haiku 4.5',      family: 'claude', note: 'fast / cheap' },
  { id: 'gpt-5-mini',        label: 'GPT-5 mini',            family: 'gpt',    note: 'fast / cheap' },
  { id: 'gpt-4.1',           label: 'GPT-4.1',               family: 'gpt' },
];

export const DEFAULT_MODEL_ID = 'claude-sonnet-4.5';

/** Reasoning-effort hint passed to the Copilot SDK. Some models REQUIRE a
 *  specific value (e.g. `claude-opus-4.7-xhigh` only accepts `'xhigh'`); for
 *  those, the server auto-derives from the model id suffix. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Auto-derive the reasoning effort that a model id implies. Models that
 *  encode an effort in the suffix (e.g. `claude-opus-4.7-xhigh`) only accept
 *  THAT effort; using anything else throws a 400 from the SDK. Returns
 *  `undefined` when the model id implies nothing — caller should pass the
 *  user's explicit choice (or omit, letting the SDK pick its own default). */
export function deriveReasoningEffort(modelId: string | undefined): ReasoningEffort | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  if (lower.endsWith('-xhigh')) return 'xhigh';
  if (lower.endsWith('-high')) return 'high';
  if (lower.endsWith('-low')) return 'low';
  if (lower.endsWith('-mini')) return 'medium';
  return undefined;
}

/** Resolve the EFFECTIVE reasoning effort to send to the SDK, given a model
 *  id and the user's explicit preference. Models with a fixed effort baked
 *  into their id (e.g. `*-xhigh`) ALWAYS win over user input — sending any
 *  other value to those models triggers a 400. Otherwise the user choice is
 *  honored (or undefined → SDK default). */
export function effectiveReasoningEffort(
  modelId: string | undefined,
  userChoice: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  const fixed = deriveReasoningEffort(modelId);
  return fixed ?? userChoice;
}

export interface ModelsResponse {
  options: readonly ModelOption[];
  default: string;
}

export interface CreateWorkstreamRequest {
  repository: string;
  name: string;
  description?: string;
}

export interface WorkstreamListResponse {
  workstreams: Workstream[];
}

/** Summary of what a hard-delete will tear down. Returned by preview endpoints. */
export interface DeletePreview {
  scope: 'task' | 'workstream' | 'repo';
  label: string;                // Human-friendly heading
  taskCount: number;
  branches: { repository: string; branch: string }[];
  pullRequests: { repository: string; number: number; url?: string }[];
  namespaces: string[];
  workstreams: { id: string; name: string }[];
  tasks: { id: string; title: string; status: TaskStatus }[];
}

export interface ShipTaskRequest {
  /** Optional override — defaults to the task's commitMode. */
  commitMode?: CommitMode;
}

export interface ChatRequest {
  message: string;
}

export interface TaskListResponse {
  tasks: Task[];
}

export interface TaskDetailResponse {
  task: Task;
}

// ─── Auth Status (Copilot SDK health) ─────────────────────────

export type AuthErrorKind =
  | 'missing_token'
  | 'unauthorized'
  | 'forbidden'
  | 'quota'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface AuthStatus {
  /** true = healthy; false = failing; null = not yet probed. */
  ok: boolean | null;
  lastCheckedAt: string | null;
  errorKind?: AuthErrorKind;
  message?: string;
  hasToken: boolean;
}

// ─── Token & duration rollups ────────────────────────────────

/** Aggregate usage across all turns of a workstream or repo. */
export interface UsageRollup {
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  nanoAiu?: number;
}

export interface WorkstreamUsageResponse extends UsageRollup {
  workstreamId: string;
}

export interface RepoUsageResponse extends UsageRollup {
  repository: string;
}
