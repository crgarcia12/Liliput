package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HTTP wraps the Liliput REST API.
type HTTP struct {
	baseURL string
	hc      *http.Client
	token   string
}

func New(baseURL string) *HTTP {
	return &HTTP{
		baseURL: strings.TrimRight(baseURL, "/"),
		hc:      &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *HTTP) BaseURL() string { return c.baseURL }
func (c *HTTP) Token() string   { return c.token }

func (c *HTTP) SetToken(token string) {
	c.token = strings.TrimSpace(token)
}

func (c *HTTP) do(ctx context.Context, method, path string, body, out any) error {
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, buf)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("%s %s: %s — login required; run `liliput --login --server %s`", method, path, resp.Status, c.baseURL)
		}
		return fmt.Errorf("%s %s: %s — %s", method, path, resp.Status, truncate(string(respBody), 240))
	}
	if out == nil || len(respBody) == 0 {
		return nil
	}
	return json.Unmarshal(respBody, out)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func (c *HTTP) Health(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	return out, c.do(ctx, http.MethodGet, "/api/health", nil, &out)
}

func (c *HTTP) AuthStatus(ctx context.Context) (AuthStatus, error) {
	var s AuthStatus
	return s, c.do(ctx, http.MethodGet, "/api/auth/status", nil, &s)
}

