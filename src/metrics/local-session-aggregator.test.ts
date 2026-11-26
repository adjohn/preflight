import { describe, expect, it } from '@jest/globals';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
import { estimatedFromOf } from '../__test-utils__/estimated-from.js';
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localDateKey } from '../lib/date.js';
import { mergeSummaries, SessionStore, type FullSessionSummary } from '../storage/session-store.js';
import {
  collectCommitsAcrossRepos,
  LocalSessionAggregator,
  RepoNameResolver,
} from './local-session-aggregator.js';
import { backfillAgentId } from './agent-partition.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';
import { saveAsWriter } from '../__test-utils__/save-as-writer.js';

// git sets GIT_DIR/GIT_WORK_TREE for hook subprocesses, which override `-C
// <dir>` and would silently redirect these calls to the real repo instead of
// the isolated temp dir under test. See git-activity-recorder.test.ts.
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  return nodeSpawnSync(command, args, { ...options, env: CLEAN_ENV });
}

/** A `since` far enough back that every commit a test creates is in range. */
function farBackSince(): string {
  return new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
}

const REAL_ID = 'a143754c-f742-40b7-bf1a-7dc01ad1932f';

/** Stub resolver so tests never shell out to git. */
class StubRepoResolver extends RepoNameResolver {
  override resolve(): string | null {
    return 'acme/widgets';
  }
}

function summariesOf(agg: LocalSessionAggregator, outcome = 'in progress') {
  return agg.toSummaries({
    developer: 'tester',
    platform: 'copilot',
    outcome,
    repoResolver: new StubRepoResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
  });
}

