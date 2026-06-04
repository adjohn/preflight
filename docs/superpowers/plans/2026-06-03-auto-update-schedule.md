# Auto-Update Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily auto-update mechanism (launchd plist) configurable during `nr-ai-observe setup` and via a standalone `nr-ai-observe schedule` subcommand, with automatic removal on uninstall.

**Architecture:** A new `src/install/schedule.ts` module owns all launchd logic (write plist, load/unload, parse status). `cli.ts` adds a `schedule` subcommand and calls `removeSchedule()` from `handleUninstall`. `setup-wizard.ts` adds a step after the hooks install prompt. macOS-only — all entry points exit with a clear message on other platforms.

**Tech Stack:** Node.js `node:child_process` (`execFileSync`, `execSync`), `node:fs`, `node:os`, `node:path`; Jest/ts-jest for tests; launchd plist XML (string template, no XML library needed).

---

## File Map

| Action | Path                               | Purpose                                                                                          |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Create | `src/install/schedule.ts`          | All launchd logic: `installSchedule`, `removeSchedule`, `getScheduleStatus`, `resolveBinaryPath` |
| Create | `src/install/schedule.test.ts`     | Unit tests for all four exports                                                                  |
| Create | `src/install/cli.test.ts`          | Tests for `handleSchedule` and updated `handleUninstall`                                         |
| Modify | `src/install/cli.ts`               | Add `schedule` subcommand + `removeSchedule()` call in `handleUninstall`                         |
| Modify | `src/install/setup-wizard.ts`      | Auto-update step after hooks install                                                             |
| Modify | `src/install/setup-wizard.test.ts` | Add `./schedule.js` mock + new auto-update wizard tests                                          |

---

## Task 1: `src/install/schedule.ts` — launchd module (TDD)

**Files:**

- Create: `src/install/schedule.test.ts`
- Create: `src/install/schedule.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/install/schedule.test.ts`:

```typescript
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Prevent real launchctl calls.
jest.mock('node:child_process', () => ({ execFileSync: jest.fn(), execSync: jest.fn() }));
// Point homedir() at a throw-away temp tree.
const TEST_HOME = `/tmp/nr-schedule-test-${process.pid}`;
jest.mock('node:os', () => ({ homedir: () => TEST_HOME }));

import * as childProcess from 'node:child_process';
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  resolveBinaryPath,
} from './schedule.js';

const mockedExecFileSync = childProcess.execFileSync as jest.MockedFunction<
  typeof childProcess.execFileSync
>;
const mockedExecSync = childProcess.execSync as jest.MockedFunction<typeof childProcess.execSync>;

const PLIST_PATH = join(TEST_HOME, 'Library', 'LaunchAgents', 'com.nr-ai-observe.update.plist');

beforeAll(() => {
  mkdirSync(join(TEST_HOME, 'Library', 'LaunchAgents'), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  // Remove plist between tests.
  try {
    rmSync(PLIST_PATH);
  } catch {
    /* ok */
  }
});

describe('installSchedule', () => {
  it('writes a plist file to the LaunchAgents directory', () => {
    installSchedule('/usr/local/bin/nr-ai-observe', 8, 0);
    expect(existsSync(PLIST_PATH)).toBe(true);
  });

  it('embeds the binary path, hour, and minute in the plist', () => {
    installSchedule('/usr/local/bin/nr-ai-observe', 14, 30);
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<string>/usr/local/bin/nr-ai-observe</string>');
    expect(content).toContain('<integer>14</integer>');
    expect(content).toContain('<integer>30</integer>');
  });

  it('redirects stdout and stderr to update.log', () => {
    installSchedule('/usr/local/bin/nr-ai-observe', 8, 0);
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('.nr-ai-observe/update.log');
  });

  it('calls launchctl unload then load', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));
    installSchedule('/usr/local/bin/nr-ai-observe', 8, 0);
    const calls = mockedExecFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(calls.some((args) => args[0] === 'unload')).toBe(true);
    expect(calls.some((args) => args[0] === 'load')).toBe(true);
  });

  it('does not throw when launchctl unload fails (not yet loaded)', () => {
    mockedExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('not loaded');
      })
      .mockImplementation(() => Buffer.from(''));
    expect(() => installSchedule('/usr/local/bin/nr-ai-observe', 8, 0)).not.toThrow();
  });
});

describe('removeSchedule', () => {
  it('is a no-op when plist does not exist', () => {
    expect(() => removeSchedule()).not.toThrow();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('calls launchctl unload and deletes the plist', () => {
    installSchedule('/usr/local/bin/nr-ai-observe', 8, 0);
    mockedExecFileSync.mockClear();
    removeSchedule();
    const calls = mockedExecFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(calls.some((args) => args[0] === 'unload')).toBe(true);
    expect(existsSync(PLIST_PATH)).toBe(false);
  });
});

describe('getScheduleStatus', () => {
  it('returns installed:false when plist is absent', () => {
    expect(getScheduleStatus()).toEqual({ installed: false });
  });

  it('returns installed:true with hour, minute, binaryPath after install', () => {
    installSchedule('/usr/local/bin/nr-ai-observe', 9, 15);
    const status = getScheduleStatus();
    expect(status.installed).toBe(true);
    expect(status.hour).toBe(9);
    expect(status.minute).toBe(15);
    expect(status.binaryPath).toBe('/usr/local/bin/nr-ai-observe');
  });
});

describe('resolveBinaryPath', () => {
  it('returns the trimmed path string when which succeeds', () => {
    mockedExecSync.mockReturnValue(Buffer.from('/usr/local/bin/nr-ai-observe\n'));
    expect(resolveBinaryPath()).toBe('/usr/local/bin/nr-ai-observe');
  });

  it('returns null when which fails', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(resolveBinaryPath()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest -- src/install/schedule.test.ts
```

