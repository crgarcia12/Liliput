package client

import "time"

type TaskStatus string
type CommitMode string
type AgentStatus string
type AgentRole string
type ChatRole string

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

type LoginResponse struct {
	Token string    `json:"token"`
	User  LoginUser `json:"user"`
}

type Task struct {
	ID                string        `json:"id"`
	Title             string        `json:"title"`
	Description       string        `json:"description"`
	Status            TaskStatus    `json:"status"`
	WorkstreamID      string        `json:"workstreamId,omitempty"`
	FeatureID         string        `json:"featureId,omitempty"`
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
	DevPort           int           `json:"devPort,omitempty"`
	DevEnvState       string        `json:"devEnvState,omitempty"`
	ErrorMessage      string        `json:"errorMessage,omitempty"`
	Model             string        `json:"model,omitempty"`
	ReasoningEffort   string        `json:"reasoningEffort,omitempty"`
	Agents            []Agent       `json:"agents"`
	ChatHistory       []ChatMessage `json:"chatHistory"`
	ActivityHistory   []Activity    `json:"activityHistory,omitempty"`
	CreatedAt         string        `json:"createdAt"`
	UpdatedAt         string        `json:"updatedAt"`
}

// Workstream groups Tasks for a repo (parent of Tasks).
type Workstream struct {
	ID                 string `json:"id"`
	Repository         string `json:"repository"`
	Name               string `json:"name"`
	Description        string `json:"description,omitempty"`
	GithubLabel        string `json:"githubLabel,omitempty"`
	TrackerIssueNumber int    `json:"trackerIssueNumber,omitempty"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
}

// CreateWorkstreamRequest is the body for POST /api/workstreams.
type CreateWorkstreamRequest struct {
	Repository  string `json:"repository"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ModelOption mirrors the /api/models picker entries.
type ModelOption struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Family string `json:"family,omitempty"`
	Note   string `json:"note,omitempty"`
}

type ModelsResponse struct {
	Options []ModelOption `json:"options"`
	Default string        `json:"default"`
	Source  string        `json:"source,omitempty"`
}

// Verdict is what an agent declared on its last turn.
type Verdict struct {
	ID        string `json:"id"`
	TaskID    string `json:"taskId"`
	AgentID   string `json:"agentId,omitempty"`
	AgentName string `json:"agentName,omitempty"`
	Kind      string `json:"kind"` // done | blocked | continue
	Message   string `json:"message,omitempty"`
	Timestamp string `json:"timestamp"`
}

// ToolWishAggregate is one row of /api/tool-wishes (aggregated view).
type ToolWishAggregate struct {
	Tool      string `json:"tool"`
	Count     int    `json:"count"`
	LastSeen  string `json:"lastSeenAt,omitempty"`
	LastNote  string `json:"lastNote,omitempty"`
	Examples  []any  `json:"examples,omitempty"`
}

// UsageRollup is the aggregated usage shape returned by /api/{workstreams,repos}/:id/usage.
type UsageRollup struct {
	Turns            int     `json:"turns"`
	TotalTokens      int     `json:"totalTokens"`
	InputTokens      int     `json:"inputTokens"`
	OutputTokens     int     `json:"outputTokens"`
	CacheReadTokens  int     `json:"cacheReadTokens"`
	CacheWriteTokens int     `json:"cacheWriteTokens"`
	DurationMs       int64   `json:"durationMs"`
	NanoAIU          float64 `json:"nanoAiu,omitempty"`
}

// DeletePreview is the response body of preview endpoints.
type DeletePreview struct {
	Scope         string `json:"scope"`
	Label         string `json:"label"`
	TaskCount     int    `json:"taskCount"`
	Branches      []struct {
		Repository string `json:"repository"`
		Branch     string `json:"branch"`
	} `json:"branches"`
	PullRequests []struct {
		Repository string `json:"repository"`
		Number     int    `json:"number"`
		URL        string `json:"url,omitempty"`
	} `json:"pullRequests"`
	Namespaces  []string `json:"namespaces"`
	Workstreams []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"workstreams"`
	Tasks []struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Status string `json:"status"`
	} `json:"tasks"`
}

// Turn is one user-input-driven turn aggregated across agents.
type Turn struct {
	ID          string `json:"id"`
	TaskID      string `json:"taskId"`
	Index       int    `json:"index"`
	Title       string `json:"title"`
	UserMessage string `json:"userMessage"`
	Model       string `json:"model,omitempty"`
	Status      string `json:"status"`
	StartedAt   string `json:"startedAt"`
	CompletedAt string `json:"completedAt,omitempty"`
	DurationMs  int64  `json:"durationMs,omitempty"`
	Usage       struct {
		InputTokens      int     `json:"inputTokens"`
		OutputTokens     int     `json:"outputTokens"`
		CacheReadTokens  int     `json:"cacheReadTokens"`
		CacheWriteTokens int     `json:"cacheWriteTokens"`
		TotalTokens      int     `json:"totalTokens"`
		NanoAIU          float64 `json:"nanoAiu,omitempty"`
		CallCount        int     `json:"callCount"`
	} `json:"usage"`
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
	Title           string     `json:"title"`
	Description     string     `json:"description"`
	Repository      string     `json:"repository,omitempty"`
	BaseBranch      string     `json:"baseBranch,omitempty"`
	CommitMode      CommitMode `json:"commitMode,omitempty"`
	WorkstreamID    string     `json:"workstreamId,omitempty"`
	Model           string     `json:"model,omitempty"`
	ReasoningEffort string     `json:"reasoningEffort,omitempty"`
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
