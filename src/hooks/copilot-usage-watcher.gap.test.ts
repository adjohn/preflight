import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

  it('counts an llm_request record whose single line exceeds the 4 MiB partial-line cap', () => {
    const bigLine = llmRequestLine('resp_big', { inputMessages: 'x'.repeat(6 * 1024 * 1024) });
    writeFileSync(logPath, bigLine + '\n');
    const watcher = makeWatcher();
    for (let i = 0; i < 10; i++) watcher.poll();
    expect(emittedMessageIds()).toEqual(['resp_big']);
  });

  it('still reads a session log untouched for longer than discoveryHours when it has unread bytes', () => {
    writeFileSync(logPath, llmRequestLine('resp_1') + '\n');
    makeWatcher().poll();

    writeFileSync(logPath, llmRequestLine('resp_1') + '\n' + llmRequestLine('resp_2') + '\n');
    const twoDaysAgo = (Date.now() - 48 * 3_600_000) / 1000;
    utimesSync(logPath, twoDaysAgo, twoDaysAgo);

    makeWatcher({}).poll();

    expect(emittedMessageIds()).toEqual(['resp_1', 'resp_2']);
  });

  it('retries a record after its buffer append failed instead of advancing the cursor past it', () => {
    writeFileSync(logPath, llmRequestLine('resp_1') + '\n');
    const bufPath = join(storagePath, `buffer-${SESSION_ID}.jsonl`);
    mkdirSync(bufPath, { recursive: true });
    makeWatcher().poll();

    rmSync(bufPath, { recursive: true, force: true });
    makeWatcher().poll();

    expect(emittedMessageIds()).toEqual(['resp_1']);
  });
});