Expected: multiple failures — `schedule.js` does not exist yet.

- [ ] **Step 3: Implement `src/install/schedule.ts`**

```typescript
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const PLIST_LABEL = 'com.nr-ai-observe.update';

function plistPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function updateLogPath(): string {
  return resolve(homedir(), '.nr-ai-observe', 'update.log');
}

function buildPlist(binaryPath: string, hour: number, minute: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>update</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${updateLogPath()}</string>
  <key>StandardErrorPath</key>
  <string>${updateLogPath()}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`;
}

export interface ScheduleStatus {
  readonly installed: boolean;
  readonly hour?: number;
  readonly minute?: number;
  readonly binaryPath?: string;
}

export function installSchedule(binaryPath: string, hour: number, minute: number): void {
  const path = plistPath();
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(path, buildPlist(binaryPath, hour, minute), { mode: 0o600 });
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Not yet loaded — that's fine.
  }
  execFileSync('launchctl', ['load', path], { stdio: 'inherit' });
}

export function removeSchedule(): void {
  const path = plistPath();
  if (!existsSync(path)) return;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Already unloaded.
  }
  unlinkSync(path);
}

export function getScheduleStatus(): ScheduleStatus {
  const path = plistPath();
  if (!existsSync(path)) return { installed: false };
  try {
    const content = readFileSync(path, 'utf-8');
    const hourMatch = content.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const minuteMatch = content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    const binaryMatch = content.match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
    );
    return {
      installed: true,
      hour: hourMatch ? parseInt(hourMatch[1], 10) : undefined,
      minute: minuteMatch ? parseInt(minuteMatch[1], 10) : undefined,
      binaryPath: binaryMatch ? binaryMatch[1] : undefined,
    };
  } catch {
    return { installed: false };
  }
}

export function resolveBinaryPath(): string | null {
  try {
    return execSync('which nr-ai-observe', { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest -- src/install/schedule.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Lint**

```bash
npm run lint
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/install/schedule.ts src/install/schedule.test.ts
git commit -m "Feat: add schedule.ts launchd module with installSchedule/removeSchedule/getScheduleStatus"
```

---

## Task 2: `schedule` subcommand in `src/install/cli.ts` (TDD)

**Files:**

- Create: `src/install/cli.test.ts`
- Modify: `src/install/cli.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/install/cli.test.ts`:

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('node:fs', () => ({
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => false),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  copyFileSync: jest.fn(),
  realpathSync: jest.fn((p: unknown) => p),
}));
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn(),
}));
jest.mock('./schedule.js', () => ({
  installSchedule: jest.fn(),
  removeSchedule: jest.fn(),
  getScheduleStatus: jest.fn(() => ({ installed: false })),
  resolveBinaryPath: jest.fn(() => '/usr/local/bin/nr-ai-observe'),
}));
jest.mock('./install-helper.js', () => ({
  mergeSettings: jest.fn((s: unknown) => s),
  removeSettings: jest.fn((s: unknown) => s),
  mergeMcpConfig: jest.fn((s: unknown) => s),
  removeMcpConfig: jest.fn((s: unknown) => s),
  detectSettingsPath: jest.fn(() => '/tmp/settings.json'),
  detectMcpConfigPath: jest.fn(() => '/tmp/mcp.json'),
  generateNrConfig: jest.fn(() => ({})),
}));

