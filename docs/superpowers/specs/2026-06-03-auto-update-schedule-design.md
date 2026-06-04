# Auto-Update Scheduler Design

**Date:** 2026-06-03  
**Status:** Approved  
**Scope:** macOS only (launchd)

## Overview

Add a daily auto-update mechanism so users don't need to remember to run `nr-ai-observe update` manually. A launchd plist fires `nr-ai-observe update` (git pull + npm run build) at a user-configured time each day. The schedule is configured during `nr-ai-observe setup` and is also manageable via a standalone `nr-ai-observe schedule` subcommand. Uninstall removes the plist automatically.

## Module: `src/install/schedule.ts`

New module owning all launchd logic. No other file touches launchd directly.

**Public API:**

```typescript
installSchedule(binaryPath: string, hour: number, minute: number): void
removeSchedule(): void
getScheduleStatus(): { installed: boolean; hour?: number; minute?: number; binaryPath?: string }
```

**Details:**

- Plist label: `com.nr-ai-observe.update`
- Plist path: `~/Library/LaunchAgents/com.nr-ai-observe.update.plist`
- Binary path resolved at install time via `which nr-ai-observe` (absolute path embedded in plist — no dependency on launchd's restricted PATH)
- stdout/stderr both redirect to `~/.nr-ai-observe/update.log`
- `RunAtLoad` is `false` — only runs on schedule, not on login
- `installSchedule`: writes plist, then runs `launchctl unload` (no-op if not loaded) followed by `launchctl load` so changes take effect immediately
- `removeSchedule`: runs `launchctl unload`, then deletes the plist file. Idempotent — no-op if plist doesn't exist
- `getScheduleStatus`: reads the plist with `readFileSync` and extracts `Hour`, `Minute`, and the first `ProgramArguments` entry via regex on the XML text; returns `{ installed: false }` if the file doesn't exist

**Plist template:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nr-ai-observe.update</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/nr-ai-observe</string>
    <string>update</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/user/.nr-ai-observe/update.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/user/.nr-ai-observe/update.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

## CLI: `src/install/cli.ts`

**New `schedule` subcommand:**

```
nr-ai-observe schedule              # print current schedule status
nr-ai-observe schedule --time 08:00 # install or update the schedule
nr-ai-observe schedule --disable    # remove the launchd plist
```

- `--time` accepts `HH:MM` (24-hour). Defaults to `08:00` when `--time` is omitted and no schedule exists yet
- If a schedule already exists, `--time` replaces it (unload old plist, write new, load) — no confirmation prompt
- Without any flag: prints whether a schedule is installed and at what time
- `--disable`: calls `removeSchedule()`, prints confirmation
- If `nr-ai-observe` is not on PATH when installing: print warning and exit 1
- On non-macOS: print `Auto-update scheduling is only supported on macOS.` and exit 1

**Uninstall changes:**

`handleUninstall` calls `removeSchedule()` after removing hooks and MCP config. Prints `✓ Auto-update schedule removed` if the plist existed; silent no-op if not. No guard needed — `removeSchedule()` is idempotent.

## Setup Wizard: `src/install/setup-wizard.ts`

New step inserted after the existing "Install Claude Code hooks" step:

```
Enable daily auto-updates? [Y/n]:
Update time (24h HH:MM) [08:00]:
```

- Default: yes / 08:00
- If yes and binary is on PATH: calls `installSchedule(binaryPath, hour, minute)`, prints `✓ Daily auto-update scheduled for HH:MM`
- If yes but binary not on PATH: prints `⚠ Cannot schedule — nr-ai-observe not found on PATH. Run nr-ai-observe schedule --time HH:MM after fixing PATH.`
- If no: silently skips
- The existing dashboard/alert deploy instructions shift down one step
- `buildConfig` is unchanged — schedule state lives in the launchd plist, not `config.json`

## Error Handling

- `launchctl` failures are caught and surfaced as human-readable messages; the process exits 1
- Invalid `--time` format (not `HH:MM`, hour > 23, minute > 59) prints an error and exits 1
- macOS version: no version check needed — `launchctl load` has been stable since macOS 10.4

## Testing

- `schedule.ts` functions are unit-tested with mocked `execFileSync` and `writeFileSync`
- `getScheduleStatus` is tested against a fixture plist string
- Setup wizard schedule step is tested via the existing wizard test pattern (mock `readline`, assert `installSchedule` called with correct args)
- Uninstall test asserts `removeSchedule` is called
