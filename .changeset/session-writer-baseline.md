---
'@newrelic/preflight': patch
---

**Session cost no longer drops turns recorded before a session was identified or after a dashboard restart.** Cost a Preflight process recorded while its session id was still provisional, and parent-only cost a restarted `--local` dashboard recorded for a GitHub Copilot session, could be lost when the session was saved, because the saved total kept the larger of two figures instead of adding the new cost to it. The dashboard now starts each session's running total from what is already saved.
