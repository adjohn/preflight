---
'@newrelic/preflight': patch
---

**GitHub Copilot hooks installed by `preflight install` failed on every tool call on Windows, so no Copilot data reached New Relic.** The hooks file now sets the `copilot` platform tag through the hook's `env` field instead of a `VAR=value` command prefix that PowerShell cannot parse, and gives PowerShell its own `powershell` command that calls the collector with `&`. macOS and Linux keep the plain `command`. Re-running `preflight install` replaces an existing hooks file in place.
