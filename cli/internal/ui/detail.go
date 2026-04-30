package ui

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/crgarcia12/liliput/cli/internal/client"
)

type focusPane int

const (
	focusAgents focusPane = iota
	focusActivity
	focusChat
	focusInput
)

type detailModel struct {
	api      *client.HTTP
	socket   *client.Socket
	cancel   context.CancelFunc
	width, height int

	taskID string
	task   *client.Task

	// live state, indexed by agentId
	agents       map[string]*client.Agent
	agentsOrder  []string
	activity     []string
	chat         []client.ChatMessage

	// scrollable views
	agentsVP   viewport.Model
	activityVP viewport.Model
	chatVP     viewport.Model
	input      textarea.Model

	focus      focusPane
	socketStat string
}

type detailLoadedMsg struct{ task *client.Task }
type socketEventMsg struct{ ev client.SocketEvent }
type socketStatusMsg struct{ status string }

func newDetailModel(api *client.HTTP, taskID string) *detailModel {
	ta := textarea.New()
	ta.Placeholder = "Type a message and press Enter…"
	ta.Prompt = "▌ "
	ta.SetHeight(3)
	ta.ShowLineNumbers = false
	ta.CharLimit = 4000

	return &detailModel{
		api:         api,
		taskID:      taskID,
		agents:      map[string]*client.Agent{},
		agentsOrder: []string{},
		input:       ta,
		focus:       focusAgents,
		socketStat:  "connecting…",
		agentsVP:    viewport.New(0, 0),
		activityVP:  viewport.New(0, 0),
		chatVP:      viewport.New(0, 0),
	}
}

func (m *detailModel) Init() tea.Cmd {
	api := m.api
	id := m.taskID
	loadCmd := func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		t, err := api.GetTask(ctx, id)
		if err != nil {
			return errorMsg{err}
		}
		return detailLoadedMsg{task: t}
	}
	// start socket
	m.socket = client.NewSocket(m.api.BaseURL())
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	go m.socket.Run(ctx)
	m.socket.SubscribeTask(m.taskID)

	return tea.Batch(loadCmd, m.pumpSocket())
}

// pumpSocket forwards one socket message into the Bubble Tea event loop, then
// re-arms itself.
func (m *detailModel) pumpSocket() tea.Cmd {
	sock := m.socket
	return func() tea.Msg {
		select {
		case ev, ok := <-sock.Events():
			if !ok {
				return nil
			}
			return socketEventMsg{ev: ev}
		case st, ok := <-sock.Status():
			if !ok {
				return nil
			}
			return socketStatusMsg{status: st}
		}
	}
}

func (m *detailModel) Close() {
	if m.cancel != nil {
		m.cancel()
	}
	if m.socket != nil {
		m.socket.Close()
	}
}

func (m *detailModel) InputFocused() bool { return m.focus == focusInput }

func (m *detailModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	m.layout()
}

func (m *detailModel) layout() {
	if m.width < 20 || m.height < 10 {
		return
	}
	headerH := 4
	inputH := 5
	bodyH := m.height - headerH - inputH
	if bodyH < 6 {
		bodyH = 6
	}
	leftW := m.width / 3
	if leftW < 24 {
		leftW = 24
	}
	rightW := m.width - leftW - 4

	// agents pane = top of left column, activity = bottom of left column
	agentsH := bodyH / 2
	activityH := bodyH - agentsH

	m.agentsVP.Width = leftW - 2
	m.agentsVP.Height = agentsH - 2
	m.activityVP.Width = leftW - 2
	m.activityVP.Height = activityH - 2
	m.chatVP.Width = rightW - 2
	m.chatVP.Height = bodyH - 2
	m.input.SetWidth(m.width - 4)
}