describe('LocalSessionAggregator', () => {
  it('applies the outcome of a late post once, to the timeout record it replaces', () => {
    const agg = new LocalSessionAggregator();
    const timedOut = { id: 'r1', sessionId: REAL_ID, toolName: 'Agent', timestamp: 1000 };
    agg.recordToolCall({ ...timedOut, durationMs: null, success: false, errorType: 'timeout' });
    const late = { ...timedOut, toolUseId: 'toolu_1', durationMs: 180_000, success: true };
    agg.amendToolCall(late);
    agg.amendToolCall(late);
    agg.amendToolCall({ ...late, id: 'not-recorded' });

    const [summary] = summariesOf(agg, 'in progress');
    expect(summary?.toolCallCount).toBe(1);
    expect(summary?.toolSuccessRate).toBe(1);
    expect(summary?.timeline).toEqual([
      { timestamp: 1000, toolName: 'Agent', durationMs: 180_000, success: true },
    ]);
  });

  it('keeps two distinct calls that share a millisecond and a tool through a save and reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-collide-'));
    try {
      const agg = new LocalSessionAggregator();
      for (const toolUseId of ['toolu_a', 'toolu_b']) {
        const call = {
          id: toolUseId,
          toolUseId,
          sessionId: REAL_ID,
          toolName: 'Read',
          timestamp: 1000,
          durationMs: 5,
          success: true,
        };
        agg.recordToolCall(call);
      }
      const [summary] = summariesOf(agg) as unknown as FullSessionSummary[];
      expect(summary?.timeline).toHaveLength(2);

      const store = new SessionStore({ storagePath: dir });
      saveAsWriter(store, summary!);
      saveAsWriter(new SessionStore({ storagePath: dir }), summary!);
      expect(store.loadSession(REAL_ID)?.timeline).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('amends the right timeline entry after older entries were evicted, and skips an evicted one', () => {
    const agg = new LocalSessionAggregator();
    const timedOut = (id: string, timestamp: number) => ({
      id,
      sessionId: REAL_ID,
      toolName: 'Agent',
      toolUseId: `toolu_${id}`,
      timestamp,
      durationMs: null,
      success: false,
      errorType: 'timeout',
    });
    agg.recordToolCall(timedOut('evicted', 1));
    agg.recordToolCall(timedOut('kept', 2));
    for (let i = 3; i <= 10_001; i++) {
      const filler = { id: `f${i}`, sessionId: REAL_ID, toolName: 'Agent', timestamp: i };
      agg.recordToolCall(filler);
    }

    agg.amendToolCall({ ...timedOut('evicted', 1), durationMs: 111, success: true });
    const afterEvicted = summariesOf(agg)[0]?.timeline as Array<Record<string, unknown>>;
    expect(afterEvicted[0]).toMatchObject({ timestamp: 2, durationMs: null, success: false });

    agg.amendToolCall({ ...timedOut('kept', 2), durationMs: 222, success: true });
    const timeline = summariesOf(agg)[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]).toMatchObject({ timestamp: 2, durationMs: 222, success: true });
    expect(timeline[1]).toMatchObject({ timestamp: 3 });
  });
  it('keeps a failing post as a failure, with the error type it carries', () => {
    const agg = new LocalSessionAggregator();
    const timedOut = { id: 'r1', sessionId: REAL_ID, toolName: 'Agent', timestamp: 1000 };
    agg.recordToolCall({ ...timedOut, durationMs: null, success: false, errorType: 'timeout' });
    agg.amendToolCall({
      ...timedOut,
      toolUseId: 'toolu_1',
      durationMs: 5000,
      success: false,
      errorType: 'interrupted',
    });

    const [summary] = summariesOf(agg, 'in progress');
    expect(summary?.toolSuccessRate).toBe(0);
    expect(summary?.timeline).toEqual([
      {
        timestamp: 1000,
        toolName: 'Agent',
        durationMs: 5000,
        success: false,
        errorType: 'interrupted',
      },
    ]);
  });

  it('rolls tool calls up under the real session id', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 1000,
      success: true,
      cwd: '/repo',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 2000,
      success: true,
    });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 3000 });

    const [summary] = summariesOf(agg);
    expect(summary?.sessionId).toBe(REAL_ID);
    expect(summary?.toolCallCount).toBe(3);
    expect(summary?.toolBreakdown).toEqual({ run_in_terminal: 2, read_file: 1 });
    expect(summary?.startTime).toBe(1000);
    expect(summary?.endTime).toBe(3000);
    expect(summary?.durationMs).toBe(2000);
    expect(summary?.repoName).toBe('acme/widgets');
  });

  // Synthetic ids are MCP-internal bookkeeping; persisting them is exactly the
  // "confusing duplicate rows" case persistSession() already refuses.
  it.each(['local-1786389794360', 'proxy-123', 'pending-456'])(
    'ignores the synthetic session id %s',
    (syntheticId) => {
      const agg = new LocalSessionAggregator();
      agg.recordToolCall({ sessionId: syntheticId, toolName: 'run_in_terminal', timestamp: 1 });
      agg.recordTokenUsage(syntheticId, { costUsd: 5, inputTokens: 100 });
      expect(agg.size()).toBe(0);
      expect(summariesOf(agg)).toEqual([]);
    },
  );

  it('keeps sessions separate so one window\u2019s chats do not merge', () => {
    const other = 'b0000000-0000-4000-8000-000000000000';
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 2 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 3 });

    const byId = new Map(summariesOf(agg).map((s) => [s.sessionId, s.toolCallCount]));
    expect(byId.get(REAL_ID)).toBe(1);
    expect(byId.get(other)).toBe(2);
  });

  // Regression guard: a session's own records carry its true platform
  // (e.g. a Copilot session drained by an unrelated generic-mcp dashboard
  // process); that must win over toSummaries()'s context.platform, which
  // only reflects the *draining* process's own environment.
  it("prefers the session's own record platform over the draining process's context platform", () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 1,
      platform: 'copilot',
    });

    const [summary] = agg.toSummaries({
      developer: 'tester',
      platform: 'generic-mcp',
      outcome: 'in progress',
      repoResolver: new StubRepoResolver(),
      toolSelectionScorer: new ToolSelectionScorer(),
    });
    expect(summary?.platform).toBe('copilot');
  });

  it('falls back to the context platform when no record carries one', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'run_in_terminal', timestamp: 1 });

    const [summary] = summariesOf(agg);
    expect(summary?.platform).toBe('copilot');
  });

  it('keeps the first non-null platform seen across a session’s records', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 1,
      platform: 'copilot',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 2,
      platform: 'copilot-sdk',
    });

    const [summary] = summariesOf(agg);
    expect(summary?.platform).toBe('copilot');
  });

  it('attributes token cost to the session that incurred it', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, {
      costUsd: 0.25,
      model: 'claude-opus-4.8',
      inputTokens: 1000,
      outputTokens: 50,
      timestamp: 2,
    });
    agg.recordTokenUsage(REAL_ID, { costUsd: 0.75, model: 'claude-opus-4.8', inputTokens: 10 });

    const [summary] = summariesOf(agg);
    expect(summary?.estimatedCostUsd).toBeCloseTo(1.0);
    expect(summary?.tokensInput).toBe(1010);
    expect(summary?.tokensOutput).toBe(50);
    expect(summary?.model).toBe('claude-opus-4.8');
  });

  it('counts unpriced-model calls on the session that made them', () => {
    const other = 'b0000000-0000-4000-8000-000000000000';
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-foo-9-9', inputTokens: 100, outputTokens: 20 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-foo-9-9', inputTokens: 30 });
    agg.recordTokenUsage(other, { costUsd: 0.01, model: 'claude-sonnet-5', inputTokens: 100 });

    const byId = new Map(summariesOf(agg).map((s) => [s.sessionId, s]));
    expect(byId.get(REAL_ID)?.unpricedByModel).toEqual({
      'claude-foo-9-9': { calls: 2, tokens: 150 },
    });
    expect(byId.get(other)?.unpricedByModel).toBeUndefined();
  });

  it('buckets unpriced-model calls by the local day of each usage timestamp', () => {
    const agg = new LocalSessionAggregator();
    const dayOne = new Date(2026, 10, 5, 12).getTime();
    const dayTwo = new Date(2026, 10, 6, 12).getTime();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: dayOne });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-foo-9-9', inputTokens: 100, timestamp: dayOne });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-foo-9-9', inputTokens: 30, timestamp: dayTwo });

    const [summary] = summariesOf(agg);
    expect(summary?.unpricedByDay).toEqual({
      '2026-11-05': { 'claude-foo-9-9': { calls: 1, tokens: 100 } },
      '2026-11-06': { 'claude-foo-9-9': { calls: 1, tokens: 30 } },
    });
  });

  it('buckets family-priced calls by day beside their session total', () => {
    const agg = new LocalSessionAggregator();
    const dayOne = new Date(2026, 10, 5, 12).getTime();
    const dayTwo = new Date(2026, 10, 6, 12).getTime();
    const estimatedFrom = estimatedFromOf('claude-opus-5-9');
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: dayOne });
    agg.recordTokenUsage(REAL_ID, {
      model: 'claude-opus-5-9',
      inputTokens: 100,
      timestamp: dayOne,
    });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-opus-5-9', inputTokens: 30, timestamp: dayTwo });

    const [summary] = summariesOf(agg);
    expect(summary?.estimatedByModel).toEqual({
      'claude-opus-5-9': { calls: 2, tokens: 130, estimatedFrom },
    });
    expect(summary?.estimatedByDay).toEqual({
      '2026-11-05': { 'claude-opus-5-9': { calls: 1, tokens: 100, estimatedFrom } },
      '2026-11-06': { 'claude-opus-5-9': { calls: 1, tokens: 30, estimatedFrom } },
    });
  });

  it('omits every call-count field for a session with only priced calls', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 0.01, model: 'claude-sonnet-5', inputTokens: 100 });

    const [summary] = summariesOf(agg);
    expect(summary?.tokensInput).toBe(100);
    expect(
      Object.keys(summary ?? {}).filter((k) => /^(unpriced|estimated)By(Model|Day)$/.test(k)),
    ).toEqual([]);
  });

  it('counts family-priced calls on the session that made them', () => {
    const other = 'b0000000-0000-4000-8000-000000000000';
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordToolCall({ sessionId: other, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-opus-5-9', inputTokens: 100, outputTokens: 20 });
    agg.recordTokenUsage(REAL_ID, { model: 'claude-opus-5-9', inputTokens: 30 });
    agg.recordTokenUsage(other, { costUsd: 0.01, model: 'claude-sonnet-5', inputTokens: 100 });

    const byId = new Map(summariesOf(agg).map((s) => [s.sessionId, s]));
    expect(byId.get(REAL_ID)?.estimatedByModel).toEqual({
      'claude-opus-5-9': {
        calls: 2,
        tokens: 150,
        estimatedFrom: estimatedFromOf('claude-opus-5-9'),
      },
    });
    expect(byId.get(REAL_ID)?.unpricedByModel).toBeUndefined();
    expect(byId.get(other)?.estimatedByModel).toBeUndefined();
  });

  it('leaves model null when a session spans several models', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, model: 'claude-opus-4.8' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, model: 'claude-sonnet-4.6' });
    expect(summariesOf(agg)[0]?.model).toBeNull();
  });

  it('emits a summary for a chat-only session that recorded cost', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, inputTokens: 500 });
    expect(agg.size()).toBe(1);
    expect(summariesOf(agg)).toHaveLength(1);
    expect(summariesOf(agg)[0]).toMatchObject({ sessionId: REAL_ID, estimatedCostUsd: 2 });
  });

  it('does not emit a summary for a session with no tool calls and no usage', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {});
    expect(summariesOf(agg)).toEqual([]);
  });

  it('reports cost as null rather than zero when nothing was spent', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    expect(summariesOf(agg)[0]?.estimatedCostUsd).toBeNull();
  });

  it('tracks success rate and modified files', () => {
    const agg = new LocalSessionAggregator();
    // toolName here is the canonical (already-mapped) name — recordToolCall
    // receives the same rawRecord TaskDetector does, and TaskDetector's own
    // Read-vs-Write/Edit gating (task-detector.ts) requires this shape.
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Edit', timestamp: 1, filePath: '/a.ts' });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Edit', timestamp: 2, filePath: '/a.ts' });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Edit',
      timestamp: 3,
      filePath: '/b.ts',
      success: false,
    });

    const [summary] = summariesOf(agg);
    expect(summary?.filesModified).toEqual(['/a.ts', '/b.ts']);
    expect(summary?.toolSuccessRate).toBeCloseTo(2 / 3);
  });

  it('classifies a Read call as filesRead, not filesModified — a read-only exploration session must not look like it edited files', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: 1, filePath: '/c.ts' });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Write', timestamp: 2, filePath: '/d.ts' });

    const [summary] = summariesOf(agg);
    expect(summary?.filesRead).toEqual(['/c.ts']);
    expect(summary?.filesModified).toEqual(['/d.ts']);
  });

  it('carries the outcome through so periodic saves are not marked completed', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    expect(summariesOf(agg, 'in progress')[0]?.outcome).toBe('in progress');
    expect(summariesOf(agg, 'completed')[0]?.outcome).toBe('completed');
  });

  it('exposes distinct cwds for git repo discovery', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'x', timestamp: 1, cwd: '/one' });
    agg.recordToolCall({
      sessionId: 'c0000000-0000-4000-8000-000000000000',
      toolName: 'x',
      timestamp: 2,
      cwd: '/two',
    });
    expect(agg.cwds().sort()).toEqual(['/one', '/two']);
  });
});

