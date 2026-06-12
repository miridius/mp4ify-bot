---
name: pr
description: Use to open or update ANY PR instead of raw `gh pr create`. Re-run whenever the branch changes after a review or QA pass.
---

1. QA every user-visible change against the live dev bot — it serves the
   working tree, so don't switch branches mid-QA. Include failure paths by
   building fixtures (e.g. poison a cache entry). Verify the path taken in
   `docker compose logs dev`, not just the chat-visible outcome. Message
   the bot via web.telegram.org (browser tools); if no logged-in session,
   give the user an exact checklist. On re-runs, QA only what changed.
2. Spawn pr-review-toolkit's `pr-test-analyzer` on `git diff main...HEAD`
   (coverage thresholds don't catch hollow tests). Fixes → /commit →
   re-run the lens. Record dismissed findings in the PR's open decisions.
3. Write the description: Problem (user-visible symptom, then mechanism) →
   Fix → open decisions. Then spawn a `pr-description-audit` agent on the
   diff + draft and fix its findings.
4. Push; create the PR or update its body.
