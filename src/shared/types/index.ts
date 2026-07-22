// Liliput Shared Types — used by both API and Web

export * from './autonomous-campaign-state.js';
export * from './autonomous-campaign-pricing.js';
export * from './autonomous-campaign-controls.js';
export * from './autonomous-campaign-evidence.js';
export * from './autonomous-campaign-proposal.js';

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
  /** User who created the task. Used to resolve per-user agent-model defaults
   *  from `user_agent_defaults` when this task does not pin its own model.
   *  Undefined for legacy tasks (pre-multi-user) — those fall through to
   *  env / server defaults exactly as before. */
  ownerUserId?: string;
  spec?: string;              // Generated specification markdown
  repository?: string;        // Target GitHub repo (e.g. "owner/repo") — what the agent edits
  baseBranch?: string;        // Branch to fork from (default "main")
  branch?: string;            // Working branch the agent commits to
  commitMode?: CommitMode;    // 'pr' (default) or 'direct'
  pullRequestUrl?: string;    // Created PR URL (commitMode='pr') or direct commit URL
  pullRequestNumber?: number; // PR number (set together with pullRequestUrl)
  commitSha?: string;         // SHA of the agent's last commit
  baseCommitSha?: string;     // Branch point used to report the complete PR file set
  implementationNotes?: string[]; // Agent summaries of completed implementation rounds
  implementationChangedFiles?: string[]; // Cumulative files changed by the implementation
  imageRef?: string;          // ACR image reference built for the dev env
  devNamespace?: string;      // K8s namespace hosting the dev env
  devUrl?: string;            // Public URL where the dev env is reachable
  devPort?: number;           // Container port the dev env app listens on (needed to restart from `stopped`/`deleted`)
  devEnvState?: DevEnvState;  // Lifecycle state of the dev env. Missing = legacy task = treated as 'active'.
  errorMessage?: string;      // Populated when status='failed'
  model?: string;             // Copilot SDK model id to use for agent turns (e.g. "gpt-5", "claude-sonnet-4.5"). Falls back to server default when missing.
  reasoningEffort?: ReasoningEffort;  // Optional reasoning-effort hint for the SDK. When undefined, the server auto-derives from the model id (e.g. `*-xhigh` -> 'xhigh') so models that only accept one effort (like claude-opus-4.7-xhigh) work out of the box.
  /** Second Copilot SDK model used by the Reviewer Agent. The Reviewer
   *  watches the spec / coder / deploy phases and posts feedback to chat
   *  ONLY when it finds something important (bug, security issue, missed
   *  requirement, wrong approach). Silent otherwise. Falls back to the
   *  server-side `COPILOT_REVIEWER_MODEL` env or the same model as the
   *  coder when not set. */
  reviewerModel?: string;
  /** Reasoning-effort hint for the Reviewer Agent. Honors the same
   *  auto-derive rules as `reasoningEffort` (e.g. `*-xhigh` suffix). */
  reviewerReasoningEffort?: ReasoningEffort;
  /** When false, the Reviewer Agent is disabled for this task — no spec /
   *  coder / deploy review turns will be triggered. Defaults to false when
   *  no `reviewerModel` is set, true otherwise. */
  reviewerEnabled?: boolean;
  /** Per-SHA feedback queue. The reviewer appends entries here when it
   *  finds something important. The next coder turn picks up entries whose
   *  `sha` matches the current HEAD (or whose `sha` is null = not anchored
   *  to a commit, e.g. spec feedback). Consumed entries are removed. */
  pendingReviewerFeedback?: ReviewerFeedback[];
  /** Per-kind attempt counters used to break infinite reviewer/coder loops.
   *  Once a kind hits the cap (default 3), the reviewer's next feedback is
   *  shown to the user as unresolved instead of being auto-injected. */
  reviewerAttempts?: Partial<Record<ReviewerFeedbackKind, number>>;
  agents: Agent[];
  chatHistory: ChatMessage[];
  activityHistory?: ActivityEntry[];
  /** Conversation turns. Each user chat input opens a turn; agents/activity spawned
   *  by it inherit `turnId`. The most recent open turn (no `completedAt`) is the
   *  "current" turn that newly-spawned agents attach to. */
  turns?: Turn[];
  /** ID of the currently-open turn, if any. Convenience field hydrated by the store. */
  currentTurnId?: string;
  /** Live multi-agent pipeline state (rewrite → plan → critique → implement →
   *  review). Drives the AgentPipeline diagram above the activity log. Persisted
   *  so it survives reloads / pod restarts. Undefined for legacy tasks or tasks
   *  that have not started a pipeline run yet. */
  pipeline?: PipelineState;
  createdAt: string;
  updatedAt: string;
}

// ─── Multi-agent pipeline ─────────────────────────────────────

/** The five visible stages every request flows through. Distinct from
 *  `TaskStatus` (which gates deploy/ship semantics) — `pipelineStage` describes
 *  WHICH liliputian is acting, not the task's deploy lifecycle. */