describe('collectCommitsAcrossRepos', () => {
  let repoDir: string;
  let initialBranch: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join('/tmp', 'collect-commits-'));
    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    initialBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    })
      .stdout.toString()
      .trim();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('attributes a commit on a branch that is not checked out to the root (the --branches pass)', () => {
    spawnSync('git', ['checkout', '-b', 'feature'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['commit', '--allow-empty', '-m', 'feature work'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    const featureHash = spawnSync('git', ['rev-parse', 'feature'], {
      cwd: repoDir,
      encoding: 'utf-8',
    })
      .stdout.toString()
      .trim();
    // Back on the original branch — 'feature' still exists but isn't checked
    // out, and isn't HEAD, so the HEAD-only pass 1 can't see its commit.
    spawnSync('git', ['checkout', initialBranch], { cwd: repoDir, stdio: 'ignore' });

    const commits = collectCommitsAcrossRepos([repoDir], farBackSince(), null);
    const featureCommit = commits.find((c) => c.hash === featureHash);

    expect(featureCommit).toBeDefined();
    expect(featureCommit?.root).toBe(repoDir);
  });

  it('attributes a commit seen from both a linked worktree and the primary checkout to the primary', () => {
    const initHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
      .stdout.toString()
      .trim();
    const worktreeParent = mkdtempSync(join('/tmp', 'collect-commits-wt-'));
    const worktreeDir = join(worktreeParent, 'wt');
    try {
      spawnSync('git', ['worktree', 'add', '-b', 'feature-wt', worktreeDir], {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Worktree passed FIRST — collectCommitsAcrossRepos must still reorder
      // primaries first internally, not trust caller order.
      const commits = collectCommitsAcrossRepos([worktreeDir, repoDir], farBackSince(), null);
      const initCommits = commits.filter((c) => c.hash === initHash);

      expect(initCommits).toHaveLength(1);
      expect(initCommits[0].root).toBe(repoDir);
    } finally {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  });
});

describe('LocalSessionAggregator timeline persistence', () => {
  it('emits a replayable timeline entry per tool call', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'run_in_terminal',
      timestamp: 100,
      durationMs: 42,
      success: true,
      command: 'npm test',
      isTestCommand: true,
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      timestamp: 100,
      toolName: 'run_in_terminal',
      durationMs: 42,
      success: true,
      command: 'npm test',
      isTestCommand: true,
    });
  });

  it('persists the created PR number so a replay can match it to a later merge', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 100,
      command: 'gh pr create --fill',
      createdPrNumber: '42',
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.createdPrNumber).toBe('42');
  });

  it('persists the created PR repo lowercased, and drops a malformed one', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 100,
      command: 'gh pr create --fill',
      createdPrNumber: '42',
      createdPrRepo: 'Acme/App',
    });
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 200,
      command: 'gh pr create --fill',
      createdPrNumber: '43',
      createdPrRepo: 'not a repo',
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline.map((e) => e.createdPrRepo)).toEqual(['acme/app', undefined]);
  });

  it('persists the PR target of a GitHub MCP PR call', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'mcp__github__merge_pull_request',
      timestamp: 100,
      mcpPrNumber: '12',
      mcpPrRepo: 'acme/app',
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]).toMatchObject({ mcpPrNumber: '12', mcpPrRepo: 'acme/app' });
  });

  it('persists a background run, whose success predates the command finishing', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 100,
      command: 'gh pr merge 42',
      runInBackground: true,
    });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Bash', timestamp: 200, command: 'ls' });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.runInBackground).toBe(true);
    expect(timeline[1]).not.toHaveProperty('runInBackground');
  });

  it('omits the timeline entirely when nothing was recorded for it', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as unknown[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).not.toHaveProperty('command');
  });

  it('records failures so replay can distinguish them', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'edit', timestamp: 1, success: false });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.success).toBe(false);
  });

  it('threads agentId onto the timeline entry so replay can partition by agent', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'edit',
      timestamp: 1,
      agentId: 'agent-a',
    });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.agentId).toBe('agent-a');
  });

  it('omits agentId when the tool call was made by the parent session', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'edit', timestamp: 1 });
    const timeline = summariesOf(agg, 'in progress')[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]).not.toHaveProperty('agentId');
  });
});

