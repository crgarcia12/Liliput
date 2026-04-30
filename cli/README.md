# Liliput CLI

A k9s-style terminal UI for the [Liliput](../README.md) feature-orchestration backend,
written in Go with [Bubble Tea](https://github.com/charmbracelet/bubbletea).

It mirrors the web UI: list tasks, open a task with live agent activity and chat,
create / ship / discard tasks, and tail dev-pod logs — all from the terminal.

## Build

```sh
cd cli
go mod tidy
go build -ldflags="-s -w" -o liliput.exe ./cmd/liliput
```

Cross-compile for Windows from Linux/macOS:

```sh
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o liliput.exe ./cmd/liliput
```

## Run

```sh
./liliput.exe                                  # default server http://4.165.50.135
./liliput.exe --server http://localhost:5001   # local dev API
LILIPUT_API_URL=http://my-host ./liliput.exe   # via env
```

## Keybindings

### Tasks list

| Key            | Action                       |
| -------------- | ---------------------------- |
| `↑/↓` `j/k`    | Navigate                     |
| `Enter`        | Open task detail             |
| `n`            | New task                     |
| `d`            | Delete current task          |
| `s`            | Ship task (when in review)   |
| `x`            | Discard task (when in review)|
| `/`            | Filter by title/repo         |
| `r`            | Manual refresh               |
| `?`            | Help                         |
| `q` / `Ctrl+C` | Quit                         |

Tasks are auto-refreshed every 5 seconds.

### Task detail

| Key            | Action                                          |
| -------------- | ----------------------------------------------- |
| `Tab`          | Cycle focus: agents / activity / chat / input   |
| `i`            | Focus chat input                                |
| `Enter`        | Send chat message (when input focused)          |
| `Esc`          | Leave input                                     |
| `o`            | Open dev URL in browser                         |
| `s`            | Ship task                                       |
| `x`            | Discard task                                    |
| `a`            | Approve spec                                    |
| `l`            | Tail dev-pod logs                               |
| `q` / `Esc`    | Back to tasks list                              |

## Architecture

```
cli/
├── cmd/liliput/main.go
└── internal/
    ├── client/   # REST + Socket.IO v4 (Engine.IO over gorilla/websocket)
    └── ui/       # Bubble Tea screens, lipgloss styles, key bindings
```

The Socket.IO client implements Engine.IO v4 / Socket.IO v4 framing directly on
top of `gorilla/websocket` — no third-party Socket.IO library required. It
auto-reconnects with exponential backoff (3 s → 30 s).


## Install via Scoop (Windows)

Liliput publishes its own [Scoop](https://scoop.sh) bucket from the same repo.

```powershell
# 1. Install Scoop (if you don't have it):
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression

# 2. Add the Liliput bucket and install:
scoop bucket add liliput https://github.com/crgarcia12/Liliput
scoop install liliput

# 3. Run it:
liliput
```

To upgrade later: `scoop update liliput`. The bucket auto-updates on every
`cli-v*` GitHub release — see `.github/workflows/release-cli.yml` (the
`update-scoop` job recomputes the SHA256 and commits a new
`bucket/liliput.json` after publishing).
