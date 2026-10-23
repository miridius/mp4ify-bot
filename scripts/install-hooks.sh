#!/bin/sh
set -e

# bun runs lifecycle scripts under umask 0000.
umask 022

# The dev image ships no git.
command -v git > /dev/null 2>&1 || exit 0

# The plugin's commit gate, looked up per commit under that commit's config
# dir: the marketplace's directory is named by however it was added
# (miridius-private from `marketplace add`, or a settings key).
gates='"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/marketplaces/*/plugins/gated-workflow/scripts/commit-gate.sh'
missing='echo "The gated-workflow plugin is not installed. Install it: claude plugin marketplace add miridius/claude-plugins && claude plugin install gated-workflow" >&2; exit 1'

found=
eval "for gate in $gates; do if [ -x \"\$gate\" ]; then found=1; fi; done"
[ -n "$found" ] || eval "$missing"

# From a worktree this resolves to the common hooks dir, the one git runs.
hooks=$(git rev-parse --git-path hooks)

write_hook() {
  printf '#!/bin/sh\n%s\n' "$2" > "$hooks/$1"
  chmod 755 "$hooks/$1"
}

mkdir -p "$hooks"
write_hook pre-commit "for gate in $gates; do [ -x \"\$gate\" ] && exec \"\$gate\"; done; $missing"
write_hook pre-push 'exec ./e2e.sh'
