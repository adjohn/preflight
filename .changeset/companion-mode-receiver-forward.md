---
'@newrelic/preflight': patch
---

**Companion mode turns on when Claude Code exports through Preflight's OTLP receiver.** When the receiver is enabled, forwards to a New Relic endpoint, and Claude Code's OTel metrics endpoint points at it, Preflight now stops sending its own cost gauges and tags cost-bearing events with `cost_authority: 'external'`, so New Relic does not count that cost twice. `NR_AI_COMPANION_MODE` and the config file still take precedence, and `preflight doctor` reports the same result as the server.