describe('LocalSessionAggregator panel rehydration', () => {
  it('emits modelBreakdown, qualityProxy and toolSelectionMetrics', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 1000,
      success: true,
    } as never);
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 2000,
      success: true,
    } as never);
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheCreationTokens: 40,
      costUsd: 0.5,
    } as never);
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 50,
      outputTokens: 10,
      costUsd: 0.25,
    } as never);

    const [summary] = summariesOf(agg);
    expect(summary?.modelBreakdown).toEqual({
      'gpt-5': {
        requestCount: 2,
        totalInputTokens: 150,
        totalOutputTokens: 30,
        totalCostUsd: 0.75,
        totalCacheReadTokens: 800,
        totalCacheCreationTokens: 40,
        totalThinkingTokens: 0,
      },
    });
    const quality = summary?.qualityProxy as { totalSignals: number } | undefined;
    expect(quality).toBeDefined();
    expect(typeof quality?.totalSignals).toBe('number');
    const toolSelection = summary?.toolSelectionMetrics as { totalCalls: number } | null;
    expect(toolSelection?.totalCalls).toBe(2);
  });

  it('scores tool selection with each call attributed to its subagent by backfillRecord', () => {
    const agg = new LocalSessionAggregator();
    for (const [i, toolUseId] of ['toolu_a', 'toolu_b', 'toolu_c'].entries()) {
      agg.recordToolCall({
        id: `r${i}`,
        sessionId: REAL_ID,
        toolName: 'Read',
        filePath: '/src/shared.ts',
        toolUseId,
        timestamp: 1000 + i * 1000,
        success: true,
      } as never);
    }
    const redundantReads = (
      backfillRecord?: Parameters<LocalSessionAggregator['toSummaries']>[0]['backfillRecord'],
    ) => {
      const [summary] = agg.toSummaries({
        developer: 'tester',
        outcome: 'in progress',
        repoResolver: new StubRepoResolver(),
        toolSelectionScorer: new ToolSelectionScorer(),
        ...(backfillRecord && { backfillRecord }),
      });
      const metrics = summary?.toolSelectionMetrics as {
        totalCalls: number;
        redundantReadCount: number;
      };
      expect(metrics.totalCalls).toBe(3);
      return metrics.redundantReadCount;
    };
    const agentByToolUse = new Map([
      ['toolu_a', 'agent-1'],
      ['toolu_b', 'agent-2'],
      ['toolu_c', 'agent-3'],
    ]);

    expect(redundantReads()).toBe(1);
    expect(redundantReads((r) => backfillAgentId(r, agentByToolUse))).toBe(0);
  });

  it('carries the cache savings of recorded token usage into the summary', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'read_file',
      timestamp: 1000,
      success: true,
    } as never);
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      cacheReadTokens: 5000,
      costUsd: 0.01,
      cacheSavingsUsd: 0.0135,
    });
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      cacheReadTokens: 1000,
      costUsd: 0.01,
      cacheSavingsUsd: 0.0027,
    });

    const [summary] = summariesOf(agg);
    expect(summary?.cacheSavingsUsd).toBeCloseTo(0.0162, 10);
  });

  it('emits a token-only session so its cost is persisted', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    expect(summariesOf(agg)).toHaveLength(1);
  });
});

