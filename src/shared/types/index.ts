// Liliput Shared Types — used by both API and Web

// ─── Task (Feature Request) ───────────────────────────────────

export type TaskStatus = 'clarifying' | 'specifying' | 'building' | 'deploying' | 'completed' | 'failed';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  spec?: string;              // Generated specification markdown
  repository?: string;        // GitHub repo URL
  branch?: string;            // Working branch
  pullRequestUrl?: string;    // Created PR URL
  agents: Agent[];
  chatHistory: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// ─── Agent (Liliputian Worker) ────────────────────────────────

export type AgentRole =
  | 'architect'     // Plans the work, breaks into subtasks
  | 'coder'         // Writes code
  | 'reviewer'      // Reviews PRs
  | 'builder'       // Runs builds/CI
  | 'deployer'      // Deploys to AKS
  | 'tester'        // Runs tests
  | 'researcher';   // Looks up docs, patterns

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
