#!/bin/sh
# PreToolUse gate: only allow `gh pr merge` when the PR's checks are green.
# Stdin: hook JSON with .tool_input.command containing the gh invocation.
cmd=$(jq -r '.tool_input.command // empty')
# First PR number or URL in the command; empty means "PR for current branch"
target=$(printf '%s' "$cmd" | tr ' ' '\n' | grep -m1 -E '^[0-9]+$|^https://' || true)
if out=$(gh pr checks $target 2>&1); then
  exit 0
fi
jq -n --arg out "$out" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ("PR checks are not green; fix CI before merging.\n" + $out)}}'