func (m *detailModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case detailLoadedMsg:
		m.task = msg.task
		m.chat = append([]client.ChatMessage(nil), msg.task.ChatHistory...)
		for i := range msg.task.Agents {
			a := msg.task.Agents[i]
			if _, ok := m.agents[a.ID]; !ok {
				m.agentsOrder = append(m.agentsOrder, a.ID)
			}
			ac := a
			m.agents[a.ID] = &ac
		}
		for _, e := range msg.task.ActivityHistory {
			m.activity = append(m.activity, formatActivity(e.Timestamp, e.AgentName, e.Level, e.Message))
		}
		m.refreshPanes()
		return m, nil
	case socketStatusMsg:
		m.socketStat = msg.status
		return m, m.pumpSocket()
	case socketEventMsg:
		m.handleSocketEvent(msg.ev)
		m.refreshPanes()
		return m, m.pumpSocket()
	case tea.KeyMsg:
		if m.focus == focusInput {
			switch msg.String() {
			case "esc":
				m.focus = focusChat
				m.input.Blur()
				return m, nil
			case "enter":
				val := strings.TrimSpace(m.input.Value())
				if val == "" {
					return m, nil
				}
				m.input.Reset()
				return m, m.sendChat(val)
			}
			var cmd tea.Cmd
			m.input, cmd = m.input.Update(msg)
			return m, cmd
		}
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return backToTasksMsg{} }
		case "tab":
			m.focus = (m.focus + 1) % 4
			if m.focus == focusInput {
				m.input.Focus()
			} else {
				m.input.Blur()
			}
			return m, nil
		case "i":
			m.focus = focusInput
			m.input.Focus()
			return m, nil
		case "o":
			if m.task != nil && m.task.DevURL != "" {
				return m, openInBrowser(m.task.DevURL)
			}
		case "a":
			if m.task != nil && m.task.Status == "specifying" {
				return m, m.approveSpec()
			}
		case "s":
			if m.task != nil && m.task.Status == "review" {
				return m, m.shipTask()
			}
		case "x":
			if m.task != nil && m.task.Status == "review" {
				return m, m.discardTask()
			}
		case "l":
			return m, m.fetchLogs()
		}
		// scroll the focused pane
		switch m.focus {
		case focusAgents:
			var cmd tea.Cmd
			m.agentsVP, cmd = m.agentsVP.Update(msg)
			return m, cmd
		case focusActivity:
			var cmd tea.Cmd
			m.activityVP, cmd = m.activityVP.Update(msg)
			return m, cmd
		case focusChat:
			var cmd tea.Cmd
			m.chatVP, cmd = m.chatVP.Update(msg)
			return m, cmd
		}
	}
	return m, nil
}

