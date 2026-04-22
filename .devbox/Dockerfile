FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Install OS tools: tmux (for persistent sessions across kubectl exec),
# git, curl, ca-certs, python, build-essential (for native npm modules),
# jq, less, unzip.
USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates jq less unzip vim \
      python3 python3-pip python3-venv \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
 && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
 && rm kubectl

# GitHub Copilot CLI (the `copilot` command used to run agents unattended)
RUN npm install -g @github/copilot

# Azure Developer CLI (azd) — convenient if agents want to deploy
RUN curl -fsSL https://aka.ms/install-azd.sh | bash

# Give the default `node` user sudo just in case
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node

USER node
WORKDIR /home/node/work

# Default command: keep the container alive forever so kubectl exec can attach.
# tmux sessions started inside will survive client disconnects.
CMD ["sleep", "infinity"]