import * as scheduleMod from './schedule.js';
import { runInstallCli } from './cli.js';

const mockedSchedule = scheduleMod as unknown as {
  installSchedule: jest.Mock;
  removeSchedule: jest.Mock;
  getScheduleStatus: jest.Mock;
  resolveBinaryPath: jest.Mock;
};

describe('schedule subcommand', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  const savedPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('prints status when no flags given and no schedule installed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: false });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('No auto-update schedule installed');
  });

  it('prints schedule time when already installed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({
      installed: true,
      hour: 9,
      minute: 30,
      binaryPath: '/usr/local/bin/nr-ai-observe',
    });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('09:30');
  });

  it('installs schedule with --time 08:00', async () => {
    await runInstallCli(['schedule', '--time', '08:00']);
    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith(
      '/usr/local/bin/nr-ai-observe',
      8,
      0,
    );
  });

  it('replaces existing schedule without prompting when --time given', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true, hour: 8, minute: 0 });
    await runInstallCli(['schedule', '--time', '09:30']);
    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith(
      '/usr/local/bin/nr-ai-observe',
      9,
      30,
    );
  });

  it('exits 1 when --time format is invalid', async () => {
    await expect(runInstallCli(['schedule', '--time', 'not-a-time'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });

  it('exits 1 when hour > 23', async () => {
    await expect(runInstallCli(['schedule', '--time', '25:00'])).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when minute > 59', async () => {
    await expect(runInstallCli(['schedule', '--time', '08:60'])).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when binary not on PATH', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue(null);
    await expect(runInstallCli(['schedule', '--time', '08:00'])).rejects.toThrow('process.exit(1)');
    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });

  it('removes schedule with --disable', async () => {
    await runInstallCli(['schedule', '--disable']);
    expect(mockedSchedule.removeSchedule).toHaveBeenCalled();
  });

  it('exits 1 on non-macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    await expect(runInstallCli(['schedule'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('macOS');
  });
});

describe('uninstall calls removeSchedule', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('calls removeSchedule during uninstall', async () => {
    await runInstallCli(['uninstall']);
    expect(mockedSchedule.removeSchedule).toHaveBeenCalled();
  });

  it('prints removal confirmation when plist existed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true });
    await runInstallCli(['uninstall']);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Auto-update schedule removed');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest -- src/install/cli.test.ts
```

Expected: failures — `schedule` command not registered; `removeSchedule` not called in uninstall.

- [ ] **Step 3: Add `resolveBinaryPath` import and `handleSchedule` to `cli.ts`**

Add this import near the top of `src/install/cli.ts` (after existing imports):

```typescript
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  resolveBinaryPath,
} from './schedule.js';
```

Add the `handleSchedule` function (insert before `handleInstall`):

```typescript
function handleSchedule(options: { time?: string; disable?: boolean }): void {
  if (process.platform !== 'darwin') {
    print('Auto-update scheduling is only supported on macOS.');
    process.exit(1);
  }

  if (options.disable) {
    const wasInstalled = getScheduleStatus().installed;
    removeSchedule();
    print(wasInstalled ? '✓ Auto-update schedule removed.' : 'No schedule was installed.');
    return;
  }

  if (options.time !== undefined) {
    const match = options.time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      print(`Invalid time format "${options.time}". Use HH:MM (e.g. 08:00).`);
      process.exit(1);
    }
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    if (hour > 23 || minute > 59) {
      print(`Invalid time "${options.time}": hour must be 0–23, minute 0–59.`);
      process.exit(1);
    }
    const binaryPath = resolveBinaryPath();
    if (!binaryPath) {
      print(
        '✗ nr-ai-observe not found on PATH. Fix PATH then run: nr-ai-observe schedule --time HH:MM',
      );
      process.exit(1);
    }
    installSchedule(binaryPath, hour, minute);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    print(`✓ Daily auto-update scheduled for ${hh}:${mm}.`);
    print(`  Log: ${homedir()}/.nr-ai-observe/update.log`);
    return;
  }

  // No flags — show status.
  const status = getScheduleStatus();
  if (status.installed) {
    const hh = String(status.hour ?? 0).padStart(2, '0');
    const mm = String(status.minute ?? 0).padStart(2, '0');
    print(`Auto-update schedule: ${hh}:${mm} daily`);
    print(`  Binary: ${status.binaryPath ?? 'unknown'}`);
    print('  To change: nr-ai-observe schedule --time HH:MM');
    print('  To remove: nr-ai-observe schedule --disable');
  } else {
    print('No auto-update schedule installed.');
    print('  To enable: nr-ai-observe schedule --time 08:00');
  }
}
```

Also add `homedir` to the existing `node:os` import at the top of `cli.ts`:

```typescript
import { homedir } from 'node:os';
```

- [ ] **Step 4: Register the `schedule` command in `createInstallProgram`**

In the `createInstallProgram` function in `cli.ts`, add the following after the `update` command registration:

```typescript
program
  .command('schedule')
  .description('Configure daily auto-updates via launchd (macOS only)')
  .option('--time <HH:MM>', 'Set the daily update time (24-hour format, e.g. 08:00)')
  .option('--disable', 'Remove the auto-update schedule')
  .action(handleSchedule);