describe('LocalSessionAggregator cross-repo git discovery', () => {
  it('exposes a repo targeted only by git -C, which no cwd would reveal', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 1000,
      success: true,
      cwd: '/home/u/aic',
      command: 'git -C /home/u/other-repo status --short',
    } as never);
    expect(agg.cwds().sort()).toEqual(['/home/u/aic', '/home/u/other-repo']);
  });

  it('does not treat a non-git command as a repo target', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Bash',
      timestamp: 1000,
      success: true,
      cwd: '/home/u/aic',
      command: 'npm run build',
    } as never);
    expect(agg.cwds()).toEqual(['/home/u/aic']);
  });
});

describe('LocalSessionAggregator subagent cost', () => {
  it('routes agentId-tagged usage into subagentCostUsd and subagentCostByDayUsd, while also counting it in costByDayUsd', () => {
    const agg = new LocalSessionAggregator();
    const ts = Date.parse('2026-09-11T12:00:00Z');
    agg.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: ts, agentId: 'agent-1' });

    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostUsd).toBe(2);
    const dayKey = localDateKey(ts);
    expect(summary?.costByDayUsd).toEqual({ [dayKey]: 2 });
    expect(summary?.subagentCostByDayUsd).toEqual({ [dayKey]: 2 });
  });

  it('does not touch subagent fields for agentId-less (parent) usage', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 3, timestamp: 1000 });
    // Parent-token-only usage has no tool calls, so it still doesn't emit —
    // add a tool call so the summary is inspectable.
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });

    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostUsd).toBe(0);
    expect(summary?.subagentCostByDayUsd).toBeUndefined();
    expect(summary?.costByDayUsd).toEqual({ [localDateKey(1000)]: 3 });
  });

  it('emits a summary for a subagent-only rollup with zero tool calls', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 5, timestamp: 1000, agentId: 'agent-1' });

    const summaries = summariesOf(agg);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.toolCallCount).toBe(0);
    expect(summaries[0]?.subagentCostUsd).toBe(5);
    expect(summaries[0]?.estimatedCostUsd).toBe(5);
  });

  it('buckets subagent cost by the turn timestamp, splitting a run across two day keys', () => {
    const agg = new LocalSessionAggregator();
    const day1 = Date.parse('2026-09-10T12:00:00Z');
    // 48h later guarantees a different local calendar date regardless of the
    // test runner's timezone offset (unlike a 2h gap, which can land on the
    // same local day depending on the offset).
    const day2 = day1 + 48 * 60 * 60 * 1000;
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: day1, agentId: 'agent-1' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 4, timestamp: day2, agentId: 'agent-1' });

    const [summary] = summariesOf(agg);
    expect(summary?.subagentCostByDayUsd).toEqual({
      [localDateKey(day1)]: 1,
      [localDateKey(day2)]: 4,
    });
    expect(summary?.subagentCostUsd).toBe(5);
  });

  it('keeps subagent reasoning tokens out of the persisted tokensThinking', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {
      costUsd: 1,
      timestamp: 1000,
      inputTokens: 10,
      thinkingTokens: 40,
      agentId: 'agent-1',
      model: 'claude-sonnet-4-6',
    });

    const [summary] = summariesOf(agg);
    expect(summary?.tokensThinking).toBe(0);
  });

  it('takes the platform of a token usage that arrives first, and keeps it afterwards', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, inputTokens: 10, platform: 'cursor' });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, inputTokens: 10, platform: 'windsurf' });

    const [summary] = summariesOf(agg);
    expect(summary?.platform).toBe('cursor');
  });

  it('omits costByDayUsd (undefined, not {}) for a rollup with only tool calls and no token usage', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: 1 });

    const [summary] = summariesOf(agg);
    expect(summary?.costByDayUsd).toBeUndefined();
    expect(summary?.subagentCostByDayUsd).toBeUndefined();
    expect(summary?.firstActivityByDayMs).toBeUndefined();
  });

  it('leaves $0 usage out of firstActivityByDayMs', () => {
    const agg = new LocalSessionAggregator();
    const firstSpend = Date.parse('2026-09-10T12:00:00Z');
    agg.recordTokenUsage(REAL_ID, { costUsd: 0, timestamp: firstSpend - 60_000 });
    agg.recordTokenUsage(REAL_ID, { timestamp: firstSpend - 30_000 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: firstSpend });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: firstSpend });

    const [summary] = summariesOf(agg);
    expect(summary?.firstActivityByDayMs).toEqual({ [localDateKey(firstSpend)]: firstSpend });
  });

  it('records the earliest token event per local day as firstActivityByDayMs', () => {
    const agg = new LocalSessionAggregator();
    const day1 = Date.parse('2026-09-10T12:00:00Z');
    const day2 = day1 + 48 * 60 * 60 * 1000;
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: day1 + 60_000 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: day1 });
    agg.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: day2 });
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: day1 - 60_000 });

    const [summary] = summariesOf(agg);
    expect(summary?.firstActivityByDayMs).toEqual({
      [localDateKey(day1)]: day1,
      [localDateKey(day2)]: day2,
    });
  });
});

