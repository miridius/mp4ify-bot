# mp4ify-bot

## Environment Variables

Set as secrets in Claude Code Web environment settings (before starting a session):

- `BOT_TOKEN` - Telegram bot token (from @BotFather)
- `OWNER_ID` - Telegram user ID of the bot owner (for e2e testing & notifications)

## Development Workflow

Follow these steps for every task. Do NOT skip steps.

### Steps 1-3: Plan mode (research, learning tests, acceptance tests)

**These steps MUST be done in plan mode.** The plan must include acceptance test descriptions for user approval before any implementation begins.

#### Step 1: Understand the task

Read the user's request. Identify which Telegram API features are involved.

#### Step 2: Verify you have sufficient learning/contract tests & mocks

Learning tests (a.k.a. contract tests) call **real external services** to verify our assumptions about their behavior. They serve two purposes:
1. **Learn** how an API actually works (not how docs say it works)
2. **Detect** when an external service changes behavior (run them to re-verify)

The same assertions should also run against our **mocks** to verify parity. If a learning test passes against the real service but fails against our mock, the mock is wrong.

**Structure:** `test/learning-tests.test.ts` contains shared assertion functions that run against both real services and mocks. Real-service tests are gated behind env vars (`INTEGRATION=1`) so they don't run on every `bun test`, but can be triggered to re-verify assumptions.

**For Telegram API:**
1. Send OWNER_ID a Telegram message explaining what you need them to do
2. Poll `getUpdates` with a 30s timeout to capture their response
3. Add the new payload(s) to `real-payloads.json`
4. Write shared assertions that run against both the real payload AND MockBotApi output
5. Update `MockBotApi` in `simulate-bot-api.ts` if assertions fail against it

**For yt-dlp / other CLI tools:**
1. Run the real command (e.g., `yt-dlp --dump-json <url>`)
2. Save captured output to `test/fixtures/`
3. Write shared assertions that run against both real output AND fixture data

**IMPORTANT:** Reading the Telegram Bot API docs is good for orientation, but NEVER assume anything is true unless you have tested it empirically. The docs can be incomplete or misleading (e.g., inline query DMs use `chat_type: "sender"` not `"private"`).

**IMPORTANT:** Inline queries are real-time and do NOT queue up. The bot must be actively polling `getUpdates` at the moment the user types the inline query. Regular messages and callback queries DO queue up and can be retrieved later.

**IMPORTANT:** Even if you feel confident about an API shape from web research, you MUST still capture a real payload before writing code. Confidence from docs/research is not a substitute for empirical verification. This applies to ALL Telegram update types: messages, inline queries, callback queries, etc.

#### Step 3: Write acceptance tests

Include the acceptance tests in the plan. List each test with its name and a brief description of what it verifies. Use `withBotApi` from `test/simulate-bot-api.ts` to run the bot against MockBotApi.

**IMPORTANT:** Do NOT write any production code until the acceptance tests exist. Not even "just the types" or "just the scaffolding." Tests first, implementation second. This is non-negotiable.

**IMPORTANT:** The plan MUST include the acceptance tests for user approval via ExitPlanMode. The user may have different requirements than you assumed (e.g., which chat types a feature applies to, who has permissions, what messages to show). Getting this wrong wastes significant time.

### Step 4: Implement

Iterate until all acceptance tests pass. Run `bun test` frequently.

### Step 5: Polish

Run these steps in order. If any step produces changes, restart from (a).

a. `bun run lint` — fix any issues
b. `bun test` — fix any failures
c. `/simplify` — review for reuse, quality, and efficiency; fix issues found
d. Use the pr-review-toolkit agents to do a comprehensive quality review
   (comments, tests, error handling, types, general quality, simplification)

### Step 6: End-to-end test with the owner

Run the bot against real Telegram:

```bash
API_ROOT=https://api.telegram.org BOT_TOKEN=$BOT_TOKEN bun run dev
```

**The owner must explicitly approve that step 6 is done before moving on.** Do not self-certify E2E results.

For inline query testing, you must be polling BEFORE the user types the query since inline queries don't queue up.

### Step 7: Iterate

If the e2e test reveals wrong assumptions or the user gives feedback, go back to Step 2. Update learning tests, mocks, and acceptance tests as needed.

### Step 8: Done

Once everything works and the user is satisfied, remind them to do a final smoke test on their own machine using the full production stack before deploying:

```bash
docker compose up
# Test the bot in Telegram, then Ctrl+C when done
```

This verifies the local bot-api integration (2GB upload limit, etc.) that can't be tested in Claude Code Web.

## Gotchas & Surprises

- Use `--no-check-certificates` when running yt-dlp.
- **Telegram `sendMessage` with `reply_markup`:** When using curl for testing, `reply_markup` must be sent as a URL-encoded JSON string in form data, NOT as part of a JSON body. JSON body with `reply_markup` returns 404 from Telegram's API. The Telegraf library handles this internally.
- **X/Twitter is banned:** The bot does not support X/Twitter for moral reasons. Do not add support for it.
