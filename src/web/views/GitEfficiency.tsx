import type { JSX } from 'react';
import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  fetchGitEfficiency,
  formatScope,
  qk,
  type GitSuggestion,
  type MergeConflictRecord,
  type GitWorkspaceReport,
  type WorkspaceRow,
  type WorktreeIdentity,
  type ScopeRefInput,
} from '../api/client';
import { AnimatedCard } from '../components/AnimatedCard';
import { EmptyState } from '../components/EmptyState';
import { GeoBanner } from '../components/GeoBanner';
import { Kpi } from '../components/Kpi';
import { Card, Eyebrow, Pill, SectionHeader, Tabs } from '../components/ui';
import type { PillTone } from '../components/ui';

type Timeframe = 'today' | 'yesterday' | 'week';

const TIMEFRAME_OPTIONS: ReadonlyArray<{ value: Timeframe; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
];

const TIMEFRAME_SUBTITLE: Record<Timeframe, string> = {
  today: "Today's activity across all sessions",
  yesterday: "Yesterday's activity across all sessions",
  week: "This week's activity across all sessions",
};

const SEVERITY_STYLE: Record<GitSuggestion['severity'], string> = {
  info: 'border-l-accent-blue bg-accent-blue/5',
  warning: 'border-l-accent-amber bg-accent-amber/5',
  critical: 'border-l-accent-red bg-accent-red/5',
};

const SEVERITY_TONE: Record<GitSuggestion['severity'], PillTone> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
};

const RESOLUTION_STYLE: Record<MergeConflictRecord['resolution'], string> = {
  resolved: 'text-accent-green',
  aborted: 'text-accent-red',
  pending: 'text-accent-amber',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  merge_conflict: 'bg-accent-red/20 text-accent-red',
  rebase_conflict: 'bg-accent-red/20 text-accent-red',
  merge_abort: 'bg-accent-amber/20 text-accent-amber',
  rebase_abort: 'bg-accent-amber/20 text-accent-amber',
  force_push: 'bg-accent-red/20 text-accent-red',
  reset_hard: 'bg-accent-amber/20 text-accent-amber',
  commit: 'bg-accent-green/20 text-accent-green',
  push: 'bg-accent-blue/20 text-accent-blue',
  pull: 'bg-accent-blue/20 text-accent-blue',
};

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ');
}

/** Time-only for today's events; date-prefixed for older ones so the ordering reads correctly. */
function formatEventTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** "as of Xm ago" style relative label for a `liveState.measuredAtMs` sample. */
function formatAgo(measuredAtMs: number): string {
  const deltaMs = Date.now() - measuredAtMs;
  if (deltaMs < 0 || deltaMs < 1000) return 'as of just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `as of ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `as of ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `as of ${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `as of ${days}d ago`;
}

/** Tone for a "commits behind" style KPI — null (unknown) stays neutral so it
 *  never coalesces to the "good" green a confirmed 0 would render. */
function behindTone(n: number | null): 'neutral' | 'good' | 'warn' | 'bad' {
  if (n === null) return 'neutral';
  if (n > 20) return 'bad';
  if (n > 5) return 'warn';
  return 'good';
}

function ScoreRing({ score }: { score: number | null }): JSX.Element {
  if (score === null) {
    return (
      <div className="flex items-center justify-center w-20 h-20 rounded-full border-4 border-border-medium">
        <span className="text-ink-muted text-xs">N/A</span>
      </div>
    );
  }

  // Clamp score to [0, 100] so out-of-range values don't produce negative
  // strokeDashoffset (arc overflows full circle) or > circumference (arc disappears).
  const clampedScore = Math.max(0, Math.min(100, score));
  const [textColor, borderColor] =
    clampedScore >= 80
      ? ['text-accent-green', 'border-accent-green']
      : clampedScore >= 60
        ? ['text-accent-amber', 'border-accent-amber']
        : ['text-accent-red', 'border-accent-red'];

  const circumference = 2 * Math.PI * 34;
  const offset = circumference - (clampedScore / 100) * circumference;

  return (
    <div className="relative w-20 h-20">
      <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
        <circle
          cx="40"
          cy="40"
          r="34"
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="6"
        />
        <circle
          cx="40"
          cy="40"
          r="34"
          fill="none"
          className={borderColor}
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s ease-out' }}
        />
      </svg>
      <div
        className={`absolute inset-0 flex items-center justify-center text-lg font-bold ${textColor}`}
      >
        {score}
      </div>
    </div>
  );
}

