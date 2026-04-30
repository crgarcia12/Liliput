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


## Install via WinGet (Windows)

Once published, install with:

```powershell
winget install crgarcia12.Liliput
```

### One-time first-submission bootstrap (maintainers only)

WinGet auto-publish only kicks in for v0.1.1+ — the first version must be
submitted manually. Steps (~5 minutes):

1. **Install wingetcreate** (Microsoft's official manifest tool):
   ```powershell
   winget install Microsoft.WingetCreate
   ```

2. **Create a classic GitHub Personal Access Token** with the `public_repo` scope
   at https://github.com/settings/tokens — this is what wingetcreate (and the
   auto-update workflow below) use to fork microsoft/winget-pkgs and open PRs.

3. **Run the new-package wizard** — it auto-fills most fields from the GitHub
   release URL:
   ```powershell
   wingetcreate new https://github.com/crgarcia12/Liliput/releases/download/cli-v0.1.0/liliput-windows-amd64.exe
   ```
   When prompted:
   - **PackageIdentifier**: `crgarcia12.Liliput`
   - **PackageVersion**: `cli-v0.1.0` (matches the git tag — keeps versioning consistent with future auto-publishes)
   - **InstallerType**: `portable` (single-file exe, no installer)
   - **License**: `ISC`
   - **Publisher**: `crgarcia12`
   - **PackageName**: `Liliput`
   - **ShortDescription**: `k9s-style terminal UI for the Liliput feature-orchestration backend`
   - **License URL**: `https://github.com/crgarcia12/Liliput/blob/main/LICENSE`
   - Submit when asked → wingetcreate opens the PR for you.

4. **Wait for moderation** — typically <24 hours. Check the PR at
   https://github.com/microsoft/winget-pkgs/pulls?q=crgarcia12.Liliput

5. **Add the `WINGET_TOKEN` secret** to this repo (Settings → Secrets and variables
   → Actions → New repository secret) with the same PAT from step 2. The
   `winget-publish.yml` workflow uses it to auto-submit subsequent versions.

After the first version is approved, every future release that you publish on
the `cli-v*` tag will auto-update WinGet via `.github/workflows/winget-publish.yml`.
No more manual steps.
