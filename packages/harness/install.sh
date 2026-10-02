#!/usr/bin/env bash
#
# {{NAME}} installer.
#
# This is what a control plane's install command runs:
#   curl -fsSL <control-plane>/agent/install.sh | bash -s -- --token=<token> --api-url=<control-plane>
# It fetches the runner (a single dependency-free Node script) from that same
# control plane, which serves the runtime API and these install assets, so one
# URL is all a machine needs, and hands the token through to it.
#
# {{RUNNER_SOURCE_ENV}} fetches the runner from a local file or another URL
# instead, for development against a runner that is not served yet.
set -euo pipefail

API_URL=""
for arg in "$@"; do
  case "$arg" in
    --api-url=*) API_URL="${arg#--api-url=}" ;;
  esac
done

RUNNER_URL="${{{RUNNER_SOURCE_ENV}}:-${API_URL:+$API_URL/agent/harness.js}}"
if [[ -z "$RUNNER_URL" ]]; then
  echo "{{NAME}}: missing --api-url. Copy the install command from your control plane." >&2
  exit 1
fi
INSTALL_DIR="${{{INSTALL_HOME_ENV}}:-$HOME/{{HOME_DIR_NAME}}}"
# .cjs, not .js: a package.json with "type": "module" in any directory above
# this one would otherwise make Node load the runner as an ES module and fail.
RUNNER_PATH="$INSTALL_DIR/harness.cjs"

if ! command -v node >/dev/null 2>&1; then
  # Amazon Linux 2023 and most minimal cloud images ship no Node at all, which
  # is the most common reason this command does nothing on a fresh instance.
  # Saying which command installs it turns a dead end into one step.
  echo "{{NAME}}: Node.js 18+ is required on this machine." >&2
  if command -v dnf >/dev/null 2>&1; then
    echo "  Amazon Linux / Fedora / RHEL:  sudo dnf install -y nodejs" >&2
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  Debian / Ubuntu:               sudo apt-get update && sudo apt-get install -y nodejs" >&2
  elif command -v brew >/dev/null 2>&1; then
    echo "  macOS:                         brew install node" >&2
  fi
  echo "  Then re-run this command." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "{{NAME}}: Node.js 18+ is required, found $(node --version 2>/dev/null || echo unknown)." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

if [[ "$RUNNER_URL" == http://* || "$RUNNER_URL" == https://* ]]; then
  curl -fsSL "$RUNNER_URL" -o "$RUNNER_PATH"
else
  cp "$RUNNER_URL" "$RUNNER_PATH"
fi
chmod +x "$RUNNER_PATH"

exec node "$RUNNER_PATH" "$@"
