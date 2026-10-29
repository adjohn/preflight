import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotUsageWatcher } from './copilot-usage-watcher.js';

const STDERR_WRITE = process.stderr.write;
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE_HASH = '25108083c218e7e7032f161e4f9e5162';

function llmRequestLine(responseId: string, extraAttrs: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: 1786151170779,
    sid: SESSION_ID,
    type: 'llm_request',
    attrs: {
      model: 'claude-opus-4-7',
      responseId,
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 0,
      ...extraAttrs,
    },
  });
}

describe('CopilotUsageWatcher durability gaps', () => {
  let storagePath: string;
  let workspaceStorageRoot: string;
  let logPath: string;
  let cursorPath: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    storagePath = mkdtempSync(join(tmpdir(), 'copilot-gap-storage-'));
    workspaceStorageRoot = mkdtempSync(join(tmpdir(), 'copilot-gap-ws-'));
    const logDir = join(
      workspaceStorageRoot,
      WORKSPACE_HASH,
      'GitHub.copilot-chat',
      'debug-logs',
      SESSION_ID,
    );
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, 'main.jsonl');
    cursorPath = join(storagePath, `.copilot-usage-pos-${SESSION_ID}`);
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(workspaceStorageRoot, { recursive: true, force: true });
  });

  function emittedMessageIds(): string[] {
    const bufPath = join(storagePath, `buffer-${SESSION_ID}.jsonl`);
    if (!existsSync(bufPath)) return [];
    return readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { mode: string; messageId?: string })
      .filter((l) => l.mode === 'token')
      .map((l) => l.messageId ?? '');
  }

  function makeWatcher(overrides: { parentSessionId?: string } = { parentSessionId: SESSION_ID }) {
    return new CopilotUsageWatcher({
      storagePath,
      workspaceStorageRoots: [workspaceStorageRoot],
      ...overrides,
    });
  }

  it('does not re-emit already-emitted records when the cursor file is left empty by a crash', () => {
    writeFileSync(logPath, llmRequestLine('resp_1') + '\n' + llmRequestLine('resp_2') + '\n');
    makeWatcher().poll();
    expect(emittedMessageIds()).toEqual(['resp_1', 'resp_2']);

    // writeFileSync truncates before writing; a kill in between leaves an empty cursor.
    writeFileSync(cursorPath, '');
    makeWatcher().poll();

    expect(emittedMessageIds()).toEqual(['resp_1', 'resp_2']);
  });

  it('does not re-emit already-emitted records when the cursor file is truncated JSON', () => {
    writeFileSync(logPath, llmRequestLine('resp_1') + '\n' + llmRequestLine('resp_2') + '\n');
    makeWatcher().poll();

    writeFileSync(cursorPath, '{"bytePos":');
    makeWatcher().poll();

    expect(emittedMessageIds()).toEqual(['resp_1', 'resp_2']);
  });
});
