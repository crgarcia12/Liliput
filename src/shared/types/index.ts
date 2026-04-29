// Liliput Shared Types — used by both API and Web

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
  | 'failed';

export type CommitMode = 'pr' | 'direct';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
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
  errorMessage?: string;      // Populated when status='failed'
  agents: Agent[];
  chatHistory: ChatMessage[];
  activityHistory?: ActivityEntry[];
  createdAt: string;
  updatedAt: string;
}

/** A single event in the persistent activity feed for a task. Surfaced in the
 *  Live Activity panel so the user can see what happened even after a page
 *  reload or pod restart. Mirrors the live socket events one-to-one. */
export interface ActivityEntry {
  id: string;
  taskId: string;
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
  name: string;
  role: AgentRole;
  status: AgentStatus;
  currentAction?: string;     // What the agent is doing right now
  logs: AgentLogEntry[];
  progress: number;           // 0-100
  createdAt: string;
  updatedAt: string;
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
