import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import {
  fetchWeekly,
  fetchSessionsList,
  fetchCostPerOutcome,
  fetchPersonalCoach,
  qk,
} from '../api/client';

interface WeeklyRow {
  readonly weekStart?: string;
  readonly week?: string;
  readonly efficiencyScore?: number;
  readonly avgEfficiencyScore?: number | null;
  readonly totalCostUsd: number;
  readonly antiPatternCounts?: Record<string, number>;
}

interface SessionRow {
  readonly sessionId: string;
  readonly startTime?: string | number;
  readonly estimatedCostUsd?: number | null;
  readonly model?: string | null;
  readonly toolSuccessRate?: number | null;
  readonly efficiencyScore?: number | null;
  readonly toolCallCount?: number;
  readonly toolBreakdown?: Record<string, number>;
}

interface OutcomeBucket {
  readonly count: number;
  readonly totalCost: number;
  readonly avgCost: number;
}

interface CostPerOutcomeResponse {
  readonly outcomeDistribution: Record<string, OutcomeBucket>;
  readonly wasteRatio: number;
  readonly totalCost: number;
  readonly totalTasks: number;
}

interface PersonalCoachOk {
  readonly status: 'ok';
  readonly highlights: readonly string[];
  readonly regressions: readonly string[];
  readonly streaks: readonly string[];
  readonly topRecommendation: string;
}

interface PersonalCoachInsufficient {
  readonly status: 'insufficient_data';
  readonly message: string;
}

type PersonalCoachResult = PersonalCoachOk | PersonalCoachInsufficient;

const TICK_STYLE = { fill: '#94a3b8', fontSize: 10 };
const GRID_STROKE = '#1e293b';
const ACCENT = '#22d3ee';
const ACCENT_AMBER = '#f59e0b';
const ACCENT_GREEN = '#34d399';

// Render only the month-day portion of an ISO `YYYY-MM-DD` axis label
// while keeping the full year-prefixed string in the chart data so
// cross-year ticks remain unique.
function shortMonthDay(value: string): string {
  return typeof value === 'string' && value.length >= 10 ? value.slice(5, 10) : value;
}