describe('LocalSessionAggregator unsaved rollups', () => {
  it.each([
    [
      'a tool call',
      (agg: LocalSessionAggregator) =>
        agg.recordToolCall({ sessionId: 'conv-a', toolName: 'Edit', timestamp: 2000 }),
    ],
    [
      'a self-report',
      (agg: LocalSessionAggregator) =>
        agg.recordTokenUsage('conv-a', { timestamp: 2000, inputTokens: 10, selfReported: true }),
    ],
    [
      'subagent usage',
      (agg: LocalSessionAggregator) =>
        agg.recordTokenUsage('conv-a', { timestamp: 2000, costUsd: 1, agentId: 'agent-1' }),
    ],
  ])('is unsaved from creation, clean once saved, and unsaved again after %s', (_label, change) => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: 'conv-a', toolName: 'Read', timestamp: 1000 });
    const states = [agg.isUnsaved('conv-a')];
    agg.markSaved('conv-a');
    states.push(agg.isUnsaved('conv-a'));
    change(agg);
    states.push(agg.isUnsaved('conv-a'));

    expect(states).toEqual([true, false, true]);
  });

  it('summarizes a self-report that carries no tokens', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { timestamp: 1000, selfReported: true });

    expect(summariesOf(agg)).toMatchObject([{ sessionId: REAL_ID, selfReportCount: 1 }]);
  });

  it('is unsaved again after a late result amends a failed call', () => {
    const agg = new LocalSessionAggregator();
    const call = { sessionId: 'conv-a', id: 'call-1', toolName: 'Read', timestamp: 1000 };
    agg.recordToolCall({ ...call, success: false });
    agg.markSaved('conv-a');

    agg.amendToolCall({ ...call, success: true, durationMs: 5 } as never);

    expect(agg.isUnsaved('conv-a')).toBe(true);
  });

  it('summarizes a rollup that holds only a self-report', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { timestamp: 1000, inputTokens: 10, selfReported: true });

    expect(summariesOf(agg)).toMatchObject([{ sessionId: REAL_ID, selfReportCount: 1 }]);
  });

  it('never makes a rollup for an id that cannot name a session file', () => {
    const agg = new LocalSessionAggregator();
    for (const id of ['bad id!', 'unknown', 'conv-a'])
      agg.recordToolCall({ sessionId: id, toolName: 'Read', timestamp: 1000 });

    expect(summariesOf(agg).map((s) => s.sessionId)).toEqual(['conv-a']);
  });
});

