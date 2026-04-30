package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

func renderHelp(width, height int) string {
	rows := [][2]string{
		{"Tasks list", ""},
		{"  ↑/↓ or j/k", "navigate"},
		{"  Enter", "open task detail"},
		{"  n", "new task"},
		{"  d", "delete task (asks y/n)"},
		{"  s", "ship task (review only)"},
		{"  x", "discard task (review only)"},
		{"  /", "filter by title or repository"},
		{"  r", "manual refresh"},
		{"  q · Ctrl+C", "quit"},
		{"", ""},
		{"Task detail", ""},
		{"  Tab", "cycle focus: agents → activity → chat → input"},
		{"  i", "focus chat input"},
		{"  Enter (in input)", "send message"},
		{"  Esc (in input)", "leave input"},
		{"  o", "open dev URL in browser"},
		{"  a", "approve spec (specifying)"},
		{"  s", "ship task (review)"},
		{"  x", "discard task (review)"},
		{"  l", "fetch latest dev pod logs"},
		{"  q · Esc", "back to tasks list"},
		{"", ""},
		{"New task modal", ""},
		{"  Tab / Shift+Tab", "next / previous field"},
		{"  Ctrl+S", "submit"},
		{"  Esc", "cancel"},
	}

	var sb strings.Builder
	sb.WriteString(titleStyle.Render(" Liliput keybindings "))
	sb.WriteString("\n\n")
	for _, r := range rows {
		if r[0] == "" && r[1] == "" {
			sb.WriteString("\n")
			continue
		}
		if r[1] == "" {
			sb.WriteString(lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(r[0]))
			sb.WriteString("\n")
			continue
		}
		key := lipgloss.NewStyle().Foreground(colorInfo).Width(22).Render(r[0])
		desc := lipgloss.NewStyle().Foreground(colorText).Render(r[1])
		sb.WriteString(key + "  " + desc + "\n")
	}
	sb.WriteString("\n")
	sb.WriteString(dimStyle.Render("Press Esc / q / ? to close"))
	w := width - 6
	if w < 30 {
		w = 30
	}
	return panelStyle.Width(w).Render(sb.String())
}
