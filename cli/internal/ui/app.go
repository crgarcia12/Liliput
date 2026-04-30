package ui

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/crgarcia12/liliput/cli/internal/client"
)

// screen tags
type screen int

const (
	screenTasks screen = iota
	screenDetail
	screenNewTask
	screenHelp
)

// App is the root model — owns the HTTP client and routes between sub-models.
type App struct {
	api     *client.HTTP
	version string

	width, height int

	screen   screen
	prev     screen
	tasks    *tasksModel
	detail   *detailModel
	newTask  *newTaskModel
	auth     client.AuthStatus
	errMsg   string
	errUntil time.Time
}

func NewApp(api *client.HTTP, version string) *App {
	a := &App{api: api, version: version}
	a.tasks = newTasksModel(api)
	return a
}

// ─── messages ────────────────────────────────────────────────

type tickMsg time.Time
type authMsg client.AuthStatus
type errorMsg struct{ err error }
type bannerOK struct{ text string }
type openDetailMsg struct{ taskID string }
type backToTasksMsg struct{}
type openNewTaskMsg struct{}
type taskCreatedMsg struct{ task *client.Task }
type cancelNewTaskMsg struct{}

func tick() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func fetchAuth(api *client.HTTP) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		s, err := api.AuthStatus(ctx)
		if err != nil {
			return errorMsg{err}
		}
		return authMsg(s)
	}
}

// ─── tea.Model ───────────────────────────────────────────────

func (a *App) Init() tea.Cmd {
	return tea.Batch(a.tasks.Init(), tick(), fetchAuth(a.api))
}

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		a.width, a.height = m.Width, m.Height
		a.tasks.SetSize(m.Width, m.Height-2) // header + footer
		if a.detail != nil {
			a.detail.SetSize(m.Width, m.Height-2)
		}
		if a.newTask != nil {
			a.newTask.SetSize(m.Width, m.Height-2)
		}
	case tickMsg:
		// 5 s background poll: refresh tasks list and auth, never disrupting input
		cmds := []tea.Cmd{tick()}
		if a.screen == screenTasks {
			cmds = append(cmds, a.tasks.Refresh())
		}
		cmds = append(cmds, fetchAuth(a.api))
		return a, tea.Batch(cmds...)
	case authMsg:
		a.auth = client.AuthStatus(m)
	case errorMsg:
		a.errMsg = m.err.Error()
		a.errUntil = time.Now().Add(6 * time.Second)
	case bannerOK:
		a.errMsg = m.text
		a.errUntil = time.Now().Add(3 * time.Second)
	case openDetailMsg:
		a.detail = newDetailModel(a.api, m.taskID)
		a.detail.SetSize(a.width, a.height-2)
		a.prev = a.screen
		a.screen = screenDetail
		return a, a.detail.Init()
	case backToTasksMsg:
		if a.detail != nil {
			a.detail.Close()
			a.detail = nil
		}
		a.screen = screenTasks
		return a, a.tasks.Refresh()
	case openNewTaskMsg:
		a.newTask = newNewTaskModel(a.api)
		a.newTask.SetSize(a.width, a.height-2)
		a.prev = a.screen
		a.screen = screenNewTask
		return a, a.newTask.Init()
	case taskCreatedMsg:
		a.newTask = nil
		a.screen = screenTasks
		return a, tea.Batch(
			a.tasks.Refresh(),
			func() tea.Msg { return bannerOK{text: "Task created: " + m.task.Title} },
		)
	case cancelNewTaskMsg:
		a.newTask = nil
		a.screen = screenTasks
		return a, nil
	case tea.KeyMsg:
		// Help is a global toggle.
		if a.screen == screenHelp {
			if m.String() == "esc" || m.String() == "q" || m.String() == "?" {
				a.screen = a.prev
			}
			return a, nil
		}
		if m.String() == "?" && a.screen != screenNewTask && (a.detail == nil || !a.detail.InputFocused()) {
			a.prev = a.screen
			a.screen = screenHelp
			return a, nil
		}
	}

	switch a.screen {
	case screenTasks:
		_, cmd := a.tasks.Update(msg)
		return a, cmd
	case screenDetail:
		_, cmd := a.detail.Update(msg)
		return a, cmd
	case screenNewTask:
		_, cmd := a.newTask.Update(msg)
		return a, cmd
	}
	return a, nil
}

func (a *App) View() string {
	header := a.renderHeader()
	footer := a.renderFooter()

	var body string
	switch a.screen {
	case screenTasks:
		body = a.tasks.View()
	case screenDetail:
		body = a.detail.View()
	case screenNewTask:
		body = a.newTask.View()
	case screenHelp:
		body = renderHelp(a.width, a.height-2)
	}
	if a.errMsg != "" && time.Now().Before(a.errUntil) {
		banner := errBanner.Width(a.width).Render("⚠  " + a.errMsg)
		// overlay banner at top of body
		body = lipgloss.JoinVertical(lipgloss.Left, banner, body)
	}
	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (a *App) renderHeader() string {
	left := titleStyle.Render(" Liliput ")
	mid := dimStyle.Render(fmt.Sprintf(" %s · v%s ", a.api.BaseURL(), a.version))
	right := authIndicator(a.auth.OK)
	gap := a.width - lipgloss.Width(left) - lipgloss.Width(mid) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	bar := lipgloss.JoinHorizontal(lipgloss.Center,
		left, mid, lipgloss.NewStyle().Width(gap).Render(""), right, " ",
	)
	return headerStyle.Width(a.width).Render(bar)
}

func (a *App) renderFooter() string {
	var hints string
	switch a.screen {
	case screenTasks:
		hints = "↑/↓ navigate · enter open · n new · d delete · s ship · x discard · / filter · r refresh · ? help · q quit"
	case screenDetail:
		if a.detail != nil && a.detail.InputFocused() {
			hints = "enter send · esc leave input"
		} else {
			hints = "tab focus · i input · o open · a approve · s ship · x discard · l logs · q back"
		}
	case screenNewTask:
		hints = "tab next field · enter submit · esc cancel"
	case screenHelp:
		hints = "esc close help"
	}
	return footerStyle.Width(a.width).Render(hints)
}

// openInBrowser opens a URL in the user's default browser.
func openInBrowser(url string) tea.Cmd {
	return func() tea.Msg {
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("cmd", "/c", "start", "", url)
		case "darwin":
			cmd = exec.Command("open", url)
		default:
			cmd = exec.Command("xdg-open", url)
		}
		if err := cmd.Start(); err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: "Opened " + url}
	}
}