export type PipelineStage =
  | 'rewrite'    // Rewriter rephrases the request for LLM efficiency
  | 'plan'       // Architect drafts an implementation plan
  | 'critique'   // Critic (rubber-duck) reviews the plan
  | 'implement'  // Coder writes the code
  | 'build'      // Builder commits, pushes, and builds the container image
  | 'deploy'     // Deployer rolls the image onto AKS dev preview
  | 'validate'   // Tester (Validator) probes the live preview & auto-heals
  | 'review';    // Reviewer (rubber-duck) reviews the result

export type PipelineStageStatus =
  | 'pending'    // Not reached yet
  | 'active'     // Currently running
  | 'done'       // Completed
  | 'skipped'    // Intentionally bypassed (e.g. operator rebuild command)
  | 'failed';    // Stage errored (non-fatal — pipeline continues)

/** Ordered metadata for the pipeline stages. Shared by the engine (to label
 *  stages) and the UI (to render the diagram). Each stage maps to an
 *  `AgentRole` so the diagram and the agent stream stay consistent. */
export const PIPELINE_STAGES: ReadonlyArray<{
  key: PipelineStage;
  label: string;
  icon: string;
  role: AgentRole;
}> = [
  { key: 'rewrite',   label: 'Rewrite',   icon: '✍️',  role: 'rewriter' },
  { key: 'plan',      label: 'Plan',      icon: '🗺️',  role: 'architect' },
  { key: 'critique',  label: 'Critique',  icon: '🦆',  role: 'critic' },
  { key: 'implement', label: 'Implement', icon: '🔨',  role: 'coder' },
  { key: 'build',     label: 'Build',     icon: '📦',  role: 'builder' },
  { key: 'deploy',    label: 'Deploy',    icon: '🚀',  role: 'deployer' },
  { key: 'validate',  label: 'Validate',  icon: '🩺',  role: 'tester' },
  { key: 'review',    label: 'Review',    icon: '👀',  role: 'reviewer' },
];

export interface PipelineState {
  /** Unique id for this pipeline run. Lets the client ignore stale stage
   *  events from a previous run (e.g. after a follow-up iteration). */
  runId: string;
  /** The stage currently running, if any. Undefined when the run finished. */
  activeStage?: PipelineStage;
  /** Per-stage status map. Always contains all five stages. */
  stages: Record<PipelineStage, PipelineStageStatus>;
  /** The Rewriter's rephrased prompt (shown in the log, fed to the coder). */
  rewrittenPrompt?: string;
  /** The Architect's implementation plan markdown. */
  plan?: string;
  startedAt: string;
  updatedAt: string;
}

/** What kind of action the reviewer was reviewing when it emitted feedback.
 *  Drives display, retry caps, and which prompt template was used. */
export type ReviewerFeedbackKind = 'spec' | 'coder-initial' | 'coder-iter' | 'deploy' | 'plan';

/** A single piece of feedback emitted by the reviewer. Lives on the Task
 *  until consumed by a follow-up coder turn (or surfaced to the user as
 *  unresolved when the per-kind attempt cap is exhausted). */
