# Skip embedded videos from news articles in group chats

## Problem
When a user posts a news article link in a group chat, yt-dlp's "generic" extractor sometimes finds an embedded video on the page and the bot downloads it. This is unwanted - the user shared an article, not a video.

## Approach
After `getInfo` returns, check if the `extractor` field is "generic" (case-insensitive). In group chats, silently skip these URLs (no download, no message). Private chats and inline queries continue to work normally.

## Changes

### 1. Add `extractor` to `VideoInfo` type (`src/download-video.ts`)
The `extractor` field is already used in `parseCaption` but not declared in the type. Add it as an optional string.

### 2. Add skip logic in `textMessageHandler` (`src/handlers.ts`)
After `getInfo` returns, check:
- If `isGroupChat` AND `info.extractor` matches "generic" (case-insensitive) → silently return (no download, no message, no error)

### 3. Acceptance tests (in `test/handlers.test.ts`)

1. **"silently skips generic extractor in group chat"** - Group chat message with URL where getInfo returns `extractor: "generic"`. Verify: no download, no sendVideo, no sendMessage, no reply.

2. **"silently skips generic:quoted-html extractor in group chat"** - Same but with `extractor: "generic:quoted-html"`. Verify same silent skip.

3. **"downloads generic extractor in private chat"** - Private chat message with URL where getInfo returns `extractor: "generic"`. Verify: normal download and sendVideo flow.

4. **"downloads known extractor in group chat"** - Group chat message with URL where getInfo returns `extractor: "youtube"`. Verify: normal download and sendVideo flow (regression test, already covered by existing tests).
