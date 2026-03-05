# mp4ify-bot

## Environment Variables

Set as secrets in Claude Code Web environment settings (before starting a session):

- `BOT_TOKEN` - Telegram bot token (from @BotFather)
- `OWNER_ID` - Telegram user ID of the bot owner (for e2e testing & notifications)

## Development Workflow

Follow these steps for every task. Do NOT skip steps.

### Step 1: Understand the task

Read the user's request. Identify which Telegram API features are involved.

### Step 2: Verify you have sufficient learning tests & mocks

Check `test/fixtures/real-payloads.json` and `test/learning-tests.test.ts`. If you are unsure EVEN A LITTLE about ANY aspect of how the Telegram API behaves for this task, do new empirical learning tests first:

1. Send OWNER_ID a Telegram message explaining what you need them to do
2. Poll `getUpdates` with a 30s timeout to capture their response
3. Add the new payload(s) to `real-payloads.json`
4. Add learning tests that document the payload structure
5. Update `MockBotApi` in `simulate-bot-api.ts` if needed

**IMPORTANT:** Reading the Telegram Bot API docs is good for orientation, but NEVER assume anything is true unless you have tested it empirically. The docs can be incomplete or misleading (e.g., inline query DMs use `chat_type: "sender"` not `"private"`).

**IMPORTANT:** Inline queries are real-time and do NOT queue up. The bot must be actively polling `getUpdates` at the moment the user types the inline query. Regular messages DO queue up and can be retrieved later.

### Step 3: Write acceptance tests

Before implementing, write tests that define the acceptance criteria for the task. Ask the user to confirm the tests capture the right behavior. Use `withBotApi` from `test/simulate-bot-api.ts` to run the bot against MockBotApi.

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

Send OWNER_ID a Telegram message explaining what to test. For inline query testing, you must be polling BEFORE the user types the query since inline queries don't queue up.

### Step 7: Iterate

If the e2e test reveals wrong assumptions or the user gives feedback, go back to Step 2. Update learning tests, mocks, and acceptance tests as needed.

### Step 8: Done

Once everything works and the user is satisfied, remind them to do a final smoke test on their own machine using the full production stack before deploying:

```bash
docker compose up
# Test the bot in Telegram, then Ctrl+C when done
```

This verifies the local bot-api integration (2GB upload limit, etc.) that can't be tested in Claude Code Web.