export function History(): JSX.Element {
  const weekly = useQuery<WeeklyRow[]>({
    queryKey: qk.weekly,
    queryFn: () => fetchWeekly() as Promise<WeeklyRow[]>,
  });

  const sessions = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200) as Promise<SessionRow[]>,
  });

  const costPerOutcome = useQuery<CostPerOutcomeResponse>({
    queryKey: qk.costPerOutcome(30),
    queryFn: () => fetchCostPerOutcome(30) as Promise<CostPerOutcomeResponse>,
  });

  const coach = useQuery<PersonalCoachResult>({
    queryKey: qk.personalCoach,
    queryFn: () => fetchPersonalCoach() as Promise<PersonalCoachResult>,
  });

  // API returns newest-first; reverse for chronological left-to-right chart rendering
  const weeklyChronological = [...(weekly.data ?? [])].reverse();
  const weeklyData = weeklyChronological.map((w) => {
    const fullDate = w.weekStart ?? w.week ?? '';
    const score = w.efficiencyScore ?? w.avgEfficiencyScore ?? 0;
    return { week: fullDate || '?', efficiency: Math.round((score ?? 0) * 100) };
  });

  const dailyData = aggregateDailyCost(sessions.data ?? [], 30);
  const outcomeData = buildOutcomeData(costPerOutcome.data);
  const antiPatternSeries = buildAntiPatternSeries(weeklyChronological);
  const modelPerf = aggregateModelPerformance(sessions.data ?? []);
  const topTools = aggregateToolUsage(sessions.data ?? []);

  return (
    <section>
      <h1 className="text-xl font-semibold mb-4">History</h1>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Weekly efficiency · last 8">
          <div className="h-44 min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={weeklyData}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis
                  dataKey="week"
                  tick={TICK_STYLE}
                  stroke={GRID_STROKE}
                  tickFormatter={shortMonthDay}
                />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} domain={[0, 100]} unit="%" />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="efficiency"
                  stroke={ACCENT}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Daily spend · last 30 days">
          <div className="h-44 min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={dailyData}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={TICK_STYLE} stroke={GRID_STROKE} />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="cost" fill={ACCENT} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Cost per outcome · last 30 days">
          {outcomeData.length === 0 ? (
            <EmptyState text="No outcomes yet — finish a few sessions and check back." />
          ) : (
            <div className="h-44 min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={outcomeData} layout="vertical">
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis type="number" tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                  <YAxis
                    type="category"
                    dataKey="outcome"
                    tick={TICK_STYLE}
                    stroke={GRID_STROKE}
                    width={90}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="totalCost" fill={ACCENT} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Anti-pattern frequency · weekly">
          {antiPatternSeries.length === 0 ? (
            <EmptyState text="No anti-patterns detected in the loaded weeks." />
          ) : (
            <div className="h-44 min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={antiPatternSeries}>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="week"
                    tick={TICK_STYLE}
                    stroke={GRID_STROKE}
                    tickFormatter={shortMonthDay}
                  />
                  <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" fill={ACCENT_AMBER} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Model performance">
          {modelPerf.length === 0 ? (
            <EmptyState text="No model data yet — complete a few sessions." />
          ) : (
            <div className="h-44 overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="text-ink-muted sticky top-0 bg-bg-panel">
                  <tr>
                    <th className="text-left pb-1">Model</th>
                    <th className="text-right pb-1">Sessions</th>
                    <th className="text-right pb-1">Eff.</th>
                    <th className="text-right pb-1">Success</th>
                    <th className="text-right pb-1">Avg $</th>
                  </tr>
                </thead>
                <tbody>
                  {modelPerf.map((m) => (
                    <tr key={m.model} className="border-t border-bg-line">
                      <td className="py-1 font-medium">{m.model}</td>
                      <td className="py-1 text-right tabular-nums">{m.sessions}</td>
                      <td className="py-1 text-right tabular-nums">
                        {m.avgEfficiency !== null ? `${Math.round(m.avgEfficiency * 100)}%` : '—'}
                      </td>
                      <td
                        className={`py-1 text-right tabular-nums ${m.flagged ? 'text-accent-amber' : ''}`}
                      >
                        {m.avgSuccessRate !== null ? `${Math.round(m.avgSuccessRate * 100)}%` : '—'}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {m.avgCost !== null ? `$${m.avgCost.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {modelPerf.some((m) => m.flagged) && (
                <div className="text-accent-amber text-[10px] mt-1">
                  ⚠ Highlighted models had sessions with elevated error rates
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Top tools · all sessions">
          {topTools.length === 0 ? (
            <EmptyState text="No tool data yet." />
          ) : (
            <div className="h-44 min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={topTools} layout="vertical">
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis type="number" tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <YAxis
                    type="category"
                    dataKey="tool"
                    tick={TICK_STYLE}
                    stroke={GRID_STROKE}
                    width={100}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" fill={ACCENT_GREEN} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-3">
        <CoachCard data={coach.data} />
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return <div className="text-ink-muted text-xs h-44 flex items-center">{text}</div>;
}

function CoachCard({ data }: { data: PersonalCoachResult | undefined }): JSX.Element {
  if (!data) {
    return (
      <Panel title="Personal coach">
        <div className="text-ink-muted text-xs">Loading coaching insights…</div>
      </Panel>
    );
  }
  if (data.status === 'insufficient_data') {
    return (
      <Panel title="Personal coach">
        <div className="text-ink-muted text-xs">{data.message}</div>
      </Panel>
    );
  }
  return (
    <Panel title="Personal coach">
      <div className="text-xs space-y-2">
        <div>
          <span className="text-accent-cyan font-semibold">Top recommendation: </span>
          {data.topRecommendation}
        </div>
        {data.highlights.length > 0 && (
          <ul className="list-disc list-inside text-emerald-400">
            {data.highlights.map((h) => (
              <li key={`hl-${h}`}>{h}</li>
            ))}
          </ul>
        )}
        {data.regressions.length > 0 && (
          <ul className="list-disc list-inside text-amber-400">
            {data.regressions.map((r) => (
              <li key={`rg-${r}`}>{r}</li>
            ))}
          </ul>
        )}
        {data.streaks.length > 0 && (
          <ul className="list-disc list-inside text-ink-muted">
            {data.streaks.map((s) => (
              <li key={`st-${s}`}>{s}</li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

export function aggregateDailyCost(
  rows: SessionRow[],
  days: number,
): Array<{ day: string; cost: number }> {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.estimatedCostUsd == null || r.startTime == null) continue;
    const d = new Date(r.startTime);
    // Use local-time getters so a session at 10pm UTC-5 lands on its
    // local day, not the UTC day after.
    const day = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(day, (byDay.get(day) ?? 0) + r.estimatedCostUsd);
  }
  const sorted = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.slice(-days).map(([day, cost]) => ({ day, cost: Number(cost.toFixed(2)) }));
}

export function buildOutcomeData(
  resp: CostPerOutcomeResponse | undefined,
): Array<{ outcome: string; totalCost: number; count: number }> {
  if (!resp) return [];
  return Object.entries(resp.outcomeDistribution)
    .map(([outcome, b]) => ({
      outcome: outcome.replace(/_/g, ' '),
      totalCost: Number(b.totalCost.toFixed(2)),
      count: b.count,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}

export function buildAntiPatternSeries(weeks: WeeklyRow[]): Array<{ week: string; count: number }> {
  const out: Array<{ week: string; count: number }> = [];
  for (const w of weeks) {
    const counts = w.antiPatternCounts ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      out.push({ week: (w.weekStart ?? w.week ?? '') || '?', count: total });
    }
  }
  return out;
}

export interface ModelPerformanceRow {
  readonly model: string;
  readonly sessions: number;
  readonly avgEfficiency: number | null;
  readonly avgSuccessRate: number | null;
  readonly avgCost: number | null;
  readonly flagged: boolean;
}

const FLAGGED_SUCCESS_THRESHOLD = 0.85;

export function aggregateModelPerformance(rows: SessionRow[]): ModelPerformanceRow[] {
  const byModel = new Map<
    string,
    {
      sessions: number;
      effSum: number;
      effCount: number;
      successSum: number;
      successCount: number;
      costSum: number;
      costCount: number;
      lowSuccessSessions: number;
    }
  >();

  for (const r of rows) {
    const model = r.model ?? 'unknown';
    let entry = byModel.get(model);
    if (!entry) {
      entry = {
        sessions: 0,
        effSum: 0,
        effCount: 0,
        successSum: 0,
        successCount: 0,
        costSum: 0,
        costCount: 0,
        lowSuccessSessions: 0,
      };
      byModel.set(model, entry);
    }
    entry.sessions++;
    if (r.efficiencyScore != null) {
      entry.effSum += r.efficiencyScore;
      entry.effCount++;
    }
    if (r.toolSuccessRate != null) {
      entry.successSum += r.toolSuccessRate;
      entry.successCount++;
      if (r.toolSuccessRate < FLAGGED_SUCCESS_THRESHOLD) {
        entry.lowSuccessSessions++;
      }
    }
    if (r.estimatedCostUsd != null) {
      entry.costSum += r.estimatedCostUsd;
      entry.costCount++;
    }
  }

  const result: ModelPerformanceRow[] = [];
  for (const [model, e] of byModel) {
    result.push({
      model,
      sessions: e.sessions,
      avgEfficiency: e.effCount > 0 ? e.effSum / e.effCount : null,
      avgSuccessRate: e.successCount > 0 ? e.successSum / e.successCount : null,
      avgCost: e.costCount > 0 ? e.costSum / e.costCount : null,
      flagged: e.lowSuccessSessions > 0,
    });
  }

  return result.sort((a, b) => b.sessions - a.sessions);
}

export function aggregateToolUsage(rows: SessionRow[]): Array<{ tool: string; count: number }> {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!r.toolBreakdown) continue;
    for (const [tool, count] of Object.entries(r.toolBreakdown)) {
      totals.set(tool, (totals.get(tool) ?? 0) + count);
    }
  }
  return Array.from(totals.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}
