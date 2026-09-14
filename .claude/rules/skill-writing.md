---
paths:
  - ".claude/skills/**/*.md"
---

# Writing skills

A skill is executed by an agent prone to skipping steps it judges
unnecessary; that judgment is the failure mode, so write against it:

- Cut descriptive bloat: don't restate what a script does, that a tool is
  built-in, or mechanics the reader doesn't need in order to act.
- Keep a concise WHY on each load-bearing step, naming the actual failure
  it prevents. A bare imperative gets rationalized away; the why blocks it.
- Every step runs every time; "seems unnecessary here" is never a reason to
  skip one.