func (c *HTTP) Login(ctx context.Context, username, password string) (*LoginResponse, error) {
	var out LoginResponse
	if err := c.do(ctx, http.MethodPost, "/api/login", LoginRequest{
		Username: username,
		Password: password,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *HTTP) ListTasks(ctx context.Context) ([]Task, error) {
	var out struct {
		Tasks []Task `json:"tasks"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks", nil, &out); err != nil {
		return nil, err
	}
	return out.Tasks, nil
}

func (c *HTTP) GetTask(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) CreateTask(ctx context.Context, req CreateTaskRequest) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks", req, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) Chat(ctx context.Context, id, message string) error {
	return c.do(ctx, http.MethodPost, "/api/tasks/"+id+"/chat",
		map[string]string{"message": message}, nil)
}

func (c *HTTP) ApproveSpec(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+id+"/approve-spec", nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) Ship(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+id+"/ship", nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) Discard(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+id+"/discard", nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) DeleteTask(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/tasks/"+id, nil, nil)
}

func (c *HTTP) DevPods(ctx context.Context, id string) ([]DevPod, error) {
	var out struct {
		Pods []DevPod `json:"pods"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+id+"/dev-pods", nil, &out); err != nil {
		return nil, err
	}
	return out.Pods, nil
}

func (c *HTTP) DevLogs(ctx context.Context, id, pod string, lines int, previous bool) (string, error) {
	q := "?pod=" + pod + "&tail=" + strconv.Itoa(lines)
	if previous {
		q += "&previous=1"
	}
	var out struct {
		Logs string `json:"logs"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+id+"/dev-logs"+q, nil, &out); err != nil {
		return "", err
	}
	return out.Logs, nil
}

// ─── Workstreams ─────────────────────────────────────────────

func (c *HTTP) ListWorkstreams(ctx context.Context) ([]Workstream, error) {
	var out struct {
		Workstreams []Workstream `json:"workstreams"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/workstreams", nil, &out); err != nil {
		return nil, err
	}
	return out.Workstreams, nil
}

func (c *HTTP) CreateWorkstream(ctx context.Context, req CreateWorkstreamRequest) (*Workstream, error) {
	var out struct {
		Workstream Workstream `json:"workstream"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/workstreams", req, &out); err != nil {
		return nil, err
	}
	return &out.Workstream, nil
}

func (c *HTTP) DeleteWorkstream(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/workstreams/"+id, nil, nil)
}

func (c *HTTP) DeleteRepoGroup(ctx context.Context, repo string) error {
	return c.do(ctx, http.MethodDelete, "/api/repo-groups/"+url.PathEscape(repo), nil, nil)
}

// ─── Delete previews ─────────────────────────────────────────

func (c *HTTP) PreviewTaskDelete(ctx context.Context, id string) (*DeletePreview, error) {
	var out struct {
		Preview DeletePreview `json:"preview"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+id+"/delete-preview", nil, &out); err != nil {
		return nil, err
	}
	return &out.Preview, nil
}

func (c *HTTP) PreviewWorkstreamDelete(ctx context.Context, id string) (*DeletePreview, error) {
	var out struct {
		Preview DeletePreview `json:"preview"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/workstreams/"+id+"/delete-preview", nil, &out); err != nil {
		return nil, err
	}
	return &out.Preview, nil
}

func (c *HTTP) PreviewRepoDelete(ctx context.Context, repo string) (*DeletePreview, error) {
	var out struct {
		Preview DeletePreview `json:"preview"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/repo-groups/"+url.PathEscape(repo)+"/delete-preview", nil, &out); err != nil {
		return nil, err
	}
	return &out.Preview, nil
}

// ─── Models / metadata mutations ─────────────────────────────

func (c *HTTP) ListModels(ctx context.Context) (*ModelsResponse, error) {
	var out ModelsResponse
	if err := c.do(ctx, http.MethodGet, "/api/models", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *HTTP) PatchTitle(ctx context.Context, id, title string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPatch, "/api/tasks/"+id+"/title",
		map[string]string{"title": title}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) PatchModel(ctx context.Context, id, model string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPatch, "/api/tasks/"+id+"/model",
		map[string]string{"model": model}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) PatchReasoningEffort(ctx context.Context, id, effort string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	body := map[string]any{"reasoningEffort": effort}
	if effort == "" {
		body["reasoningEffort"] = nil
	}
	if err := c.do(ctx, http.MethodPatch, "/api/tasks/"+id+"/reasoning-effort",
		body, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

// ─── Dev environment lifecycle ───────────────────────────────

func (c *HTTP) DevEnvStop(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+id+"/dev-env/stop", nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) DevEnvStart(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+id+"/dev-env/start", nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *HTTP) DevEnvDelete(ctx context.Context, id string) (*Task, error) {
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodDelete, "/api/tasks/"+id+"/dev-env", nil, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

// ─── Verdicts / tool wishes / usage ─────────────────────────

func (c *HTTP) ListVerdicts(ctx context.Context, taskID string) ([]Verdict, error) {
	var out struct {
		Verdicts []Verdict `json:"verdicts"`
	}
	path := "/api/verdicts"
	if taskID != "" {
		path = "/api/tasks/" + taskID + "/verdicts"
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Verdicts, nil
}

func (c *HTTP) LatestVerdict(ctx context.Context, taskID string) (*Verdict, error) {
	var out struct {
		Verdict Verdict `json:"verdict"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+taskID+"/verdicts/latest", nil, &out); err != nil {
		return nil, err
	}
	return &out.Verdict, nil
}

func (c *HTTP) ListToolWishes(ctx context.Context) ([]ToolWishAggregate, error) {
	var out struct {
		Aggregates []ToolWishAggregate `json:"aggregates"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tool-wishes", nil, &out); err != nil {
		return nil, err
	}
	return out.Aggregates, nil
}

func (c *HTTP) WorkstreamUsage(ctx context.Context, id string) (*UsageRollup, error) {
	var out UsageRollup
	if err := c.do(ctx, http.MethodGet, "/api/workstreams/"+id+"/usage", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *HTTP) RepoUsage(ctx context.Context, repo string) (*UsageRollup, error) {
	var out UsageRollup
	if err := c.do(ctx, http.MethodGet, "/api/repos/"+url.PathEscape(repo)+"/usage", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *HTTP) AllReposUsage(ctx context.Context) (map[string]UsageRollup, error) {
	out := map[string]UsageRollup{}
	if err := c.do(ctx, http.MethodGet, "/api/repos-usage", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *HTTP) AllWorkstreamsUsage(ctx context.Context) (map[string]UsageRollup, error) {
	out := map[string]UsageRollup{}
	if err := c.do(ctx, http.MethodGet, "/api/workstreams-usage", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *HTTP) ListTurns(ctx context.Context, taskID string) ([]Turn, error) {
	var out struct {
		Turns []Turn `json:"turns"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+taskID+"/turns", nil, &out); err != nil {
		return nil, err
	}
	return out.Turns, nil
}
