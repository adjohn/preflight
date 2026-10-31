---
'@newrelic/preflight': minor
---

Cursor, Windsurf, and Antigravity agents can now report exact token usage with `nr_observe_report_tokens`, and the cost is saved to the conversation that made the call. Preflight finds that conversation from the call's own hook event (Cursor, Windsurf) or its `_meta` (Antigravity), so the agent does not pass an id, and a report it cannot place is rejected rather than recorded.
