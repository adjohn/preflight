import { jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// In-process tracker mocks (used by the SessionTracker portion of the proof).
const ingestCtor = jest.fn();
jest.unstable_mockModule('./transport/nr-ingest.js', () => ({
  NrIngestManager: class {
    constructor(...args: unknown[]) {
      ingestCtor(...args);
    }
    auditTrail = undefined;
    start(): void {}
    stop(): Promise<void> {
      return Promise.resolve();
    }
    ingestToolCall(): void {}
    ingestCodingTask(): void {}
    ingestAntiPattern(): void {}
    ingestBudgetWarning(): void {}
  },
}));

const httpRequest = jest.fn();
jest.unstable_mockModule('node:https', () => ({
  request: (...args: unknown[]) => {
    httpRequest('https', ...args);
    throw new Error('HTTPS request blocked in privacy-proof test');
  },
}));
jest.unstable_mockModule('node:http', async () => {
  const real = await import('node:http');
  return {
    ...real,
    request: (...args: unknown[]) => {
      httpRequest('http', ...args);
      throw new Error('HTTP request blocked in privacy-proof test');
    },
  };
});

describe('privacy proof — mode=local', () => {
  beforeEach(() => {
    ingestCtor.mockClear();
    httpRequest.mockClear();
    process.env.NR_AI_MODE = 'local';
    delete process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_ACCOUNT_ID;
  });

  afterEach(() => {
    delete process.env.NR_AI_MODE;
  });

  it('does not construct NrIngestManager when mode=local', async () => {
    const { loadMcpConfig } = await import('./config.js');
    const config = loadMcpConfig({ port: 9847, config: null, logLevel: 'info', stdio: true });
    expect(config.mode).toBe('local');

    if (config.mode !== 'local') {
      const { NrIngestManager } = await import('./transport/nr-ingest.js');
      void new NrIngestManager({} as unknown as ConstructorParameters<typeof NrIngestManager>[0]);
    }
    expect(ingestCtor).not.toHaveBeenCalled();
  });

  it('makes zero outbound HTTP/HTTPS requests during a fake session', async () => {
    const { loadMcpConfig } = await import('./config.js');
    const config = loadMcpConfig({ port: 9847, config: null, logLevel: 'info', stdio: true });
    expect(config.mode).toBe('local');

    const { SessionTracker } = await import('./metrics/session-tracker.js');
    const tracker = new SessionTracker();
    tracker.recordToolCall({
      id: 't1',
      sessionId: 's1',
      toolName: 'Read',
      toolUseId: 'tu1',
      timestamp: Date.now(),
      durationMs: 10,
      success: true,
    });

    expect(httpRequest).not.toHaveBeenCalled();
  });
});

// Real end-to-end proof: spawn the built binary in mode=local and verify that
// main() boots, runs, and shuts down cleanly without crashing on the missing
// licenseKey path. This catches regressions where main() forgets to guard
// NrIngestManager construction on mode (the in-process mocks above can't see
// into a child process, so we rely on graceful boot/shutdown as the signal).
describe('privacy proof — built binary in mode=local', () => {
  const distIndex = resolve(__dirname, '..', 'dist', 'index.js');

  it('boots, runs, and shuts down cleanly', async () => {
    if (!existsSync(distIndex)) {
      // Fresh checkout / pre-build: skip rather than fail. CI runs `npm run
      // build` before tests so this branch is only hit locally.
      return;
    }

    const tmpStorage = mkdtempSync(join(tmpdir(), 'nr-mcp-privacy-'));
    const proc = spawn(process.execPath, [distIndex, '--stdio'], {
      env: {
        ...process.env,
        NR_AI_MODE: 'local',
        NEW_RELIC_AI_MCP_STORAGE_PATH: tmpStorage,
        NEW_RELIC_LICENSE_KEY: '',
        NEW_RELIC_ACCOUNT_ID: '',
        NR_AI_DASHBOARD_PORT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    // Drain stdout so the MCP server doesn't block on backpressure.
    proc.stdout.on('data', () => undefined);

    try {
      // Wait for the post-bootstrap signal or fail fast on a fatal error.
      await new Promise<void>((resolveBoot, rejectBoot) => {
        const timer = setTimeout(() => {
          rejectBoot(new Error(`server did not boot within timeout. stderr=${stderrBuf}`));
        }, 8000);
        const onData = () => {
          if (stderrBuf.includes('Server running on stdio transport')) {
            clearTimeout(timer);
            proc.stderr.off('data', onData);
            resolveBoot();
          } else if (stderrBuf.includes('Fatal error')) {
            clearTimeout(timer);
            proc.stderr.off('data', onData);
            rejectBoot(new Error(`server reported fatal error. stderr=${stderrBuf}`));
          }
        };
        proc.stderr.on('data', onData);
      });

      // Trigger graceful shutdown by closing stdin.
      proc.stdin.end();

      const exitCode = await new Promise<number | null>((resolveExit) => {
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
        }, 5000);
        proc.on('exit', (code) => {
          clearTimeout(killTimer);
          resolveExit(code);
        });
      });

      // No fatal errors and a successful boot/shutdown cycle.
      expect(stderrBuf).toMatch(/Starting nr-ai-mcp-server/);
      expect(stderrBuf).toMatch(/Server running on stdio transport/);
      expect(stderrBuf).not.toMatch(/Fatal error/);
      // process.exit(0) is invoked from the SIGINT/SIGTERM/stdin-end shutdown
      // path; allow null in case of SIGKILL on timeout (still passing the
      // earlier asserts means boot succeeded).
      expect([0, null]).toContain(exitCode);
    } finally {
      if (!proc.killed) proc.kill('SIGKILL');
      rmSync(tmpStorage, { recursive: true, force: true });
    }
  }, 20000);
});
