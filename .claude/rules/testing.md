---
paths:
  - "test/**"
  - "**/*.test.ts"
---

# Testing

Mock only at boundaries we don't own. Everything we own or runs locally is
real: real filesystem (the test container has a writable /storage), real
child processes (stub executables on PATH, not `Bun.spawn` mocks; the one
exception is simulating the spawn API itself failing, which no on-PATH stub
can produce). Unowned network boundaries are mocked at the fetch layer: the
Telegram API via MockBotApi, the GitHub releases API via githubMock.

A bug that lives in real filesystem, process, or restart behaviour is
invisible to a mocked test. So every module seam gets at least one test that
exercises the real thing across it, and every system-component seam gets an
e2e test.
