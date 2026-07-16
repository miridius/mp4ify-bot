#!/bin/sh
set -e

# bun runs lifecycle scripts under umask 0000.
umask 022

# The dev image ships no git.
command -v git > /dev/null 2>&1 || exit 0

gate_path='plugins/marketplaces/miridius-plugins/plugins/gated-workflow/scripts/commit-gate.sh'
# Written unexpanded: CLAUDE_CONFIG_DIR need not be set the same at commit
# time as at install time.
gate_command="\"\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}/$gate_path\""
gate="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/$gate_path"

if ! [ -x "$gate" ]; then
  echo "The commit gate is not installed at $gate." >&2
  echo "Install the gated-workflow plugin (see .claude/settings.json)." >&2
  exit 1
fi

# From a worktree this resolves to the common hooks dir, the one git runs.
hooks=$(git rev-parse --git-path hooks)

write_hook() {
  printf '#!/bin/sh\nexec %s\n' "$2" > "$hooks/$1"
  chmod 755 "$hooks/$1"
}

mkdir -p "$hooks"
write_hook pre-commit "$gate_command"
write_hook pre-push ./e2e.sh