func (m *detailModel) handleSocketEvent(ev client.SocketEvent) {
	switch ev.Name {
	case "task:status":
		var d struct {
			TaskID string `json:"taskId"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal(ev.Data, &d); err == nil && d.TaskID == m.taskID {
			if m.task != nil {
				m.task.Status = client.TaskStatus(d.Status)
			}
			m.activity = append(m.activity, formatActivity(time.Now().Format(time.RFC3339), "system", "info",
				"task status → "+d.Status))
		}
	case "task:spec":
		var d struct {
			TaskID string `json:"taskId"`
			Spec   string `json:"spec"`
		}
		if err := json.Unmarshal(ev.Data, &d); err == nil && d.TaskID == m.taskID {
			if m.task != nil {
				m.task.Spec = d.Spec
			}
			m.activity = append(m.activity, formatActivity(time.Now().Format(time.RFC3339), "system", "info",
				"spec drafted (press a to approve)"))
		}
	case "chat:message":
		var c client.ChatMessage
		if err := json.Unmarshal(ev.Data, &c); err == nil {
			m.chat = append(m.chat, c)
		}
	case "agent:spawned":
		var a struct {
			AgentID string `json:"agentId"`
			Name    string `json:"name"`
			Role    string `json:"role"`
			Status  string `json:"status"`
		}
		if err := json.Unmarshal(ev.Data, &a); err == nil {
			if _, ok := m.agents[a.AgentID]; !ok {
				m.agentsOrder = append(m.agentsOrder, a.AgentID)
			}
			m.agents[a.AgentID] = &client.Agent{
				ID: a.AgentID, Name: a.Name, Role: client.AgentRole(a.Role), Status: client.AgentStatus(a.Status),
			}
			m.activity = append(m.activity, formatActivity(time.Now().Format(time.RFC3339), a.Name, "info",
				"agent spawned ("+a.Role+")"))
		}
	case "agent:status":
		var a struct {
			AgentID       string `json:"agentId"`
			Status        string `json:"status"`
			CurrentAction string `json:"currentAction"`
			Progress      int    `json:"progress"`
		}
		if err := json.Unmarshal(ev.Data, &a); err == nil {
			if ag, ok := m.agents[a.AgentID]; ok {
				ag.Status = client.AgentStatus(a.Status)
				ag.CurrentAction = a.CurrentAction
				ag.Progress = a.Progress
			}
		}
	case "agent:log":
		var a struct {
			AgentID   string `json:"agentId"`
			Level     string `json:"level"`
			Message   string `json:"message"`
			Timestamp string `json:"timestamp"`
		}
		if err := json.Unmarshal(ev.Data, &a); err == nil {
			name := a.AgentID
			if ag, ok := m.agents[a.AgentID]; ok {
				name = ag.Name
			}
			m.activity = append(m.activity, formatActivity(a.Timestamp, name, a.Level, a.Message))
		}
	case "agent:tool-event":
		var a struct {
			AgentID   string `json:"agentId"`
			Kind      string `json:"kind"`
			Tool      string `json:"tool"`
			Summary   string `json:"summary"`
			Timestamp string `json:"timestamp"`
		}
		if err := json.Unmarshal(ev.Data, &a); err == nil {
			name := a.AgentID
			if ag, ok := m.agents[a.AgentID]; ok {
				name = ag.Name
			}
			tag := a.Kind
			if a.Tool != "" {
				tag = a.Kind + ":" + a.Tool
			}
			m.activity = append(m.activity, formatActivity(a.Timestamp, name, "info", "["+tag+"] "+a.Summary))
		}
	case "agent:completed":
		var a struct {
			AgentID string `json:"agentId"`
		}
		if err := json.Unmarshal(ev.Data, &a); err == nil {
			if ag, ok := m.agents[a.AgentID]; ok {
				ag.Status = "completed"
				m.activity = append(m.activity, formatActivity(time.Now().Format(time.RFC3339), ag.Name, "info", "completed"))
			}
		}
	case "agent:failed":
		var a struct {
			AgentID string `json:"agentId"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal(ev.Data, &a); err == nil {
			if ag, ok := m.agents[a.AgentID]; ok {
				ag.Status = "failed"
				m.activity = append(m.activity, formatActivity(time.Now().Format(time.RFC3339), ag.Name, "error", "failed: "+a.Error))
			}
		}
	}
	// trim activity buffer
	if len(m.activity) > 500 {
		m.activity = m.activity[len(m.activity)-500:]
	}
	if len(m.chat) > 500 {
		m.chat = m.chat[len(m.chat)-500:]
	}
}

func (m *detailModel) refreshPanes() {
	// AGENTS
	ids := append([]string(nil), m.agentsOrder...)
	sort.SliceStable(ids, func(i, j int) bool {
		return m.agents[ids[i]].Name < m.agents[ids[j]].Name
	})
	var lines []string
	for _, id := range ids {
		a := m.agents[id]
		role := lipgloss.NewStyle().Foreground(colorMuted).Render(string(a.Role))
		name := lipgloss.NewStyle().Foreground(colorText).Bold(true).Render(a.Name)
		line := fmt.Sprintf("%s %s %s  %s", agentStatusGlyph(string(a.Status)), name, role,
			lipgloss.NewStyle().Foreground(colorMuted).Render(a.CurrentAction))
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		lines = []string{dimStyle.Render("(no agents yet)")}
	}
	m.agentsVP.SetContent(strings.Join(lines, "\n"))

	// ACTIVITY
	if len(m.activity) == 0 {
		m.activityVP.SetContent(dimStyle.Render("(no activity yet)"))
	} else {
		m.activityVP.SetContent(strings.Join(m.activity, "\n"))
		m.activityVP.GotoBottom()
	}

	// CHAT
	var chatLines []string
	for _, c := range m.chat {
		chatLines = append(chatLines, formatChat(c))
	}
	if len(chatLines) == 0 {
		m.chatVP.SetContent(dimStyle.Render("(no messages yet)"))
	} else {
		m.chatVP.SetContent(strings.Join(chatLines, "\n"))
		m.chatVP.GotoBottom()
	}
}

func formatActivity(ts, who, level, msg string) string {
	t := client.ParseTime(ts)
	hh := "--:--:--"
	if !t.IsZero() {
		hh = t.Local().Format("15:04:05")
	}
	tag := lipgloss.NewStyle().Foreground(colorAccent).Render("[" + who + "]")
	style := lipgloss.NewStyle().Foreground(colorText)
	switch level {
	case "warn":
		style = style.Foreground(colorWarn)
	case "error":
		style = style.Foreground(colorErr)
	}
	return dimStyle.Render(hh) + " " + tag + " " + style.Render(msg)
}

func formatChat(c client.ChatMessage) string {
	var rolePrefix string
	switch c.Role {
	case "gulliver":
		rolePrefix = lipgloss.NewStyle().Foreground(colorOK).Bold(true).Render("[you]")
	case "liliput":
		rolePrefix = lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("[liliput]")
	case "agent":
		who := c.AgentName
		if who == "" {
			who = "agent"
		}
		rolePrefix = lipgloss.NewStyle().Foreground(colorInfo).Bold(true).Render("[" + who + "]")
	default:
		rolePrefix = dimStyle.Render("[system]")
	}
	return rolePrefix + " " + c.Content
}

func (m *detailModel) sendChat(text string) tea.Cmd {
	api := m.api
	id := m.taskID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := api.Chat(ctx, id, text); err != nil {
			return errorMsg{err}
		}
		return nil
	}
}

