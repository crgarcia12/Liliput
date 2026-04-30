package client

import "time"

type TaskStatus string
type CommitMode string
type AgentStatus string
type AgentRole string
type ChatRole string

type Task struct {
	ID                string        `json:"id"`
	Title             string        `json:"title"`
	Description       string        `json:"description"`
	Status            TaskStatus    `json:"status"`
	Spec              string        `json:"spec,omitempty"`
	Repository        string        `json:"repository,omitempty"`
	BaseBranch        string        `json:"baseBranch,omitempty"`
	Branch            string        `json:"branch,omitempty"`
	CommitMode        CommitMode    `json:"commitMode,omitempty"`
	PullRequestURL    string        `json:"pullRequestUrl,omitempty"`
	PullRequestNumber int           `json:"pullRequestNumber,omitempty"`
	CommitSha         string        `json:"commitSha,omitempty"`
	ImageRef          string        `json:"imageRef,omitempty"`
	DevNamespace      string        `json:"devNamespace,omitempty"`
	DevURL            string        `json:"devUrl,omitempty"`
	ErrorMessage      string        `json:"errorMessage,omitempty"`
	Agents            []Agent       `json:"agents"`
	ChatHistory       []ChatMessage `json:"chatHistory"`
	ActivityHistory   []Activity    `json:"activityHistory,omitempty"`
	CreatedAt         string        `json:"createdAt"`
	UpdatedAt         string        `json:"updatedAt"`
}

type Agent struct {
	ID            string      `json:"id"`
	TaskID        string      `json:"taskId"`
	Name          string      `json:"name"`
	Role          AgentRole   `json:"role"`
	Status        AgentStatus `json:"status"`
	CurrentAction string      `json:"currentAction,omitempty"`
	Progress      int         `json:"progress"`
	CreatedAt     string      `json:"createdAt"`
	UpdatedAt     string      `json:"updatedAt"`
}

type ChatMessage struct {
	ID        string   `json:"id"`
	TaskID    string   `json:"taskId"`
	Role      ChatRole `json:"role"`
	AgentID   string   `json:"agentId,omitempty"`
	AgentName string   `json:"agentName,omitempty"`
	Content   string   `json:"content"`
	Timestamp string   `json:"timestamp"`
}

type Activity struct {
	ID        string `json:"id"`
	TaskID    string `json:"taskId"`
	Timestamp string `json:"timestamp"`
	Kind      string `json:"kind"`
	AgentID   string `json:"agentId,omitempty"`
	AgentName string `json:"agentName,omitempty"`
	Level     string `json:"level,omitempty"`
	Message   string `json:"message"`
	Command   string `json:"command,omitempty"`
	Output    string `json:"output,omitempty"`
}

type AuthStatus struct {
	OK            *bool  `json:"ok"`
	LastCheckedAt string `json:"lastCheckedAt"`
	ErrorKind     string `json:"errorKind,omitempty"`
	Message       string `json:"message,omitempty"`
	HasToken      bool   `json:"hasToken"`
}

type DevPod struct {
	Name      string `json:"name"`
	Phase     string `json:"phase"`
	Ready     bool   `json:"ready,omitempty"`
	Container string `json:"container,omitempty"`
}

type CreateTaskRequest struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Repository  string     `json:"repository,omitempty"`
	BaseBranch  string     `json:"baseBranch,omitempty"`
	CommitMode  CommitMode `json:"commitMode,omitempty"`
}

// ParseTime is a forgiving RFC3339 parser used for sorting and "age" rendering.
func ParseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}