export interface ReviewerFeedback {
  id: string;
  kind: ReviewerFeedbackKind;
  /** Commit SHA the reviewer was looking at when it emitted this feedback.
   *  Null/undefined for non-workspace reviews (e.g. spec review). When set,
   *  the coder only consumes feedback that still matches HEAD — stale
   *  feedback from a previous commit is dropped silently. */
  sha?: string;
  /** The reviewer's feedback text — typically a short bullet list. */
  text: string;
  createdAt: string;
  /** Incremented each time this feedback (or its successor for the same
   *  kind) is injected into a coder prompt. Hard-capped at REVIEWER_MAX_ATTEMPTS. */
  attempts: number;
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
  /** Snapshot of the checking/reviewer model config at the time the turn was opened. */
  reviewerModel?: string;
  reviewerReasoningEffort?: ReasoningEffort;
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
  | 'rewriter'      // Rephrases the user request for LLM efficiency
  | 'coder'         // Writes code
  | 'critic'        // Rubber-ducks the plan before implementation
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
  | 'pipeline:stage'
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

export type ChatRole = 'gulliver' | 'liliput' | 'agent' | 'system' | 'reviewer';

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
  /** Optional Reviewer-Agent model id. When set, the Reviewer Agent is
   *  enabled (unless `reviewerEnabled` is explicitly false) and uses this
   *  model for review turns. */
  reviewerModel?: string;
  /** Optional Reviewer-Agent reasoning-effort hint. */
  reviewerReasoningEffort?: ReasoningEffort;
  /** Explicit on/off for the Reviewer Agent. Defaults to true when
   *  `reviewerModel` is set, false otherwise. */
  reviewerEnabled?: boolean;
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
  /**
   * 'sdk' when the list came from `client.listModels()` (the real list for the
   * authenticated Copilot account), 'fallback' when the SDK call failed and
   * the curated FALLBACK_MODELS list is being served instead. Optional for
   * back-compat with older API builds.
   */
  source?: 'sdk' | 'fallback';
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

// ─── Per-user agent-model defaults ───────────────────────────

/** Agent roles whose model + reasoning-effort are user-configurable via the
 *  profile. Subset of `AgentRole` — only the 5 LLM-heavy roles. Other roles
 *  (builder/deployer/tester/researcher/fixer) inherit from the coder. */
export type AgentConfigRole = 'rewriter' | 'architect' | 'critic' | 'coder' | 'reviewer';

export const AGENT_CONFIG_ROLES: readonly AgentConfigRole[] = [
  'rewriter',
  'architect',
  'critic',
  'coder',
  'reviewer',
] as const;

/** One row of the user's agent-model profile. `model`/`reasoningEffort` are
 *  nullable — null = "use server fallback" for that role. */
export interface UserAgentDefault {
  role: AgentConfigRole;
  /** Resolved model id (user pin → env → server default). Always populated. */
  effectiveModel: string;
  /** User's pinned model id, if any. Null = inherit from server fallback. */
  pinnedModel?: string | null;
  /** User's pinned reasoning effort, if any. Null = auto-derive from model. */
  pinnedReasoningEffort?: ReasoningEffort | null;
  /** Resolved reasoning effort (user pin → env → auto-derive). May be undefined. */
  effectiveReasoningEffort?: ReasoningEffort;
  /** Where the effective values came from — useful for UI hints. */
  source: 'user' | 'env' | 'default';
}

export interface UserAgentDefaultsResponse {
  defaults: readonly UserAgentDefault[];
}

export interface UpdateUserAgentDefaultRequest {
  /** Set to null/missing to clear the pin (fall back to env / server default). */
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
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

// ─── User Authentication ─────────────────────────────────────

export interface User {
  id: string;
  username: string;
  role: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
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

// ─── Per-LLM-call usage rows + pricing ───────────────────────
//
// Liliput records two layers of token usage:
//   1. Aggregate counters on `Turn` (cheap to read, lossy — single per-turn total)
//   2. Per-call rows (`TurnUsageCall`) — one per SDK `assistant.usage` event,
//      with the model, raw token counts, and the timestamp of the call.
//      These are the source of truth for cost computation, because prices
//      change over time and one turn may mix multiple models (coder + ops
//      fixer + reviewer).

/** Single LLM API call as reported by the SDK `assistant.usage` event. */
export interface TurnUsageCall {
  id: string;
  turnId: string;
  taskId: string;
  agentId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  nanoAiu?: number;
  durationMs?: number;
  /** ISO-8601 UTC. Used to resolve which `ModelPrice` row applied at the
   *  time of the call (prices change). */
  occurredAt: string;
}

/** A price entry for a model. Prices are per 1,000,000 tokens (matches
 *  GitHub Copilot's published units).
 *
 *  Lookup at cost time picks the row where:
 *    model = ?
 *    AND effective_from <= occurredAt
 *    AND min_input_tokens <= callInputTokens
 *  ordered by (effective_from DESC, min_input_tokens DESC) LIMIT 1.
 *
 *  Tier + min_input_tokens model GitHub's "Default" vs "Long context"
 *  pricing (e.g. GPT-5.5 charges 2× over 272K input tokens). Models
 *  without tiering use tier='default' + min_input_tokens=0. */
export interface ModelPrice {
  id: string;
  model: string;
  /** Display label for the tier (e.g. 'default', 'long_context'). Free-form. */
  tier: string;
  /** Pricing applies when call inputTokens >= this. Default 0. */
  minInputTokens: number;
  currency: string;
  /** Per million input tokens, in `currency`. */
  inputPerMtok: number;
  /** Per million cached-input (cache read) tokens. */
  cachedInputPerMtok?: number;
  /** Per million cache-write tokens (Anthropic-style). */
  cacheWritePerMtok?: number;
  /** Per million output tokens. */
  outputPerMtok: number;
  /** ISO-8601 UTC date this price became effective. */
  effectiveFrom: string;
  /** Optional provenance, e.g. 'github-copilot-2026-06-09'. */
  source?: string;
  notes?: string;
  createdAt: string;
}

/** Per-model breakdown row in a cost rollup. */
export interface CostByModel {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated cost in the rollup's currency (USD by default). */
  estimatedCost: number;
  /** True when at least one call in this model bucket had no matching
   *  `ModelPrice` row — its cost is reported as 0 and counted in
   *  `unpricedCalls` at the rollup level. */
  hasUnpriced: boolean;
}

/** Aggregate cost across all calls of a task/workstream/repo. */
export interface CostRollup {
  currency: string;
  estimatedCost: number;
  pricedCalls: number;
  unpricedCalls: number;
  perModel: CostByModel[];
}
