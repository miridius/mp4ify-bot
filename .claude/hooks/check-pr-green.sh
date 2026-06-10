#!/bin/sh
# PreToolUse gate: only allow `gh pr merge` when the PR's checks are green.
# Stdin: hook JSON with .tool_input.command containing the gh invocation.
cmd=$(jq -r '.tool_input.command // empty')
# Merge target = first non-flag arg after "merge": a PR number, URL, or
# branch name (gh pr checks accepts all three). Empty = PR for current branch.
target=$(printf '%s' "$cmd" | sed -n 's/.*gh pr merge//p' | tr ' ' '\n' | grep -m1 -v -e '^-' -e '^$' || true)
if out=$(gh pr checks ${target:+"$target"} 2>&1); then
  exit 0
fi
jq -n --arg out "$out" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ("PR checks are not green; fix CI before merging.\n" + $out)}}'