```

- [ ] **Step 5: Update `handleUninstall` to call `removeSchedule`**

In `handleUninstall`, add these two lines at the end (after the MCP removal block, before the final "Restart Claude Code" print):

```typescript
const scheduleWasInstalled = getScheduleStatus().installed;
removeSchedule();
if (scheduleWasInstalled) print('✓ Auto-update schedule removed');
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
npx jest -- src/install/cli.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Lint and build**

```bash
npm run lint && npm run build
```

Expected: 0 errors, successful build.

- [ ] **Step 8: Commit**

```bash
git add src/install/cli.ts src/install/cli.test.ts
git commit -m "Feat: add schedule subcommand and remove schedule on uninstall"
```

---

## Task 3: Setup wizard auto-update step (TDD)

**Files:**

- Modify: `src/install/setup-wizard.test.ts`
- Modify: `src/install/setup-wizard.ts`

- [ ] **Step 1: Add `./schedule.js` mock and new tests to `setup-wizard.test.ts`**

At the top of `src/install/setup-wizard.test.ts`, add to the existing `jest.mock` block (after the `jest.mock('./cli.js', ...)` line):

```typescript
jest.mock('./schedule.js', () => ({
  installSchedule: jest.fn(),
  removeSchedule: jest.fn(),
  getScheduleStatus: jest.fn(() => ({ installed: false })),
  resolveBinaryPath: jest.fn(() => null),
}));
```

Add this import near the top (after the existing imports):

```typescript
import * as scheduleMod from './schedule.js';
```

Add this typed handle alongside the existing `mockedRl` / `mockedFs` declarations:

```typescript
const mockedSchedule = scheduleMod as unknown as {
  installSchedule: jest.Mock;
  resolveBinaryPath: jest.Mock;
};
```

Then add a new describe block at the bottom of the file:

