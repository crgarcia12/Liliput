package ui

import "github.com/charmbracelet/lipgloss"

var (
	colorBg      = lipgloss.Color("#0f1115")
	colorPanel   = lipgloss.Color("#1a1d24")
	colorBorder  = lipgloss.Color("#3a3f4b")
	colorMuted   = lipgloss.Color("#6b7280")
	colorText    = lipgloss.Color("#e5e7eb")
	colorAccent  = lipgloss.Color("#7c5cff") // liliput purple
	colorOK      = lipgloss.Color("#4ade80")
	colorWarn    = lipgloss.Color("#fbbf24")
	colorErr     = lipgloss.Color("#f87171")
	colorInfo    = lipgloss.Color("#60a5fa")
	colorSpecial = lipgloss.Color("#22d3ee")

	headerStyle = lipgloss.NewStyle().
			Foreground(colorText).
			Background(colorAccent).
			Bold(true).
			Padding(0, 1)

	footerStyle = lipgloss.NewStyle().
			Foreground(colorMuted).
			Padding(0, 1)

	panelStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBorder).
			Padding(0, 1)

	panelFocusStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorAccent).
			Padding(0, 1)

	titleStyle = lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true)

	dimStyle = lipgloss.NewStyle().Foreground(colorMuted)

	errBanner = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#fff")).
			Background(colorErr).
			Bold(true).
			Padding(0, 1)

	okBanner = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#0f1115")).
			Background(colorOK).
			Bold(true).
			Padding(0, 1)
)

func statusBadge(status string) string {
	style := lipgloss.NewStyle().Bold(true).Padding(0, 1)
	switch status {
	case "clarifying":
		style = style.Background(colorInfo).Foreground(lipgloss.Color("#0f1115"))
	case "specifying":
		style = style.Background(colorSpecial).Foreground(lipgloss.Color("#0f1115"))
	case "building", "deploying", "shipping":
		style = style.Background(colorWarn).Foreground(lipgloss.Color("#0f1115"))
	case "review":
		style = style.Background(colorAccent).Foreground(colorText)
	case "completed":
		style = style.Background(colorOK).Foreground(lipgloss.Color("#0f1115"))
	case "failed":
		style = style.Background(colorErr).Foreground(lipgloss.Color("#fff"))
	case "discarded":
		style = style.Background(colorMuted).Foreground(colorText)
	default:
		style = style.Background(colorMuted).Foreground(colorText)
	}
	return style.Render(status)
}

func agentStatusGlyph(status string) string {
	switch status {
	case "working":
		return lipgloss.NewStyle().Foreground(colorWarn).Render("▶")
	case "completed":
		return lipgloss.NewStyle().Foreground(colorOK).Render("✓")
	case "failed":
		return lipgloss.NewStyle().Foreground(colorErr).Render("✗")
	case "waiting":
		return lipgloss.NewStyle().Foreground(colorMuted).Render("◯")
	default:
		return lipgloss.NewStyle().Foreground(colorMuted).Render("·")
	}
}

func authIndicator(ok *bool) string {
	switch {
	case ok == nil:
		return lipgloss.NewStyle().Foreground(colorMuted).Render("auth ?")
	case *ok:
		return lipgloss.NewStyle().Foreground(colorOK).Render("auth ✓")
	default:
		return lipgloss.NewStyle().Foreground(colorErr).Render("auth ✗")
	}
}
