import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { parseArgs, maskCredential } from './index.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('parseArgs()', () => {
  // Commander expects argv[0]=node binary, argv[1]=script name
  const base = ['node', 'nr-ai-mcp-server'];

  it('defaults port to 9847', () => {
    const opts = parseArgs([...base]);
    expect(opts.port).toBe(9847);
  });

  it('parses --port flag', () => {
    const opts = parseArgs([...base, '--port', '3000']);
    expect(opts.port).toBe(3000);
  });

  it('parses -p shorthand for port', () => {
    const opts = parseArgs([...base, '-p', '4000']);
    expect(opts.port).toBe(4000);
  });

  it('throws on non-numeric port', () => {
    expect(() => parseArgs([...base, '--port', 'foo'])).toThrow(/Invalid port/);
  });

  it('throws on out-of-range port', () => {
    expect(() => parseArgs([...base, '--port', '99999'])).toThrow(/Invalid port/);
  });

  it('defaults stdio to false', () => {
    const opts = parseArgs([...base]);
    expect(opts.stdio).toBe(false);
  });

  it('parses --stdio flag', () => {
    const opts = parseArgs([...base, '--stdio']);
    expect(opts.stdio).toBe(true);
  });

  it('defaults config to null', () => {
    const opts = parseArgs([...base]);
    expect(opts.config).toBeNull();
  });

  it('parses --config path', () => {
    const opts = parseArgs([...base, '--config', '/path/to/config.json']);
    expect(opts.config).toBe('/path/to/config.json');
  });

  it('parses -c shorthand for config', () => {
    const opts = parseArgs([...base, '-c', '/etc/nr.json']);
    expect(opts.config).toBe('/etc/nr.json');
  });

  it('defaults log-level to info', () => {
    const opts = parseArgs([...base]);
    expect(opts.logLevel).toBe('info');
  });

  it('parses --log-level flag', () => {
    const opts = parseArgs([...base, '--log-level', 'debug']);
    expect(opts.logLevel).toBe('debug');
  });

  it('parses -l shorthand for log-level', () => {
    const opts = parseArgs([...base, '-l', 'warn']);
    expect(opts.logLevel).toBe('warn');
  });

  it('parses all flags combined', () => {
    const opts = parseArgs([
      ...base,
      '--port',
      '9847',
      '--stdio',
      '--config',
      '/etc/nr.json',
      '--log-level',
      'error',
    ]);
    expect(opts.port).toBe(9847);
    expect(opts.stdio).toBe(true);
    expect(opts.config).toBe('/etc/nr.json');
    expect(opts.logLevel).toBe('error');
  });

  it('defaults validate to false', () => {
    const opts = parseArgs([...base]);
    expect(opts.validate).toBe(false);
  });

  it('parses --validate flag', () => {
    const opts = parseArgs([...base, '--validate']);
    expect(opts.validate).toBe(true);
  });

  it('--validate combined with --config is accepted', () => {
    const opts = parseArgs([...base, '--validate', '--config', '/etc/nr.json']);
    expect(opts.validate).toBe(true);
    expect(opts.config).toBe('/etc/nr.json');
  });

  it('--validate and --stdio are mutually exclusive', () => {
    expect(() => parseArgs([...base, '--validate', '--stdio'])).toThrow(/mutually exclusive/);
  });

  it('--validate and --local are mutually exclusive', () => {
    expect(() => parseArgs([...base, '--validate', '--local'])).toThrow(/mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// maskCredential()
// ---------------------------------------------------------------------------

describe('maskCredential()', () => {
  it('masks a normal-length key to first-4...last-4', () => {
    expect(maskCredential('ABCD1234567890WXYZ')).toBe('ABCD...WXYZ');
  });

  it('returns *** for keys of exactly 8 characters (would fully expose if unguarded)', () => {
    expect(maskCredential('ABCD1234')).toBe('***');
  });

  it('returns *** for keys shorter than 8 characters', () => {
    expect(maskCredential('SHORT')).toBe('***');
    expect(maskCredential('X')).toBe('***');
    expect(maskCredential('')).toBe('***');
  });

  it('masks a typical 40-char NR license key', () => {
    const key = 'a'.repeat(32) + 'b'.repeat(8);
    const result = maskCredential(key);
    expect(result).toBe('aaaa...bbbb');
    expect(result).not.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// F-137: CLI argument edge cases
// ---------------------------------------------------------------------------

describe('F-137: CLI argument edge cases', () => {
  const base = ['node', 'nr-ai-mcp-server'];

  it('--port=0 throws (zero is not a valid port)', () => {
    expect(() => parseArgs([...base, '--port', '0'])).toThrow(/Invalid port/);
  });

  it('--port=-1 throws (negative port)', () => {
    // Use = form so Commander doesn't interpret -1 as a flag token
    expect(() => parseArgs([...base, '--port=-1'])).toThrow(/Invalid port/);
  });

  it('--port=65536 throws (one above maximum)', () => {
    expect(() => parseArgs([...base, '--port', '65536'])).toThrow(/Invalid port/);
  });

  it('--port=1 is accepted (minimum valid port)', () => {
    const opts = parseArgs([...base, '--port', '1']);
    expect(opts.port).toBe(1);
  });

  it('--port=65535 is accepted (maximum valid port)', () => {
    const opts = parseArgs([...base, '--port', '65535']);
    expect(opts.port).toBe(65535);
  });

  it('--stdio combined with --port is accepted (no conflict in parseArgs)', () => {
    const opts = parseArgs([...base, '--stdio', '--port', '8080']);
    expect(opts.stdio).toBe(true);
    expect(opts.port).toBe(8080);
  });

  it('--config path with spaces is preserved verbatim', () => {
    const opts = parseArgs([...base, '--config', '/path/with spaces/config.json']);
    expect(opts.config).toBe('/path/with spaces/config.json');
  });

  it('--help causes process.exit(0)', () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null): never => {
        throw new Error(`exit:${_code}`);
      });
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(() => parseArgs([...base, '--help'])).toThrow('exit:0');
    } finally {
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('unknown flag causes Commander to exit with code 1', () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null): never => {
        throw new Error(`exit:${_code}`);
      });
    try {
      expect(() => parseArgs([...base, '--totally-unknown-flag'])).toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('stdio integration', () => {
  it('responds to MCP initialize handshake and lists tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { resolve } = await import('node:path');

    const binPath = resolve(__dirname, '..', 'dist', 'index.js');

    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath, '--stdio'],
      // NR_AI_DASHBOARD_PORT=0 → OS-assigned ephemeral, so this test is
      // safe to run when port 7777 is occupied (e.g. a developer running
      // their production instance on the same host). Enabled by F-004.
      env: { ...process.env, NR_AI_DASHBOARD_PORT: '0' },
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe('nr-ai-observability');

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('nr_observe_get_session_stats');
    expect(toolNames).toContain('nr_observe_get_session_timeline');
    expect(toolNames).toContain('nr_observe_report_tokens');

    await client.close();
  }, 30000);
});
