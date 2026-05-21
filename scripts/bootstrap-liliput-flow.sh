#!/usr/bin/env bash
# bootstrap-liliput-flow.sh — idempotently install the Liliput PM/Dev/RM overlay
# into a target repository.
#
# Usage:
#   bash scripts/bootstrap-liliput-flow.sh <target-dir> [--force] [--apply-labels]
#
# Behaviour:
#   - Copies every file under templates/liliput-flow/ into <target-dir>.
#   - If a destination file already exists and is non-empty, it is SKIPPED
#     (printed as "skip: ...") unless --force is passed.
#   - With --apply-labels, also reconciles labels via `gh` (one-shot, no workflow needed).
#   - Safe to re-run.
#
# Exit codes: 0 on success, 1 on usage error, 2 on copy error.

set -euo pipefail

TARGET=""
FORCE=0
APPLY_LABELS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --apply-labels) APPLY_LABELS=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      if [[ -z "$TARGET" ]]; then
        TARGET="$1"
        shift
      else
        echo "error: unexpected arg: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "usage: bash scripts/bootstrap-liliput-flow.sh <target-dir> [--force] [--apply-labels]" >&2
  exit 1
fi

if [[ ! -d "$TARGET" ]]; then
  echo "error: target dir does not exist: $TARGET" >&2
  exit 1
fi

# Resolve source dir (templates/liliput-flow/) relative to this script.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/templates/liliput-flow"

if [[ ! -d "$SRC" ]]; then
  echo "error: templates dir not found: $SRC" >&2
  exit 2
fi

copied=0
skipped=0
forced=0

# Iterate every regular file under SRC.
while IFS= read -r -d '' rel; do
  src_file="$SRC/$rel"
  dest_file="$TARGET/$rel"
  dest_dir="$(dirname "$dest_file")"
  mkdir -p "$dest_dir"

  if [[ -s "$dest_file" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      cp "$src_file" "$dest_file"
      echo "force:  $rel"
      forced=$((forced+1))
    else
      echo "skip:   $rel (exists, non-empty)"
      skipped=$((skipped+1))
    fi
  else
    cp "$src_file" "$dest_file"
    echo "write:  $rel"
    copied=$((copied+1))
  fi
done < <(cd "$SRC" && find . -type f -print0 | sed -z 's|^\./||')

echo ""
echo "summary: $copied written, $skipped skipped, $forced forced"

if [[ "$APPLY_LABELS" -eq 1 ]]; then
  if ! command -v gh >/dev/null; then
    echo "warn: gh CLI not found; skipping --apply-labels" >&2
    exit 0
  fi
  echo ""
  echo "applying labels via gh CLI..."
  (
    cd "$TARGET"
    if [[ ! -f .github/liliput/labels.yml ]]; then
      echo "error: .github/liliput/labels.yml missing in target" >&2
      exit 2
    fi
    python3 - <<'PY'
import json, os, subprocess, sys
try:
    import yaml
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pyyaml"])
    import yaml
with open(".github/liliput/labels.yml") as f:
    labels = yaml.safe_load(f) or []
repo = subprocess.check_output(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).decode().strip()
existing = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/labels?per_page=100", "--paginate"]))
existing_by_name = {l["name"]: l for l in existing}
for spec in labels:
    name, color, desc = spec["name"], spec["color"].lstrip("#"), spec.get("description", "")
    if name in existing_by_name:
        cur = existing_by_name[name]
        if cur["color"].lower() != color.lower() or (cur.get("description") or "") != desc:
            subprocess.check_call(["gh", "api", "-X", "PATCH", f"repos/{repo}/labels/{name}",
                                   "-f", f"new_name={name}", "-f", f"color={color}", "-f", f"description={desc}"])
            print(f"update: {name}")
        else:
            print(f"ok:     {name}")
    else:
        subprocess.check_call(["gh", "api", "-X", "POST", f"repos/{repo}/labels",
                               "-f", f"name={name}", "-f", f"color={color}", "-f", f"description={desc}"])
        print(f"create: {name}")
PY
  )
fi
