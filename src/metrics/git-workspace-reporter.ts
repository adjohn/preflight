import { spawnSync } from 'node:child_process';

import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import { ActivityStore } from './git-activity-store.js';
import { GitActivityRecorder, type GitActivityRecord } from './git-activity-recorder.js';
import { WorktreeIdentityResolver, type WorktreeIdentity } from './git-workspace-identity.js';
import {
  buildGitWorkspaceReport,
  type GitWorkspaceReport,
  type ScopeRef,
  type WorktreeLiveState,
} from './git-workspace-report.js';

// Same pattern as git-workspace-identity.ts / local-session-aggregator.ts:
// GIT_DIR/GIT_WORK_TREE (set by git for hook subprocesses, among other cases)
// override `-C <dir>`, silently redirecting these calls to whatever repo the
// ambient env points at instead of the target directory.
const GIT_OPTS = {
  encoding: 'utf-8' as const,
  timeout: 2000,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  get env() {
    return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  },
};

const DEFAULT_LIVE_STATE_TTL_MS = 5 * 60_000;

function gitOut(root: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync('git', ['-C', root, ...args], GIT_OPTS);
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** `internal/main` -> `main`, `origin/main` -> `main`. A ref with no `/` is
 *  returned unchanged. */
function stripRemotePrefix(ref: string): string {
  const idx = ref.indexOf('/');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

/**
 * Owns the live pipeline from raw tool calls to a queryable git workspace
 * report: its own `WorktreeIdentityResolver` + `ActivityStore` +
 * `GitActivityRecorder`, a registry of every workspace identity ever seen,
 * and a short-TTL cache of each workspace's live branch/divergence state.
 */
export class GitWorkspaceReporter {
  private readonly identityResolver = new WorktreeIdentityResolver();
  private readonly store = new ActivityStore<GitActivityRecord>();
  private readonly recorder: GitActivityRecorder;
  private readonly liveStateTtlMs: number;

  // Every workspaceKey ever seen, not just ones with recent activity — a
  // scope picker needs to show a workspace even in a window with no
  // activity in it (see knownWorkspaces()).
  private readonly knownWorkspacesRegistry = new Map<string, WorktreeIdentity>();
  private readonly liveStateCache = new Map<string, WorktreeLiveState>();

  constructor(config?: { readonly liveStateTtlMs?: number }) {
    this.recorder = new GitActivityRecorder(this.store, this.identityResolver);
    this.liveStateTtlMs = config?.liveStateTtlMs ?? DEFAULT_LIVE_STATE_TTL_MS;
  }

  /** Feed every drained tool-call record. Also updates the known-workspaces
   *  registry with whatever identity gets resolved for this record's cwd. */
  recordToolCall(record: ToolCallRecord): void {
    this.recorder.recordToolCall(record);
    const identity = this.identityResolver.resolve(record.cwd as string | undefined);
    if (identity) {
      this.knownWorkspacesRegistry.set(identity.worktreeKey, identity);
    }
  }

  /**
   * Ingest already-classified records directly (bypassing the
   * classify-from-ToolCallRecord path `recordToolCall` uses) — for replayed
   * historical sessions built by `replaySessionToActivityRecords` elsewhere.
   * `identities`, when given, is a workspaceKey -> identity map covering
   * whichever of `records`' workspaceKeys the caller was able to resolve
   * during replay (it already had to resolve identity per-entry to classify
   * cwd-based attribution, so it's the caller's to hand back here) — this is
   * what lets the known-workspaces registry learn about a workspace whose
   * only evidence is replayed history, not live tool calls.
   */
  ingestRecords(
    records: readonly GitActivityRecord[],
    identities?: ReadonlyMap<string, WorktreeIdentity>,
  ): void {
    for (const record of records) {
      this.store.ingest(record);
    }
    if (identities) {
      for (const [workspaceKey, identity] of identities) {
        this.knownWorkspacesRegistry.set(workspaceKey, identity);
      }
    }
  }

  /** Every known workspace's identity, for building a scope picker even
   *  before there's a report to show. */
  knownWorkspaces(): ReadonlyMap<string, WorktreeIdentity> {
    return this.knownWorkspacesRegistry;
  }

  /**
   * Samples live branch state for a workspace (branch, default branch,
   * ahead/behind), cached with a short TTL per worktreeKey so repeated calls
   * in a short window don't re-shell out. Never runs `git fetch` — this only
   * ever reads state git already has locally.
   */
  sampleLiveState(identity: WorktreeIdentity): WorktreeLiveState {
    const now = Date.now();
    const cached = this.liveStateCache.get(identity.worktreeKey);
    if (cached && now - cached.measuredAtMs < this.liveStateTtlMs) {
      return cached;
    }

    const state = this.computeLiveState(identity, now);
    this.liveStateCache.set(identity.worktreeKey, state);
    return state;
  }

  /**
   * The one method a future API/MCP layer calls. `since`/`until` are epoch
   * ms, already resolved by the caller. Queries the in-memory store for
   * records in [since, until), merges in `historical` records if given,
   * samples live state for every workspace with activity in the resulting
   * record set, and calls `buildGitWorkspaceReport`.
   *
   * The `identities` map `buildGitWorkspaceReport` needs comes straight from
   * this reporter's own `knownWorkspaces()` registry. `historical` records
   * carry no identity of their own — a workspaceKey among them that isn't
   * already in the registry is skipped gracefully; `buildGitWorkspaceReport`
   * already logs a warning and drops any record whose workspaceKey it can't
   * resolve, so there is nothing extra to do here for that case.
   */
  report(input: {
    readonly scope: ScopeRef;
    readonly since: number;
    readonly until: number;
    readonly historical?: readonly GitActivityRecord[];
  }): GitWorkspaceReport {
    const { scope, since, until, historical } = input;

    const liveRecords = this.store.query({ since, until });
    const records =
      historical && historical.length > 0 ? [...liveRecords, ...historical] : [...liveRecords];

    const identities = new Map(this.knownWorkspacesRegistry);

    const liveStates = new Map<string, WorktreeLiveState>();
    const workspaceKeys = new Set(records.map((r) => r.workspaceKey));
    for (const key of workspaceKeys) {
      const identity = identities.get(key);
      if (identity) {
        liveStates.set(key, this.sampleLiveState(identity));
      }
    }

    return buildGitWorkspaceReport({ scope, records, identities, liveStates });
  }

  /**
   * Compare-ref resolution ladder, first one that resolves wins:
   *   1. The branch's own configured upstream (`<branch>@{upstream}`) — NOT
   *      always `origin/<defaultBranch>`; a repo's real branch can track a
   *      differently-named remote (e.g. `internal/main`) while `origin/main`
   *      exists and diverges by hundreds of commits, so a hardcoded
   *      `origin/<default>` guess would be actively wrong.
   *   2. The repo's default branch on origin (`refs/remotes/origin/HEAD`).
   *   3. Give up — ahead/behind/defaultBranch all stay null.
   */
  private computeLiveState(identity: WorktreeIdentity, now: number): WorktreeLiveState {
    const root = identity.worktreeRoot;
    if (root === null) {
      return {
        branch: identity.branch,
        defaultBranch: null,
        ahead: null,
        behind: null,
        measuredAtMs: now,
      };
    }

    let compareRef: string | null = null;

    if (identity.branch !== null) {
      compareRef = gitOut(root, ['rev-parse', '--abbrev-ref', `${identity.branch}@{upstream}`]);
    }

    if (compareRef === null) {
      compareRef = gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    }

    if (compareRef === null) {
      return {
        branch: identity.branch,
        defaultBranch: null,
        ahead: null,
        behind: null,
        measuredAtMs: now,
      };
    }

    const defaultBranch = stripRemotePrefix(compareRef);
    // `git rev-list --left-right --count <left>...<right>` prints
    // "<count-of-left-only>\t<count-of-right-only>" — verified against a real
    // repo with a real ahead/behind divergence rather than assumed: with
    // `<upstream>...HEAD`, left is the upstream (what we're behind on) and
    // right is HEAD (what we're ahead by), so the output is "<behind>\t<ahead>".
    const countsOut = gitOut(root, ['rev-list', '--count', '--left-right', `${compareRef}...HEAD`]);
    if (countsOut === null) {
      return {
        branch: identity.branch,
        defaultBranch,
        ahead: null,
        behind: null,
        measuredAtMs: now,
      };
    }

    const [behindStr, aheadStr] = countsOut.split('\t');
    const behind = behindStr !== undefined ? parseInt(behindStr, 10) : NaN;
    const ahead = aheadStr !== undefined ? parseInt(aheadStr, 10) : NaN;

    return {
      branch: identity.branch,
      defaultBranch,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
      measuredAtMs: now,
    };
  }
}

/**
 * Re-classifies a persisted session's timeline into `GitActivityRecord`s,
 * using the SAME `GitActivityRecorder` dispatch the live path uses (so a
 * regex improvement in the classifier retro-applies to history) and each
 * entry's own `cwd` to resolve workspace identity. An entry with no `cwd` (a
 * session persisted before that field existed) resolves to the
 * `'unattributed'` workspaceKey, the same fallback `GitActivityRecorder`
 * uses live — `identityResolver.resolve(undefined)` returns null, and
 * `GitActivityRecorder`'s own `resolveWorkspaceKey` maps that to
 * `'unattributed'`.
 *
 * Implementation: build one synthetic `ToolCallRecord` per timeline entry
 * (mirroring `GitEfficiencyTracker.replayTimeline()`'s own pattern) with a
 * synthetic `toolUseId` of `replay:<sessionId>:<index>`. `GitActivityRecorder`'s
 * `makeRecordId` prefers `toolUseId` when present, so every resulting record
 * gets a `recordId` starting with `replay:<sessionId>:<index>` (plus the same
 * kind-specific discriminator suffix the live path appends, e.g. `:git` or
 * `:edit` — needed because one entry can legitimately produce more than one
 * activity) with zero special-casing. That id is deterministic across replays
 * of the same session, which is what lets a destination store's own recordId
 * dedup make a repeated replay safe.
 *
 * A private, throwaway `ActivityStore` + `GitActivityRecorder` pair captures
 * whatever the dispatch produces; this function just drains it back out.
 */
export function replaySessionToActivityRecords(
  session: { readonly sessionId: string; readonly timeline?: readonly ReplayTimelineEntry[] },
  identityResolver: WorktreeIdentityResolver,
): GitActivityRecord[] {
  const replayStore = new ActivityStore<GitActivityRecord>();
  const replayRecorder = new GitActivityRecorder(replayStore, identityResolver);
  const timeline = session.timeline ?? [];

  for (let index = 0; index < timeline.length; index++) {
    const entry = timeline[index];
    const toolUseId = `replay:${session.sessionId}:${index}`;
    const syntheticRecord: ToolCallRecord = {
      id: toolUseId,
      sessionId: session.sessionId,
      toolName: entry.toolName,
      toolUseId,
      timestamp: entry.timestamp,
      durationMs: entry.durationMs,
      success: entry.success,
      cwd: entry.cwd,
      filePath: entry.filePath,
      command: entry.command,
      isTestCommand: entry.isTestCommand,
      isBuildCommand: entry.isBuildCommand,
      errorType: entry.errorType,
    };
    replayRecorder.recordToolCall(syntheticRecord);
  }

  // The replay store is private to this call and holds nothing else, so
  // querying the full open range just drains everything that was ingested.
  return [...replayStore.query({ since: -Infinity, until: Infinity })];
}
