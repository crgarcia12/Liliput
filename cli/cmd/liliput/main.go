package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/crgarcia12/liliput/cli/internal/client"
	"github.com/crgarcia12/liliput/cli/internal/ui"
)

// Bump this manually when you want to confirm a CLI install was rebuilt from current source.
const cliVersion = "0.0.87"

const defaultServer = "https://liliput.crgarcia.com.ar"

func main() {
	var (
		serverFlag  string
		tokenFlag   string
		username    string
		login       bool
		logout      bool
		showVersion bool
	)
	flag.StringVar(&serverFlag, "server", "", "Liliput API base URL (overrides $LILIPUT_API_URL; default "+defaultServer+")")
	flag.StringVar(&tokenFlag, "token", "", "JWT session token (prefer $LILIPUT_TOKEN; not saved)")
	flag.StringVar(&username, "username", "", "username for --login (overrides $LILIPUT_USERNAME)")
	flag.BoolVar(&login, "login", false, "prompt for username/password, save the session token, then launch the TUI")
	flag.BoolVar(&logout, "logout", false, "delete the saved session token for this server and exit")
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "liliput — k9s-style TUI for the Liliput backend\n\nUsage:\n  liliput [--server URL]\n  liliput --login [--server URL]\n  liliput --logout [--server URL]\n\nFlags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if showVersion {
		fmt.Printf("liliput CLI %s\n", cliVersion)
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
	if logout {
		if err := deleteSavedToken(server); err != nil {
			fmt.Fprintln(os.Stderr, "logout failed:", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Deleted saved Liliput session for %s\n", server)
		return
	}

	if tokenFlag == "" {
		tokenFlag = os.Getenv("LILIPUT_TOKEN")
	}
	if tokenFlag == "" {
		if saved, ok, err := loadSavedToken(server); err != nil {
			fmt.Fprintln(os.Stderr, "warning: could not read saved auth token:", err)
		} else if ok {
			tokenFlag = saved.Token
		}
	}
	if tokenFlag != "" {
		api.SetToken(tokenFlag)
	}

	if login {
		if username == "" {
			username = os.Getenv("LILIPUT_USERNAME")
		}
		username, err := promptUsername(username)
		if err != nil {
			fmt.Fprintln(os.Stderr, "login failed:", err)
			os.Exit(1)
		}
		password, err := promptPassword()
		if err != nil {
			fmt.Fprintln(os.Stderr, "login failed:", err)
			os.Exit(1)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		resp, err := api.Login(ctx, username, password)
		cancel()
		if err != nil {
			fmt.Fprintln(os.Stderr, "login failed:", err)
			os.Exit(1)
		}
		api.SetToken(resp.Token)
		if err := saveToken(server, resp.User.Username, resp.Token); err != nil {
			fmt.Fprintln(os.Stderr, "warning: could not save auth token:", err)
		}
	}

	app := ui.NewApp(api, cliVersion)

	p := tea.NewProgram(app, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
