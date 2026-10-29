---
'@newrelic/preflight': patch
---

**Preflight no longer loses GitHub Copilot usage records.** A Copilot request whose log line was larger than 4 MiB was dropped; its usage is now read from the start and end of the line, with memory bounded. A session log that went quiet for more than `discoveryHours` while it still had unread lines is now read. A record whose buffer write failed is retried instead of skipped. A chat-only Copilot session, with cost but no tool calls, is now saved to session history.