func (m *detailModel) approveSpec() tea.Cmd {
	api := m.api
	id := m.taskID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := api.ApproveSpec(ctx, id); err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: "Spec approved — building"}
	}
}

func (m *detailModel) shipTask() tea.Cmd {
	api := m.api
	id := m.taskID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := api.Ship(ctx, id); err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: "Shipping…"}
	}
}

func (m *detailModel) discardTask() tea.Cmd {
	api := m.api
	id := m.taskID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := api.Discard(ctx, id); err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: "Discarded"}
	}
}

func (m *detailModel) fetchLogs() tea.Cmd {
	api := m.api
	id := m.taskID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		pods, err := api.DevPods(ctx, id)
		if err != nil {
			return errorMsg{err}
		}
		if len(pods) == 0 {
			return bannerOK{text: "No dev pods yet"}
		}
		ctx2, cancel2 := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel2()
		logs, err := api.DevLogs(ctx2, id, pods[0].Name, 200, false)
		if err != nil {
			return errorMsg{err}
		}
		return bannerOK{text: fmt.Sprintf("logs %s: %d bytes", pods[0].Name, len(logs))}
	}
}

func (m *detailModel) View() string {
	if m.task == nil {
		return panelStyle.Width(m.width-2).Render("loading task…")
	}
	t := m.task

	// Top metadata block
	headerLine1 := titleStyle.Render(" TASK ") + " " +
		lipgloss.NewStyle().Bold(true).Render(t.Title) + "    " +
		statusBadge(string(t.Status)) + "    " +
		dimStyle.Render(fmt.Sprintf("socket: %s", m.socketStat))
	repo := t.Repository
	if repo == "" {
		repo = "—"
	}
	branch := t.Branch
	if branch == "" {
		branch = "—"
	}
	dev := t.DevURL
	if dev == "" {
		dev = "—"
	}
	commit := t.CommitSha
	if commit == "" {
		commit = "—"
	}
	headerLine2 := dimStyle.Render(fmt.Sprintf(
		"id: %s   repo: %s   branch: %s   dev: %s   commit: %s",
		shortID(t.ID), repo, branch, dev, shortID(commit)))

	header := lipgloss.JoinVertical(lipgloss.Left, headerLine1, headerLine2)

	agentsBox := paneBox("AGENTS", m.agentsVP.View(), m.focus == focusAgents)
	activityBox := paneBox("ACTIVITY", m.activityVP.View(), m.focus == focusActivity)
	chatBox := paneBox("CHAT", m.chatVP.View(), m.focus == focusChat)

	leftCol := lipgloss.JoinVertical(lipgloss.Left, agentsBox, activityBox)
	body := lipgloss.JoinHorizontal(lipgloss.Top, leftCol, chatBox)

	inputBox := panelStyle
	if m.focus == focusInput {
		inputBox = panelFocusStyle
	}
	inputView := inputBox.Width(m.width - 2).Render(m.input.View())

	return lipgloss.JoinVertical(lipgloss.Left, header, body, inputView)
}

func paneBox(title, content string, focused bool) string {
	style := panelStyle
	if focused {
		style = panelFocusStyle
	}
	header := titleStyle.Render(" " + title + " ")
	return style.Render(header + "\n" + content)
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
