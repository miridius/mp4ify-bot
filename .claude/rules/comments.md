---
paths:
  - "src/**"
  - "test/**"
  - "scripts/**"
---

# Comments

A code comment has exactly one purpose: to help a future maintainer change
this code correctly, by carrying the constraints the code and tests cannot
carry themselves. A comment addressed to anyone else (a reviewer, a diff
reader, the author's process) does not belong in the source.

A comment may only state a constraint the code cannot show: an external fact
(a library's hidden behavior, a remote API quirk, a verified real-world
payload) or the why of a deliberately surprising choice. Never write a comment
that:

- Explains what the adjacent code plainly shows, or restates a test name, an
  assertion, or a log line next to it.
- Tells past-tense history, justifies a change, or talks to a reviewer ("used
  to", "previously", "fixed", "split out from", "now", referencing a bug story
  or issue number): the next reader sees only the final code.
- Guards a behavior a test could pin: if the constraint is testable and
  untested, write the test, not the comment. A comment survives alongside a
  test only where the code locally reads as a mistake (error swallowing, odd
  ordering); then say why, clearly.
- Pads with redundant contrast ("X, not Y" where Y is merely not-X): state
  the constraint once, positively.

No literal em or en dashes in any tracked .ts file, comments and
user-facing strings included (scripts/check-dashes.sh gates the staged
content locally and in CI); use a comma, colon, or parenthetical. A fixture
or quoted payload that genuinely needs the character uses the \u2013 or
\u2014 escape, which the gate does not match.

Every comment must pass the strip test: remove it, and if a competent reader
could recover the content from the code, the names, the contracts of the
functions called, and the tests, it should not exist. A causal veneer
("so ...", "because ...") does not turn narration into a why. A comment sits
ON the line it explains. Show, don't tell: real payloads and verified
behaviors belong in test fixtures, and once a test pins a constraint, a
comment restating it dies. Length is never the criterion: an
unneeded explanation is noise at any length, and a needed one gets however
many words it takes to explain clearly. A long comment on something simple is a
smell that warrants checking whether the content is needed at all, never a
violation by itself. The file's existing comment density
is not a license: judge each comment alone, and prefer a clearer name or a
test over any comment. When a review-refuted finding keeps resurfacing, first
try to make the code read right; an intent pin at the flagged site is the
last resort.
