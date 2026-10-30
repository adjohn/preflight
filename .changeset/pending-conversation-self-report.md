---
'@newrelic/preflight': minor
---

Cursor, Windsurf, and Antigravity agents can now report exact token usage with `nr_observe_report_tokens` by passing `conversation_id`, and the cost is saved to that conversation's session. The session also keeps the reported thinking tokens.
