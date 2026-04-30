package ui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/crgarcia12/liliput/cli/internal/client"
)

type tasksModel struct {
	api    *client.HTTP
	width  int
	height int

	all       []client.Task
	filtered  []client.Task
	tbl       table.Model
	filtering bool
	filter    textinput.Model

	confirmDelete bool
}

type tasksLoadedMsg struct{ tasks []client.Task }

func newTasksModel(api *client.HTTP) *tasksModel {
	t := table.New(
		table.WithFocused(true),
		table.WithColumns([]table.Column{
			{Title: "STATUS", Width: 12},
			{Title: "TITLE", Width: 30},
			{Title: "REPOSITORY", Width: 24},
			{Title: "BRANCH", Width: 24},
			{Title: "DEV URL", Width: 28},
			{Title: "AGE", Width: 8},
			{Title: "UPDATED", Width: 8},
		}),
	)
	st := table.DefaultStyles()
	st.Header = st.Header.Foreground(colorAccent).Bold(true).BorderForeground(colorBorder)
	st.Selected = lipgloss.NewStyle().Foreground(colorText).Background(colorAccent).Bold(true)
	t.SetStyles(st)

	fi := textinput.New()
	fi.Placeholder = "filter title or repository…"
	fi.Prompt = "/ "
	fi.CharLimit = 60

	return &tasksModel{api: api, tbl: t, filter: fi}
}

func (m *tasksModel) Init() tea.Cmd { return m.Refresh() }

func (m *tasksModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	m.layout()
}

func (m *tasksModel) layout() {
	if m.width == 0 || m.height == 0 {
		return
	}
	// distribute widths: STATUS, TITLE, REPO, BRANCH, DEV URL, AGE, UPDATED
	w := m.width - 4 // panel padding
	statusW := 13
	ageW := 8
	updW := 8
	rest := w - statusW - ageW - updW - 6
	if rest < 40 {
		rest = 40
	}
	titleW := rest * 30 / 100
	repoW := rest * 22 / 100
	branchW := rest * 22 / 100
	devW := rest - titleW - repoW - branchW
	if devW < 14 {
		devW = 14
	}
	m.tbl.SetColumns([]table.Column{
		{Title: "STATUS", Width: statusW},
		{Title: "TITLE", Width: titleW},
		{Title: "REPOSITORY", Width: repoW},
		{Title: "BRANCH", Width: branchW},
		{Title: "DEV URL", Width: devW},
		{Title: "AGE", Width: ageW},
		{Title: "UPDATED", Width: updW},
	})
	h := m.height - 4
	if h < 5 {
		h = 5
	}
	m.tbl.SetHeight(h)
}

func (m *tasksModel) Refresh() tea.Cmd {
	api := m.api
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		tasks, err := api.ListTasks(ctx)
		if err != nil {
			return errorMsg{err}
		}
		return tasksLoadedMsg{tasks: tasks}
	}
}

func (m *tasksModel) selectedTask() *client.Task {
	if len(m.filtered) == 0 {
		return nil
	}
	idx := m.tbl.Cursor()
	if idx < 0 || idx >= len(m.filtered) {
		return nil
	}
	t := m.filtered[idx]
	return &t
}

func (m *tasksModel) applyFilter() {
	q := strings.ToLower(strings.TrimSpace(m.filter.Value()))
	if q == "" {
		m.filtered = append([]client.Task(nil), m.all...)
	} else {
		m.filtered = m.filtered[:0]
		for _, t := range m.all {
			if strings.Contains(strings.ToLower(t.Title), q) ||
				strings.Contains(strings.ToLower(t.Repository), q) {
				m.filtered = append(m.filtered, t)
			}
		}
	}
	rows := make([]table.Row, 0, len(m.filtered))
	now := time.Now()
	for _, t := range m.filtered {
		rows = append(rows, table.Row{
			statusBadge(string(t.Status)),
			truncate(t.Title, 60),
			truncate(t.Repository, 50),
			truncate(t.Branch, 50),
			truncate(t.DevURL, 60),
			ago(client.ParseTime(t.CreatedAt), now),
			ago(client.ParseTime(t.UpdatedAt), now),
		})
	}
	m.tbl.SetRows(rows)
}

