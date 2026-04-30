package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// HTTP wraps the Liliput REST API.
type HTTP struct {
	baseURL string
	hc      *http.Client
}

func New(baseURL string) *HTTP {
	return &HTTP{
		baseURL: baseURL,
		hc:      &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *HTTP) BaseURL() string { return c.baseURL }

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
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
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
