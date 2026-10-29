import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig } from './config.js';

const ENV_KEYS = [
  'NEW_RELIC_LICENSE_KEY',
  'NEW_RELIC_ACCOUNT_ID',
  'NR_AI_COMPANION_MODE',
  'NR_AI_MODE',
  'NR_AI_OTLP_RECEIVER_ENABLED',
  'NR_AI_OTLP_FORWARD_ENDPOINT',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
];

describe('companion mode when Claude Code exports through Preflight receiver', () => {
  let savedEnv: NodeJS.ProcessEnv;
  let dir: string;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const k of ENV_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'gap-otlp-'));
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns companion mode on when the receiver forwards Claude Code OTel to New Relic', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_MODE = 'cloud';
    process.env.NR_AI_OTLP_RECEIVER_ENABLED = 'true';
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_METRICS_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{}');

    const config = loadMcpConfig({ config: configPath });

    expect(config.otlp.receiverEnabled).toBe(true);
    expect(config.otlp.forwardEndpoint).toBe('https://otlp.nr-data.net');
    expect(config.companionMode).toBe(true);
  });

  function setup(extra: Record<string, string>) {
    process.env.NEW_RELIC_LICENSE_KEY = 'test-key';
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NR_AI_MODE = 'cloud';
    process.env.NR_AI_OTLP_RECEIVER_ENABLED = 'true';
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_METRICS_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    Object.assign(process.env, extra);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{}');
    return loadMcpConfig({ config: configPath });
  }

  it('stays off when the receiver forwards to a non-New Relic endpoint', () => {
    const config = setup({ NR_AI_OTLP_FORWARD_ENDPOINT: 'https://collector.example.com' });
    expect(config.companionMode).toBe(false);
  });

  it('stays off when the receiver is disabled', () => {
    const config = setup({ NR_AI_OTLP_RECEIVER_ENABLED: 'false' });
    expect(config.companionMode).toBe(false);
  });

  it('stays off when Claude Code exports to a port other than the receiver', () => {
    const config = setup({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9999' });
    expect(config.companionMode).toBe(false);
  });

  it('env NR_AI_COMPANION_MODE=false still wins over receiver detection', () => {
    const config = setup({ NR_AI_COMPANION_MODE: 'false' });
    expect(config.companionMode).toBe(false);
    expect(config.companionModeSource).toBe('env NR_AI_COMPANION_MODE');
  });
});