func (m *tasksModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tasksLoadedMsg:
		sort.SliceStable(msg.tasks, func(i, j int) bool {
			return client.ParseTime(msg.tasks[i].UpdatedAt).After(client.ParseTime(msg.tasks[j].UpdatedAt))
		})
		m.all = msg.tasks
		m.applyFilter()
		return m, nil
	case tea.KeyMsg:
		if m.confirmDelete {
			switch msg.String() {
			case "y", "Y", "enter":
				t := m.selectedTask()
				m.confirmDelete = false
				if t == nil {
					return m, nil
				}
				return m, m.deleteTask(t.ID)
			case "n", "N", "esc":
				m.confirmDelete = false
				return m, nil
			}
			return m, nil
		}
		if m.filtering {
			switch msg.String() {
			case "esc":
				m.filtering = false
				m.filter.Blur()
				m.filter.SetValue("")
				m.applyFilter()
				return m, nil
			case "enter":
				m.filtering = false
				m.filter.Blur()
				return m, nil
			}
			var cmd tea.Cmd
			m.filter, cmd = m.filter.Update(msg)
			m.applyFilter()
			return m, cmd
		}
		switch {
		case key.Matches(msg, keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, keys.Filter):
			m.filtering = true
			m.filter.Focus()
			return m, nil
		case key.Matches(msg, keys.Refresh):
			return m, m.Refresh()
		case key.Matches(msg, keys.New):
			return m, func() tea.Msg { return openNewTaskMsg{} }
		case key.Matches(msg, keys.Delete):
			if m.selectedTask() != nil {
				m.confirmDelete = true
			}
			return m, nil
		case key.Matches(msg, keys.Ship):
			t := m.selectedTask()
			if t != nil && t.Status == "review" {
				return m, m.shipTask(t.ID)
			}
		case key.Matches(msg, keys.Discard):
			t := m.selectedTask()
			if t != nil && t.Status == "review" {
				return m, m.discardTask(t.ID)
			}
		case key.Matches(msg, keys.Enter):
			t := m.selectedTask()
			if t == nil {
				return m, nil
			}
			id := t.ID
			return m, func() tea.Msg { return openDetailMsg{taskID: id} }
		}
	}
	var cmd tea.Cmd
	m.tbl, cmd = m.tbl.Update(msg)
	return m, cmd
}

func (m *tasksModel) deleteTask(id string) tea.Cmd {
	api := m.api
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := api.DeleteTask(ctx, id); err != nil {
			return errorMsg{err}
		}
		ctx2, cancel2 := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel2()
		tasks, err := api.ListTasks(ctx2)
		if err != nil {
			return errorMsg{err}
		}
		return tasksLoadedMsg{tasks: tasks}
	}
}

func (m *tasksModel) shipTask(id string) tea.Cmd {
	api := m.api
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := api.Ship(ctx, id); err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: "Shipping task " + id}
	}
}

func (m *tasksModel) discardTask(id string) tea.Cmd {
	api := m.api
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := api.Discard(ctx, id); err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: "Discarded task " + id}
	}
}

func (m *tasksModel) View() string {
	body := panelStyle.Width(m.width - 2).Render(m.tbl.View())
	if m.filtering {
		body = lipgloss.JoinVertical(lipgloss.Left, m.filter.View(), body)
	}
	if m.confirmDelete {
		t := m.selectedTask()
		title := ""
		if t != nil {
			title = t.Title
		}
		modal := errBanner.Render(fmt.Sprintf(
			"Delete task %q? (y / n)", truncate(title, 40)))
		body = lipgloss.JoinVertical(lipgloss.Left, body, modal)
	}
	return body
}

func ago(t, now time.Time) string {
	if t.IsZero() {
		return "—"
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

func truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) > n {
		if n > 1 {
			return s[:n-1] + "…"
		}
		return s[:n]
	}
	return s
}