describe('LocalSessionAggregator first spend of a day against a saved file', () => {
  const MORNING = new Date().setHours(9, 0, 0, 0);
  const RESTART = new Date().setHours(14, 6, 0, 0);
  const DAY_KEY = localDateKey(MORNING);

  function savedFile(overrides: Partial<FullSessionSummary>): FullSessionSummary {
    const writer = new LocalSessionAggregator();
    writer.recordToolCall({
      sessionId: REAL_ID,
      toolName: 'Read',
      timestamp: MORNING,
      success: true,
    });
    const [base] = summariesOf(writer) as unknown as FullSessionSummary[];
    const { firstActivityByDayMs: _dropped, ...legacy } = base!;
    return { ...legacy, ...overrides };
  }

  function restartedSummary(): FullSessionSummary {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, { costUsd: 3, timestamp: RESTART });
    const [incoming] = summariesOf(agg) as unknown as FullSessionSummary[];
    return incoming!;
  }

  it('saves no first spend for a day a legacy file already spent on', () => {
    const file = savedFile({ estimatedCostUsd: 2, costByDayUsd: { [DAY_KEY]: 2 } });
    const merged = mergeSummaries(file, restartedSummary());
    expect(merged.costByDayUsd?.[DAY_KEY]).toBe(3);
    expect(merged.firstActivityByDayMs?.[DAY_KEY]).toBeUndefined();
    expect(buildCostTrackerSeed(merged).dayFirstActivityMs).toBeUndefined();
  });

  it('saves the first spend of a day the file had no spend on', () => {
    const merged = mergeSummaries(savedFile({}), restartedSummary());
    expect(merged.firstActivityByDayMs).toEqual({ [DAY_KEY]: RESTART });
    expect(buildCostTrackerSeed(merged).dayFirstActivityMs).toBe(RESTART);
  });

  it('keeps the earlier saved first spend over a later restart', () => {
    const file = savedFile({
      estimatedCostUsd: 2,
      costByDayUsd: { [DAY_KEY]: 2 },
      firstActivityByDayMs: { [DAY_KEY]: MORNING },
    });
    const merged = mergeSummaries(file, restartedSummary());
    expect(merged.firstActivityByDayMs).toEqual({ [DAY_KEY]: MORNING });
  });
});

describe('LocalSessionAggregator timeline cap', () => {
  it('keeps the most recent 10,000 timeline entries once the cap is exceeded', () => {
    const agg = new LocalSessionAggregator();
    const total = 10_000 + 25;
    for (let i = 1; i <= total; i++) {
      agg.recordToolCall({ sessionId: REAL_ID, toolName: 'read_file', timestamp: i });
    }

    const timeline = summariesOf(agg)[0]?.timeline as Array<Record<string, unknown>>;
    expect(timeline).toHaveLength(10_000);
    expect(timeline[0]?.timestamp).toBe(26);
    expect(timeline[9_999]?.timestamp).toBe(total);
  });
});

describe('saved timeline past the cap', () => {
  it('replaces the saved oldest entries with the newest as the session grows', () => {
    const agg = new LocalSessionAggregator();
    const save = (): FullSessionSummary => summariesOf(agg)[0] as unknown as FullSessionSummary;
    let onDisk: FullSessionSummary | undefined;
    for (let i = 1; i <= 10_025; i++) {
      agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Bash', timestamp: i });
      if (i === 10_000 || i === 10_025) {
        onDisk = onDisk ? mergeSummaries(onDisk, save()) : save();
      }
    }

    const stamps = onDisk!.timeline!.map((e) => e.timestamp);
    expect(stamps).toHaveLength(10_000);
    expect(stamps[0]).toBe(26);
    expect(stamps.at(-1)).toBe(10_025);
  });
});