```typescript
// ---------------------------------------------------------------------------
// Auto-update wizard step
// ---------------------------------------------------------------------------
describe('setupWizard auto-update step', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };
  const savedPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('{}');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  // Cloud mode: mode, accountId, licenseKey, developer, teamId, projectId,
  // sessionBudget, installHooks, autoUpdate, updateTime
  function cloudAnswers(...values: string[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => values[i++] ?? '');
  }

  it('calls installSchedule with parsed hour and minute when user accepts', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue('/usr/local/bin/nr-ai-observe');
    // answers: mode=cloud, accountId, licenseKey, developer, teamId, projectId,
    //          sessionBudget, installHooks=n, autoUpdate=y, updateTime=09:00
    cloudAnswers('', '12345', 'NRLIC-test', 'dev', '', '', '', 'n', 'y', '09:00');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith(
      '/usr/local/bin/nr-ai-observe',
      9,
      0,
    );
  });

  it('uses 08:00 as default time when user presses enter', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue('/usr/local/bin/nr-ai-observe');
    cloudAnswers('', '12345', 'NRLIC-test', 'dev', '', '', '', 'n', 'y', '');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith(
      '/usr/local/bin/nr-ai-observe',
      8,
      0,
    );
  });

  it('does not call installSchedule when user declines auto-update', async () => {
    cloudAnswers('', '12345', 'NRLIC-test', 'dev', '', '', '', 'n', 'n');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });

  it('prints PATH warning and skips installSchedule when binary not on PATH', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue(null);
    cloudAnswers('', '12345', 'NRLIC-test', 'dev', '', '', '', 'n', 'y', '08:00');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('PATH');
  });

  it('skips auto-update step entirely on non-macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // No auto-update answers needed — step is skipped.
    cloudAnswers('', '12345', 'NRLIC-test', 'dev', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
npx jest -- src/install/setup-wizard.test.ts --testNamePattern="auto-update"
```

Expected: failures — wizard does not yet have the auto-update step.

- [ ] **Step 3: Also confirm existing wizard tests still pass (baseline)**

```bash
npx jest -- src/install/setup-wizard.test.ts
```

Note the count of passing tests — you'll verify it stays the same at the end.

- [ ] **Step 4: Add the auto-update step to `setup-wizard.ts`**

Add this import to `src/install/setup-wizard.ts` (after the existing `import { runInstallCli, verifyBinaryOnPath } from './cli.js'` line):

```typescript
import { installSchedule, resolveBinaryPath } from './schedule.js';
```

Then in `runSetupWizard`, insert the following block **after** the existing "Step 6: Hook install" block (after the `print('Hooks installed.')` and PATH warning lines, before the "Step 7: Dashboard deploy" block). Replace the `// Step 7` comment with `// Step 8` to keep numbering consistent.

```typescript
// Step 7: Auto-update schedule (macOS only)
if (process.platform === 'darwin') {
  const enableUpdate = (await rl.question('\nEnable daily auto-updates? [Y/n]: '))
    .trim()
    .toLowerCase();
  if (enableUpdate !== 'n' && enableUpdate !== 'no') {
    const timeRaw = (await rl.question('Update time (24h HH:MM) [08:00]: ')).trim();
    const timeStr = timeRaw || '08:00';
    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    const hour = match ? parseInt(match[1], 10) : 8;
    const minute = match ? parseInt(match[2], 10) : 0;
    const binaryPath = resolveBinaryPath();
    if (binaryPath) {
      installSchedule(binaryPath, hour, minute);
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');
      print(`✓ Daily auto-update scheduled for ${hh}:${mm}.`);
    } else {
      print('\n⚠ Cannot schedule auto-updates — nr-ai-observe not found on PATH.');
      print('  Fix PATH then run: nr-ai-observe schedule --time 08:00');
    }
  }
}
```

- [ ] **Step 5: Run all wizard tests**

```bash
npx jest -- src/install/setup-wizard.test.ts
```

Expected: all tests (old and new) pass. Confirm the count of previously-passing tests is unchanged.

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Lint and build**

```bash
npm run lint && npm run build
```

Expected: 0 errors, successful build.

- [ ] **Step 8: Commit**

```bash
git add src/install/setup-wizard.ts src/install/setup-wizard.test.ts
git commit -m "Feat: add auto-update schedule step to setup wizard"
```

---

## Final Verification

- [ ] **Check the spec is fully covered**
  - `schedule.ts`: `installSchedule`, `removeSchedule`, `getScheduleStatus`, `resolveBinaryPath` — covered in Task 1
  - `schedule` CLI subcommand with `--time`, `--disable`, no-flag status — covered in Task 2
  - Uninstall removes plist — covered in Task 2 (Step 5)
  - Setup wizard auto-update step — covered in Task 3
  - macOS-only guard in both CLI and wizard — covered in Task 2 and Task 3
  - PATH-not-found handling in both CLI and wizard — covered

- [ ] **Confirm branch is clean**

```bash
git log --oneline main..HEAD
```

Expected: three feature commits on top of the spec commit.