interface WorkspaceTableProps {
  readonly rows: readonly WorkspaceRow[];
  readonly onSelectRepo: (identity: WorktreeIdentity) => void;
  readonly onSelectWorktree: (identity: WorktreeIdentity) => void;
}

/** One row per workspace with activity in the window — NOT filtered by the
 *  currently-selected scope (the scope drills into the cards below; this
 *  table is always the full picture so a click can broaden or narrow). */
function WorkspaceTable({
  rows,
  onSelectRepo,
  onSelectWorktree,
}: WorkspaceTableProps): JSX.Element {
  if (rows.length === 0) {
    return <EmptyState icon="code" title="No git activity in this window" />;
  }

  return (
    <div className="max-h-56 overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-ink-muted bg-surface-3 sticky top-0">
          <tr>
            <th className="text-left p-2">Repo</th>
            <th className="text-left p-2">Worktree</th>
            <th className="text-left p-2">Branch</th>
            <th className="text-left p-2">Commits</th>
            <th className="text-left p-2">Conflicts</th>
            <th className="text-left p-2">Best practices</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const known = row.metrics.bestPractices.filter(
              (bp) => bp.status !== 'unknown' && bp.status !== 'n/a',
            );
            const passing = row.metrics.bestPractices.filter((bp) => bp.status === 'pass').length;
            const conflicts = row.metrics.mergeConflicts + row.metrics.rebaseConflicts;
            return (
              <tr key={row.identity.worktreeKey} className="border-t border-border-subtle">
                <td className="p-2 whitespace-nowrap">
                  {row.identity.repoName ? (
                    <button
                      type="button"
                      onClick={() => onSelectRepo(row.identity)}
                      className="font-mono text-accent-blue hover:underline"
                    >
                      {row.identity.repoName}
                    </button>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
                <td className="p-2 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onSelectWorktree(row.identity)}
                    className="font-mono text-accent-blue hover:underline"
                  >
                    {row.identity.worktreeLabel}
                  </button>
                </td>
                <td className="p-2 font-mono text-ink-subtle whitespace-nowrap">
                  {row.identity.branch ?? '—'}
                </td>
                <td className="p-2 tabular-nums">{row.metrics.commitCount}</td>
                <td className="p-2 tabular-nums">{conflicts}</td>
                <td className="p-2 tabular-nums text-ink-subtle">
                  {known.length > 0 ? `${passing}/${known.length}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GitEfficiency(): JSX.Element {
  const [timeframe, setTimeframe] = useState<Timeframe>('today');
  const [scope, setScope] = useState<ScopeRefInput>('all');
  // The identity of whichever row was last clicked into — carried alongside
  // `scope` purely so the breadcrumb always has a display name/label, even if
  // a later timeframe change makes that workspace drop out of `report.rows`.
  const [scopeIdentity, setScopeIdentity] = useState<WorktreeIdentity | null>(null);

  const {
    data: report,
    isLoading,
    error,
  } = useQuery<GitWorkspaceReport>({
    queryKey: qk.gitEfficiency(timeframe, formatScope(scope)),
    queryFn: () => fetchGitEfficiency(timeframe, formatScope(scope)),
    refetchInterval: 5000,
  });

  const handleSelectRepo = (identity: WorktreeIdentity): void => {
    setScope({ repo: identity.repoKey });
    setScopeIdentity(identity);
  };
  const handleSelectWorktree = (identity: WorktreeIdentity): void => {
    setScope({ worktree: identity.worktreeKey });
    setScopeIdentity(identity);
  };
  const handleResetScope = (): void => {
    setScope('all');
    setScopeIdentity(null);
  };
  const handleGoToRepo = (): void => {
    if (!scopeIdentity) return;
    setScope({ repo: scopeIdentity.repoKey });
  };

  if (isLoading) return <EmptyState icon="clock" variant="loading" title="Loading..." />;
  if (error)
    return <div className="text-accent-red text-xs">Error loading git efficiency data.</div>;
  if (!report) return <EmptyState icon="clock" variant="loading" title="Loading..." />;

  const metrics = report.metrics;
  const resolvedConflictCount = metrics.conflictHistory.filter(
    (c) => c.resolution === 'resolved',
  ).length;

  return (
    <section>
      <GeoBanner theme="git" />
      <header className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold gradient-text">Git Efficiency</h1>

          {/* Scope breadcrumb — starts at "All workspaces"; drills in as the
              workspace table or a suggestion below is clicked. */}
          <div className="flex items-center gap-1.5 mt-1 text-[11px]">
            {scope === 'all' ? (
              <span className="text-ink-subtle">All workspaces</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleResetScope}
                  className="text-ink-muted hover:text-ink-base hover:underline"
                >
                  All workspaces
                </button>
                <span aria-hidden="true" className="text-ink-muted">
                  /
                </span>
                {'worktree' in scope ? (
                  <>
                    <button
                      type="button"
                      onClick={handleGoToRepo}
                      className="font-mono text-ink-muted hover:text-ink-base hover:underline"
                    >
                      {scopeIdentity?.repoName ?? scopeIdentity?.repoKey ?? 'repo'}
                    </button>
                    <span aria-hidden="true" className="text-ink-muted">
                      /
                    </span>
                    <span className="font-mono text-ink-subtle">
                      {scopeIdentity?.worktreeLabel ?? scope.worktree}
                    </span>
                  </>
                ) : (
                  <span className="font-mono text-ink-subtle">
                    {scopeIdentity?.repoName ?? scope.repo}
                  </span>
                )}
              </>
            )}
          </div>

          <div className="mt-1 text-[11px] text-ink-muted">{TIMEFRAME_SUBTITLE[timeframe]}</div>

          <div className="mt-2">
            <Tabs<Timeframe>
              value={timeframe}
              onChange={setTimeframe}
              options={TIMEFRAME_OPTIONS}
              size="sm"
              tone="green"
              ariaLabel="Timeframe"
            />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-center">
            <Eyebrow as="div" className="mb-1">
              Prevention
            </Eyebrow>
            <ScoreRing score={metrics.preventionScore} />
          </div>
          <div className="text-center">
            <Eyebrow as="div" className="mb-1">
              Efficiency
            </Eyebrow>
            <ScoreRing score={metrics.efficiencyScore} />
          </div>
        </div>
      </header>

      {/* Workspace table — every workspace with activity in the window,
          regardless of the currently-selected scope. Clicking a repo/worktree
          drills the cards below into it. */}
      <AnimatedCard index={0} className="mb-3">
        <Card padding="md">
          <SectionHeader
            title="Workspaces"
            action={
              <span className="text-[11px] text-ink-muted">
                {report.rows.length} workspace{report.rows.length === 1 ? '' : 's'}
              </span>
            }
          />
          <WorkspaceTable
            rows={report.rows}
            onSelectRepo={handleSelectRepo}
            onSelectWorktree={handleSelectWorktree}
          />
        </Card>
      </AnimatedCard>

      {metrics.totalGitCommands === 0 ? (
        <EmptyState
          icon="code"
          title="No Git activity yet"
          subtitle="Git efficiency metrics will appear here as git commands are executed during the session."
        />
      ) : (
        <>
          {/* Hero KPIs — what shipped, what's risky, current state */}
          <AnimatedCard index={1} className="mb-3">
            <Card padding="lg" tone="elevated" glow="green">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Kpi
                  label="commits"
                  hero
                  value={String(metrics.commitCount)}
                  animate
                  numericValue={metrics.commitCount}
                />
                <Kpi
                  label="PRs opened"
                  tone={metrics.prMetrics.created > 0 ? 'good' : 'neutral'}
                  value={String(metrics.prMetrics.created)}
                  animate
                  numericValue={metrics.prMetrics.created}
                />
                <Kpi
                  label="conflicts"
                  tone={metrics.mergeConflicts + metrics.rebaseConflicts > 0 ? 'bad' : 'good'}
                  value={String(metrics.mergeConflicts + metrics.rebaseConflicts)}
                  sub={
                    metrics.mergeConflicts + metrics.rebaseConflicts === 0
                      ? 'clean session'
                      : `${resolvedConflictCount} resolved`
                  }
                  animate
                  numericValue={metrics.mergeConflicts + metrics.rebaseConflicts}
                />
                {report.scope.kind === 'worktree' ? (
                  <Kpi
                    label={`behind ${metrics.liveState?.defaultBranch ?? 'upstream'}`}
                    tone={behindTone(metrics.liveState?.behind ?? null)}
                    value={
                      metrics.liveState?.behind != null ? String(metrics.liveState.behind) : '—'
                    }
                    sub={
                      metrics.liveState?.measuredAtMs != null
                        ? formatAgo(metrics.liveState.measuredAtMs)
                        : undefined
                    }
                    animate
                    numericValue={metrics.liveState?.behind ?? null}
                  />
                ) : (
                  <Kpi
                    label="worst behind"
                    tone={behindTone(report.worstBehind?.behind ?? null)}
                    value={report.worstBehind ? String(report.worstBehind.behind) : '—'}
                    sub={
                      report.worstBehind
                        ? report.worstBehind.identity.repoName
                          ? `${report.worstBehind.identity.worktreeLabel} · ${report.worstBehind.identity.repoName}`
                          : report.worstBehind.identity.worktreeLabel
                        : undefined
                    }
                    animate
                    numericValue={report.worstBehind?.behind ?? null}
                  />
                )}
              </div>
            </Card>
          </AnimatedCard>

          {/* Best practices checklist — compact: only expand failures */}
          {metrics.bestPractices.length > 0 && (
            <AnimatedCard index={2} className="mb-3">
              <Card padding="md">
                <SectionHeader
                  title="Best Practices"
                  action={
                    <span className="text-[11px] text-ink-muted">
                      {(() => {
                        // 'n/a' (fully known, not applicable) is excluded from the
                        // ratio the same way 'unknown' (insufficient data) is —
                        // matching computePreventionScore()'s treatment so this
                        // header and the Prevention score ring never disagree on
                        // which items count. See BestPractice['status']'s docstring.
                        const known = metrics.bestPractices.filter(
                          (bp) => bp.status !== 'unknown' && bp.status !== 'n/a',
                        ).length;
                        if (known === 0) return 'No data yet';
                        const passing = metrics.bestPractices.filter(
                          (bp) => bp.status === 'pass',
                        ).length;
                        return `${passing}/${known} passing`;
                      })()}
                    </span>
                  }
                />
                {/* Passing items — compact row of chips */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {metrics.bestPractices
                    .filter((bp) => bp.status === 'pass')
                    .map((bp) => (
                      <Pill key={bp.id} tone="success" size="sm" bordered>
                        <span>&#10003;</span> {bp.label}
                      </Pill>
                    ))}
                  {metrics.bestPractices
                    .filter((bp) => bp.status === 'unknown' || bp.status === 'n/a')
                    .map((bp) => (
                      <Pill key={bp.id} tone="neutral" size="sm" bordered>
                        <span>&#9679;</span> {bp.label}
                      </Pill>
                    ))}
                </div>
                {/* Failing/warning items — expanded with detail */}
                {metrics.bestPractices
                  .filter((bp) => bp.status === 'fail' || bp.status === 'warn')
                  .map((bp) => (
                    <div
                      key={bp.id}
                      className={`flex items-start gap-2 px-2.5 py-2 rounded-lg mt-1.5 ${
                        bp.status === 'fail'
                          ? 'bg-accent-red/5 border border-accent-red/20'
                          : 'bg-accent-amber/5 border border-accent-amber/20'
                      }`}
                    >
                      <span className="shrink-0 mt-0.5 text-xs">
                        {bp.status === 'fail' ? (
                          <span className="text-accent-red">&#10007;</span>
                        ) : (
                          <span className="text-accent-amber">&#9888;</span>
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-ink-base">{bp.label}</div>
                        <div className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
                          {bp.detail}
                        </div>
                      </div>
                    </div>
                  ))}
              </Card>
            </AnimatedCard>
          )}

          {/* Conflict resolution stats */}
          {(metrics.mergeConflicts > 0 || metrics.rebaseConflicts > 0) && (
            <AnimatedCard index={3} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Conflict Resolution" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="Resolution rate"
                    value={
                      metrics.conflictResolutionRate !== null
                        ? `${Math.round(metrics.conflictResolutionRate * 100)}%`
                        : '—'
                    }
                  />
                  <Kpi
                    label="Avg resolution time"
                    value={formatMs(metrics.avgConflictResolutionMs)}
                  />
                  <Kpi label="Aborted ops" value={String(metrics.abortedOperations)} />
                  <Kpi label="Stale branch pulls" value={String(metrics.staleBranchPulls)} />
                </div>

                {metrics.conflictHistory.length > 0 && (
                  <div className="mt-3">
                    <Eyebrow as="h3" className="mb-2">
                      Conflict History
                    </Eyebrow>
                    <div className="space-y-1">
                      {metrics.conflictHistory.map((c) => (
                        <div
                          key={`${c.timestamp}-${c.command}`}
                          className="flex items-center gap-3 text-xs py-1 border-t border-border-subtle"
                        >
                          <span className="tabular-nums text-ink-subtle w-28 shrink-0">
                            {new Date(c.timestamp).toLocaleTimeString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                          <span className={`font-medium ${RESOLUTION_STYLE[c.resolution]}`}>
                            {c.resolution}
                          </span>
                          <span className="text-ink-muted">{formatMs(c.resolutionTimeMs)}</span>
                          <span className="text-ink-subtle font-mono text-[11px] truncate">
                            {c.command}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </AnimatedCard>
          )}

          {/* Suggestions */}
          {metrics.suggestions.length > 0 && (
            <AnimatedCard index={4} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Suggestions" />
                <div className="space-y-2">
                  {metrics.suggestions.map((s, i) => (
                    <div
                      key={`${s.category}-${s.severity}-${i}`}
                      className={`border-l-[3px] rounded-r-lg px-3 py-2 ${SEVERITY_STYLE[s.severity]}`}
                    >
                      <div className="flex items-start gap-2">
                        <Pill tone={SEVERITY_TONE[s.severity]} size="sm" className="font-semibold">
                          {s.severity}
                        </Pill>
                        <div>
                          <p className="text-xs text-ink-base">{s.message}</p>
                          <p className="text-[11px] text-ink-muted mt-0.5">{s.evidence}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </AnimatedCard>
          )}

          {/* Velocity & workflow */}
          {metrics.commitCount >= 2 && (
            <AnimatedCard index={5} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Velocity & Workflow" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="Avg time between commits"
                    value={formatMs(metrics.velocityMetrics.avgTimeBetweenCommitsMs)}
                  />
                  <Kpi label="Longest gap" value={formatMs(metrics.velocityMetrics.longestGapMs)} />
                  <Kpi
                    label="Commit bursts"
                    value={String(metrics.velocityMetrics.commitBurstCount)}
                  />
                  <Kpi label="Worktree ops" value={String(metrics.velocityMetrics.worktreeCount)} />
                </div>
                {metrics.velocityMetrics.buildBeforePush !== null && (
                  <div className="mt-3 text-xs">
                    <span className="text-ink-muted">Verified before push: </span>
                    {metrics.velocityMetrics.buildBeforePush ? (
                      <span className="text-accent-green">yes (build/test ran first)</span>
                    ) : (
                      <span className="text-accent-amber">no build/test detected before push</span>
                    )}
                  </div>
                )}
              </Card>
            </AnimatedCard>
          )}

          {/* Pull requests */}
          {(metrics.prMetrics.created > 0 ||
            metrics.prMetrics.merged > 0 ||
            metrics.prMetrics.checksViewed > 0) && (
            <AnimatedCard index={6} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Pull Requests" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="PRs created"
                    value={String(metrics.prMetrics.created)}
                    tone={metrics.prMetrics.created > 0 ? 'good' : 'neutral'}
                  />
                  <Kpi
                    label="PRs merged"
                    value={String(metrics.prMetrics.merged)}
                    tone={metrics.prMetrics.merged > 0 ? 'good' : 'neutral'}
                  />
                  <Kpi label="CI checks viewed" value={String(metrics.prMetrics.checksViewed)} />
                  <Kpi label="Time to PR" value={formatMs(metrics.prMetrics.avgTimeToCreateMs)} />
                </div>
                {metrics.prMetrics.prActivity.length > 0 && (
                  <div className="mt-3">
                    <Eyebrow as="h3" className="mb-2">
                      Activity
                    </Eyebrow>
                    <div className="flex flex-wrap gap-1.5">
                      {metrics.prMetrics.prActivity.map((e) => {
                        const tone: PillTone =
                          e.action === 'create'
                            ? 'success'
                            : e.action === 'merge'
                              ? 'info'
                              : 'neutral';
                        return (
                          <Pill key={`${e.timestamp}-${e.action}`} tone={tone} size="sm">
                            {e.action}
                            {e.prNumber ? ` #${e.prNumber}` : ''}
                          </Pill>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Card>
            </AnimatedCard>
          )}

          {/* Conflict resolution strategy */}
          {metrics.conflictResolutionStrategy.totalResolutions > 0 && (
            <AnimatedCard index={7} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Conflict Resolution Strategy" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="Accept ours"
                    value={String(metrics.conflictResolutionStrategy.oursCount)}
                  />
                  <Kpi
                    label="Accept theirs"
                    value={String(metrics.conflictResolutionStrategy.theirsCount)}
                  />
                  <Kpi
                    label="Manual merge"
                    value={String(metrics.conflictResolutionStrategy.manualMergeCount)}
                  />
                  <Kpi
                    label="Cherry-picks"
                    value={String(metrics.conflictResolutionStrategy.cherryPickCount)}
                  />
                </div>
              </Card>
            </AnimatedCard>
          )}

          {/* Destructive operations summary */}
          {(metrics.resetHards > 0 || metrics.discardedChanges > 0 || metrics.forcePushes > 0) && (
            <AnimatedCard index={8} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Destructive Operations" />
                <div className="grid grid-cols-3 gap-3">
                  <Kpi label="Hard resets" value={String(metrics.resetHards)} />
                  <Kpi label="Discarded changes" value={String(metrics.discardedChanges)} />
                  <Kpi label="Force pushes" value={String(metrics.forcePushes)} />
                </div>
              </Card>
            </AnimatedCard>
          )}

          {/* Recent git timeline */}
          <AnimatedCard index={9}>
            <Card padding="md">
              <SectionHeader title="Recent Git Activity" />
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-ink-muted bg-surface-3 sticky top-0">
                    <tr>
                      <th className="text-left p-2">Time</th>
                      <th className="text-left p-2">Type</th>
                      <th className="text-left p-2">Repo</th>
                      <th className="text-left p-2">Detail</th>
                      <th className="text-left p-2">Duration</th>
                      <th className="text-left p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...metrics.gitCommandTimeline]
                      // Hydrated commits are appended after live events, so
                      // insertion order isn't chronological — sort explicitly.
                      .sort((a, b) => b.timestamp - a.timestamp)
                      .slice(0, 30)
                      .map((e) => (
                        <tr
                          key={`${e.type}-${e.timestamp}`}
                          className="border-t border-border-subtle"
                        >
                          <td className="p-2 tabular-nums text-ink-subtle whitespace-nowrap">
                            {formatEventTime(e.timestamp)}
                          </td>
                          <td className="p-2">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${EVENT_TYPE_COLORS[e.type] ?? 'bg-surface-8 text-ink-subtle'}`}
                            >
                              {formatEventType(e.type)}
                            </span>
                          </td>
                          <td className="p-2 text-ink-subtle whitespace-nowrap">
                            {e.repo ? e.repo.split('/').pop() : '—'}
                          </td>
                          <td
                            className="p-2 max-w-xs truncate"
                            title={e.subject ?? e.command ?? undefined}
                          >
                            {e.url ? (
                              <a
                                href={e.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent-blue hover:underline"
                              >
                                {e.subject ?? 'view commit'}
                              </a>
                            ) : (
                              // Live git events carry no commit subject, but the
                              // command itself is the useful detail for them.
                              (e.subject ?? e.command ?? '—')
                            )}
                          </td>
                          <td className="p-2 tabular-nums text-ink-subtle">
                            {formatMs(e.durationMs)}
                          </td>
                          <td className="p-2">
                            {e.success ? (
                              <span className="text-accent-green">ok</span>
                            ) : (
                              <span className="text-accent-red">fail</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </AnimatedCard>
        </>
      )}
    </section>
  );
}
