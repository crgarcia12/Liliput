package ui

import (
	"context"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/crgarcia12/liliput/cli/internal/client"
)

type newTaskModel struct {
	api    *client.HTTP
	width  int
	height int

	titleIn  textinput.Model
	repoIn   textinput.Model
	branchIn textinput.Model
	modeIn   textinput.Model
	descIn   textarea.Model

	focus int // 0..4
	err   string
}

const fieldCount = 5

func newNewTaskModel(api *client.HTTP) *newTaskModel {
	mk := func(ph string) textinput.Model {
		t := textinput.New()
		t.Placeholder = ph
		t.Prompt = "› "
		return t
	}
	title := mk("Add a settings panel")
	title.Focus()
	repo := mk("owner/repo (optional, required for code agents)")
	branch := mk("main (default base branch)")
	mode := mk("pr  |  direct   (default: pr)")

	desc := textarea.New()
	desc.Placeholder = "Describe the change in detail…"
	desc.SetHeight(6)
	desc.ShowLineNumbers = false

	return &newTaskModel{
		api:      api,
		titleIn:  title,
		repoIn:   repo,
		branchIn: branch,
		modeIn:   mode,
		descIn:   desc,
	}
}

func (m *newTaskModel) Init() tea.Cmd { return textinput.Blink }

func (m *newTaskModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	for _, ti := range []*textinput.Model{&m.titleIn, &m.repoIn, &m.branchIn, &m.modeIn} {
		ti.Width = w - 8
	}
	m.descIn.SetWidth(w - 8)
}

func (m *newTaskModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return m, func() tea.Msg { return cancelNewTaskMsg{} }
		case "tab":
			m.advance(1)
			return m, nil
		case "shift+tab":
			m.advance(-1)
			return m, nil
		case "enter":
			if m.focus < 4 { // not on textarea — just advance
				m.advance(1)
				return m, nil
			}
			return m, m.submit()
		case "ctrl+s":
			return m, m.submit()
		}
	}

	var cmd tea.Cmd
	switch m.focus {
	case 0:
		m.titleIn, cmd = m.titleIn.Update(msg)
	case 1:
		m.repoIn, cmd = m.repoIn.Update(msg)
	case 2:
		m.branchIn, cmd = m.branchIn.Update(msg)
	case 3:
		m.modeIn, cmd = m.modeIn.Update(msg)
	case 4:
		m.descIn, cmd = m.descIn.Update(msg)
	}
	return m, cmd
}

func (m *newTaskModel) advance(d int) {
	m.titleIn.Blur()
	m.repoIn.Blur()
	m.branchIn.Blur()
	m.modeIn.Blur()
	m.descIn.Blur()
	m.focus = (m.focus + d + fieldCount) % fieldCount
	switch m.focus {
	case 0:
		m.titleIn.Focus()
	case 1:
		m.repoIn.Focus()
	case 2:
		m.branchIn.Focus()
	case 3:
		m.modeIn.Focus()
	case 4:
		m.descIn.Focus()
	}
}

func (m *newTaskModel) submit() tea.Cmd {
	title := strings.TrimSpace(m.titleIn.Value())
	desc := strings.TrimSpace(m.descIn.Value())
	if title == "" || desc == "" {
		m.err = "title and description are required"
		return nil
	}
	mode := strings.TrimSpace(m.modeIn.Value())
	if mode != "pr" && mode != "direct" {
		mode = "pr"
	}
	branch := strings.TrimSpace(m.branchIn.Value())
	if branch == "" {
		branch = "main"
	}
	req := client.CreateTaskRequest{
		Title:       title,
		Description: desc,
		Repository:  strings.TrimSpace(m.repoIn.Value()),
		BaseBranch:  branch,
		CommitMode:  client.CommitMode(mode),
	}
	api := m.api
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		t, err := api.CreateTask(ctx, req)
		if err != nil {
			return errorMsg{err}
		}
		return taskCreatedMsg{task: t}
	}
}

func (m *newTaskModel) View() string {
	field := func(label string, view string, focused bool) string {
		l := lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(label)
		st := panelStyle
		if focused {
			st = panelFocusStyle
		}
		return l + "\n" + st.Width(m.width-4).Render(view)
	}
	body := strings.Join([]string{
		titleStyle.Render(" New task "),
		"",
		field("Title *", m.titleIn.View(), m.focus == 0),
		field("Repository", m.repoIn.View(), m.focus == 1),
		field("Base branch", m.branchIn.View(), m.focus == 2),
		field("Commit mode (pr|direct)", m.modeIn.View(), m.focus == 3),
		field("Description *", m.descIn.View(), m.focus == 4),
	}, "\n")
	if m.err != "" {
		body += "\n" + errBanner.Render(m.err)
	}
	hint := dimStyle.Render("tab/shift+tab next field · ctrl+s submit · esc cancel")
	return body + "\n\n" + hint
}
