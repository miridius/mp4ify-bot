#!/bin/sh
# En/em dashes are banned in .ts source (see .claude/rules/comments.md).
# git grep --cached scans the INDEX, i.e. exactly what a commit would record
# (the worktree can differ both ways), and the '*.ts' pathspec tracks every
# .ts file wherever it lives, so a new top-level dir can't dodge the gate.
# LC_ALL=C pins byte-wise PCRE: \x{2013}-style escapes error under C locales
# while \xe2-style bytes mis-match under UTF-8 mode. The case turns a scan
# ERROR (e.g. a git without PCRE support) into a loud failure, never a
# silent pass.
st=0
dashes=$(LC_ALL=C git grep --cached -nP '\xe2\x80[\x93\x94]' -- '*.ts') || st=$?
case $st in
  0)
    printf '%s\n' "$dashes"
    echo "em/en dash found (use a comma, colon, or parenthetical instead)" >&2
    exit 1
    ;;
  1) ;;
  *)
    echo "em/en dash scan failed to run" >&2
    exit 1
    ;;
esac
