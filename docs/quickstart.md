# Quick Start

Get the spec2cloud TypeScript shell running in under 5 minutes.

## Prerequisites

### Option A: Use Codespaces / DevContainer (Recommended)

All spec2cloud shells include a fully configured **DevContainer** / **GitHub Codespaces** setup. Everything is pre- the only thing you need locally is:installed 

- **Docker Desktop** (or any Docker-compatible  [docker.com](https://www.docker.com/products/docker-desktop/)runtime) 
- **VS Code** with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

Then simply open the repo in VS Code and click "Reopen in Container", or launch a GitHub Codespace from the repo page. All prerequisites below are handled automatically.

### Option B: Local Setup

If you prefer running locally without containers, install the following:

#### Core Tools (all shells need these)

| Tool | Purpose | Install |
|------|---------|---------|
| **GitHub Copilot** | AI orchestrator | [github.com/features/copilot](https://github.com/features/copilot) |
| **VS Code** | Editor with Copilot extension | [code.visualstudio.com](https://code.visualstudio.com/) |
| **Azure CLI** | Azure resource management | [aka.ms/installcli](https://aka.ms/installcli) |
| **Azure Developer CLI (azd)** | Deploy to Azure | [Install azd](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/install-azd) |
| **.NET SDK (latest)** | Required for Aspire orchestration | [dot.net](https://dot.net/download) |
| **.NET Aspire** | Local service orchestration | `curl -sSL https://aspire.dev/install.sh \| bash` |
| **Docker** | Container builds & deployment | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Git** | Source control | [git-scm.com](https://git-scm.com/) |

#### Language-Specific (TypeScript)

- **Node.js 20+** and ** [nodejs.org](https://nodejs.org/)npm** 

#### Optional (Recommended)

- ** `npx playwright install` (for E2E tests)Playwright** 
- ** `pip install mkdocs mkdocs-material` (for documentation site)MkDocs** 

### Install Scripts

<details>
<summary><strong>macOS (Homebrew)</strong></summary>

```bash
# Core tools
brew install azure-cli
brew install azd
brew install --cask docker
brew install dotnet
curl -sSL https://aspire.dev/install.sh | bash

# Language-specific
brew install node@20

# Optional
npx playwright install-deps && npx playwright install
pip install mkdocs mkdocs-material
```

</details>

<details>
<summary><strong>Linux (Ubuntu/Debian)</strong></summary>

```bash
# Core tools
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
curl -fsSL https://aka.ms/install-azd.sh | bash
wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh && chmod +x dotnet-install.sh && ./dotnet-install.sh
curl -sSL https://aspire.dev/install.sh | bash

# Language-specific
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Optional
npx playwright install-deps && npx playwright install
pip install mkdocs mkdocs-material
```

</details>

<details>
<summary><strong>Windows (winget / PowerShell)</strong></summary>

```powershell
# Core tools
winget install Microsoft.AzureCLI
winget install Microsoft.Azd
winget install Microsoft.DotNet.SDK.Preview
winget install Docker.DockerDesktop
dotnet workload install aspire

# Language-specific
winget install OpenJS.NodeJS.LTS

# Optional
npx playwright install
pip install mkdocs mkdocs-material
```

</details>

### Verify Installation

```bash
# Core
az --version && azd version && dotnet --version && aspire --version && docker --version

# Language
node --version  # v20+
npm --version
```

---

## Getting Started

### 1. Clone and Run

```bash
git clone https://github.com/EmeaAppGbb/spec2cloud-shell-nextjs-typescript.git
cd spec2cloud-shell-nextjs-typescript
dotnet run --project apphost.cs    # Aspire starts all services
```

### 2. Open in VS Code with Copilot

The orchestrator (AGENTS.md) activates automatically when you start a Copilot conversation.

### 3. Start Building

 deploy
- **Brownfield:** Ask Copilot to analyze the existing  it extracts specs, then you choose pathscodebase 

## What Happens Next

 deploy)  N increments

 Phase 2 Delivery
