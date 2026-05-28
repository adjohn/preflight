import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildConfig, runSetupWizard } from './setup-wizard.js';
import * as rlMod from 'node:readline/promises';
import * as fsMod from 'node:fs';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted above imports by jest at runtime).
// The buildConfig tests below are unaffected (pure function; no fs/readline).
// ---------------------------------------------------------------------------
jest.mock('node:readline/promises', () => ({ createInterface: jest.fn() }));
jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));
jest.mock('./cli.js', () => ({ runInstallCli: jest.fn() }));

// Typed handles to the mocked module functions.
const mockedFs = fsMod as unknown as {
  readFileSync: jest.Mock;
  writeFileSync: jest.Mock;
  mkdirSync: jest.Mock;
};
const mockedRl = rlMod as unknown as { createInterface: jest.Mock };

describe('buildConfig', () => {
  it('merges new fields with existing config', () => {
    const result = buildConfig(
      { appName: 'my-app', existingField: 'keep-me' },
      { accountId: '12345', licenseKey: 'nrlic', developer: 'alice', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(result.accountId).toBe('12345');
    expect(result.existingField).toBe('keep-me');
  });

  it('omits teamId when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('teamId');
  });

  it('includes teamId when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: 'eng', projectId: null, sessionBudgetUsd: null },
    );
    expect(result.teamId).toBe('eng');
  });

  it('omits projectId when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('projectId');
  });

  it('includes projectId when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: 'org/repo', sessionBudgetUsd: null },
    );
    expect(result.projectId).toBe('org/repo');
  });

  it('omits sessionBudgetUsd when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('sessionBudgetUsd');
  });

  it('includes sessionBudgetUsd when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: 5.0 },
    );
    expect(result.sessionBudgetUsd).toBe(5.0);
  });

  it('overwrites existing accountId with new value', () => {
    const result = buildConfig(
      { accountId: 'old', licenseKey: 'old-key' },
      { accountId: 'new', licenseKey: 'new-key', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(result.accountId).toBe('new');
    expect(result.licenseKey).toBe('new-key');
  });
});

// ---------------------------------------------------------------------------
// F-138: setup-wizard idempotency and env-detection tests
// ---------------------------------------------------------------------------
describe('F-138: setup-wizard idempotency and env-detection', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // Wires readline to answer prompts in sequence; defaults to '' (accept wizard default).
  // Wizard asks 7 questions: accountId, licenseKey, developer, teamId, projectId,
  // sessionBudget, installHooks.
  function sequenceAnswers(...answers: (string | undefined)[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => answers[i++] ?? '');
  }

  it('re-run with existing config preserves unrelated custom fields', async () => {
    const existingConfig = {
      accountId: '12345',
      licenseKey: 'NRLIC-existing',
      developer: 'alice',
      otlpEndpoint: 'https://otlp.example.com',  // not managed by wizard
      retainSessionsDays: 90,                      // not managed by wizard
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existingConfig));
    sequenceAnswers('', '', '', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.otlpEndpoint).toBe('https://otlp.example.com');
    expect(written.retainSessionsDays).toBe(90);
    expect(written.accountId).toBe('12345');
  });

  it('$USER env var auto-populates the developer name when existing config lacks one', async () => {
    const savedUser = process.env.USER;
    process.env.USER = 'Jane Doe';
    try {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ accountId: '99999', licenseKey: 'NRLIC-test' }),
      );
      sequenceAnswers('', '', '', '', '', '', 'n');

      await runSetupWizard();

      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson) as Record<string, unknown>;
      // normalizeDeveloperName('Jane Doe') → 'jane_doe'
      expect(written.developer).toBe('jane_doe');
    } finally {
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
    }
  });

  it('cancellation (readline rejection) before writeFileSync leaves config untouched', async () => {
    mockedFs.readFileSync.mockReturnValue('{}');
    mockRl.question.mockImplementation(() => Promise.reject(new Error('readline closed')));

    await expect(runSetupWizard()).rejects.toThrow('readline closed');

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('malformed JSON in existing config does not crash the wizard', async () => {
    mockedFs.readFileSync.mockReturnValue('not-valid-json{{{');
    sequenceAnswers('12345', 'NRLIC-test', 'testdev', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.accountId).toBe('12345');
    expect(written.licenseKey).toBe('NRLIC-test');
  });
});
