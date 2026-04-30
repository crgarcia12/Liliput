package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/crgarcia12/liliput/cli/internal/client"
	"github.com/crgarcia12/liliput/cli/internal/ui"
)

const version = "0.1.0"

const defaultServer = "http://4.165.50.135"

func main() {
	var (
		serverFlag  string
		showVersion bool
	)
	flag.StringVar(&serverFlag, "server", "", "Liliput API base URL (overrides $LILIPUT_API_URL; default "+defaultServer+")")
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "liliput — k9s-style TUI for the Liliput backend\n\nUsage:\n  liliput [--server URL]\n\nFlags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if showVersion {
		fmt.Printf("liliput %s\n", version)
		return
	}

	server := serverFlag
	if server == "" {
		server = os.Getenv("LILIPUT_API_URL")
	}
	if server == "" {
		server = defaultServer
	}
	server = strings.TrimRight(server, "/")

	api := client.New(server)
	app := ui.NewApp(api, version)

	p := tea.NewProgram(app, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
