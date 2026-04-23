export type TaskStatus = 'clarifying' | 'specifying' | 'building' | 'deploying' | 'completed' | 'failed';
export interface Task {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    spec?: string;
    repository?: string;
    branch?: string;
    pullRequestUrl?: string;
    agents: Agent[];
    chatHistory: ChatMessage[];
    createdAt: string;
    updatedAt: string;
}
export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'builder' | 'deployer' | 'tester' | 'researcher';
export type AgentStatus = 'idle' | 'working' | 'completed' | 'failed' | 'waiting';
export interface Agent {
    id: string;
    taskId: string;
    name: string;
    role: AgentRole;
    status: AgentStatus;
    currentAction?: string;
    logs: AgentLogEntry[];
    progress: number;
    createdAt: string;
    updatedAt: string;
}
export type AgentEventType = 'agent:spawned' | 'agent:status' | 'agent:log' | 'agent:progress' | 'agent:completed' | 'agent:failed' | 'task:status' | 'task:spec' | 'chat:message';
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
//# sourceMappingURL=index.d.ts.map