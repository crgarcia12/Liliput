package ui

import "github.com/charmbracelet/bubbles/key"

type keyMap struct {
	Up, Down, Left, Right key.Binding
	Enter                 key.Binding
	Tab                   key.Binding
	Esc                   key.Binding
	New                   key.Binding
	Delete                key.Binding
	Ship                  key.Binding
	Discard               key.Binding
	Approve               key.Binding
	OpenURL               key.Binding
	Logs                  key.Binding
	Filter                key.Binding
	Refresh               key.Binding
	Help                  key.Binding
	Input                 key.Binding
	Quit                  key.Binding
}

var keys = keyMap{
	Up:      key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up")),
	Down:    key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down")),
	Left:    key.NewBinding(key.WithKeys("left", "h"), key.WithHelp("←/h", "left")),
	Right:   key.NewBinding(key.WithKeys("right", "l"), key.WithHelp("→/l", "right")),
	Enter:   key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "select / send")),
	Tab:     key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "cycle focus")),
	Esc:     key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "back / cancel")),
	New:     key.NewBinding(key.WithKeys("n"), key.WithHelp("n", "new task")),
	Delete:  key.NewBinding(key.WithKeys("d"), key.WithHelp("d", "delete")),
	Ship:    key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "ship")),
	Discard: key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "discard")),
	Approve: key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "approve spec")),
	OpenURL: key.NewBinding(key.WithKeys("o"), key.WithHelp("o", "open dev url")),
	Logs:    key.NewBinding(key.WithKeys("l"), key.WithHelp("l", "dev logs")),
	Filter:  key.NewBinding(key.WithKeys("/"), key.WithHelp("/", "filter")),
	Refresh: key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "refresh")),
	Help:    key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
	Input:   key.NewBinding(key.WithKeys("i"), key.WithHelp("i", "focus input")),
	Quit:    key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
}