const closedTask = (agg: LocalSessionAggregator, sessionId: string, at: number): void => {
  agg.recordToolCall({ sessionId, toolName: 'Read', timestamp: at });
  agg.recordToolCall({ sessionId, toolName: 'AskUserQuestion', timestamp: at + 1 });
};

describe('saved taskCount', () => {
  const OTHER_ID = '5b0f3c1e-92d4-4f7a-8a63-0d2c7e9b1a55';
  const taskCountsById = (agg: LocalSessionAggregator): Record<string, unknown> =>
    Object.fromEntries(summariesOf(agg).map((s) => [String(s.sessionId), s.taskCount]));

  it('counts the tasks a session closed', () => {
    const agg = new LocalSessionAggregator();
    closedTask(agg, REAL_ID, 1000);
    closedTask(agg, REAL_ID, 2000);

    expect(taskCountsById(agg)).toEqual({ [REAL_ID]: 2 });
  });

  it('keeps two concurrent sessions from sharing a count', () => {
    const agg = new LocalSessionAggregator();
    closedTask(agg, REAL_ID, 1000);
    closedTask(agg, OTHER_ID, 1100);
    closedTask(agg, REAL_ID, 2000);

    expect(taskCountsById(agg)).toEqual({ [REAL_ID]: 2, [OTHER_ID]: 1 });
  });

  it('closes a session task on its own Stop and leaves another session open', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: 1000 });
    agg.recordToolCall({ sessionId: OTHER_ID, toolName: 'Read', timestamp: 1000 });
    agg.markTaskBoundary(REAL_ID, 1500);
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: 2000 });
    agg.recordToolCall({ sessionId: OTHER_ID, toolName: 'Read', timestamp: 2000 });
    agg.markTaskBoundary(REAL_ID, 2500);

    expect(taskCountsById(agg)).toEqual({ [REAL_ID]: 2, [OTHER_ID]: 0 });
  });

  it('does not count a prompt that made no tool call', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: 1000 });
    agg.markTaskBoundary(REAL_ID, 1500);
    agg.startTask(REAL_ID, 2000);
    agg.markTaskBoundary(REAL_ID, 2500);

    expect(taskCountsById(agg)).toEqual({ [REAL_ID]: 1 });
  });

  it('counts a task only once it closes', () => {
    const agg = new LocalSessionAggregator();
    agg.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp: 1000 });
    agg.startTask(REAL_ID, 1500);
    expect(taskCountsById(agg)).toEqual({ [REAL_ID]: 0 });

    agg.markTaskBoundary(REAL_ID, 1700);
    expect(taskCountsById(agg)).toEqual({ [REAL_ID]: 1 });
  });
});

describe('saved share', () => {
  it('saves a Bash call another writer also drained as one command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agg-bash-'));
    try {
      const store = new SessionStore({ storagePath: dir });
      const bash = { sessionId: REAL_ID, toolName: 'Bash', toolUseId: 'toolu_b', timestamp: 1000 };
      for (const drainer of [new LocalSessionAggregator(), new LocalSessionAggregator()]) {
        drainer.recordToolCall(bash);
        store.writer('aggregator').save({
          summary: summariesOf(drainer)[0] as unknown as FullSessionSummary,
          retracted: false,
        });
      }

      expect(store.loadSession(REAL_ID)).toMatchObject({ toolCallCount: 1, bashCommandCount: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves only what it drained, and the session adds it to an earlier writer's file", () => {
    const dir = mkdtempSync(join(tmpdir(), 'agg-share-'));
    try {
      const store = new SessionStore({ storagePath: dir });
      const noon = new Date(2026, 8, 10, 12).getTime();
      const day = localDateKey(noon);
      const earlier = new LocalSessionAggregator();
      closedTask(earlier, REAL_ID, noon - 5000);
      earlier.recordTokenUsage(REAL_ID, { costUsd: 10, timestamp: noon - 4000, agentId: 'a' });
      const save = (agg: LocalSessionAggregator) =>
        store.writer('aggregator').save({
          summary: summariesOf(agg)[0] as unknown as FullSessionSummary,
          retracted: false,
        });
      save(earlier);

      const restarted = new LocalSessionAggregator();
      restarted.recordTokenUsage(REAL_ID, { costUsd: 1, timestamp: noon, agentId: 'a' });
      restarted.recordTokenUsage(REAL_ID, { costUsd: 2, timestamp: noon + 1 });
      closedTask(restarted, REAL_ID, noon + 2);

      expect(summariesOf(restarted)[0]).toMatchObject({
        estimatedCostUsd: 3,
        subagentCostUsd: 1,
        costByDayUsd: { [day]: 3 },
        taskCount: 1,
      });
      save(restarted);
      expect(store.loadSession(REAL_ID)).toMatchObject({
        estimatedCostUsd: 13,
        subagentCostUsd: 11,
        costByDayUsd: { [day]: 13 },
        firstActivityByDayMs: { [day]: noon - 4000 },
        taskCount: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
