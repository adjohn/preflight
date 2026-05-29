import { useMemo } from 'react';
import { useLiveStore } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { Sparkline } from '../components/Sparkline';

const HEADER_TIMESTAMP_FORMAT = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
} as const;

export function Today(): JSX.Element {
  const recent = useLiveStore((s) => s.recentToolCalls);
  const cost = useLiveStore((s) => s.cost);
  const antiPatterns = useLiveStore((s) => s.antiPatterns);

  const calls = recent.length;
  const todayTotal = cost?.todayTotalUsd ?? 0;
  const sparklineValues = useMemo(() => recent.map((c) => c.durationMs), [recent]);
  const headerTimestamp = useMemo(
    () => new Date().toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT),
    [],
  );
  const recentReversed = useMemo(() => recent.slice().reverse(), [recent]);

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Today</h1>
        <span className="text-xs text-ink-muted">{headerTimestamp}</span>
      </header>

      <div className="grid grid-cols-4 gap-2 mb-3">
        <Kpi label="spend" tone="accent" value={`$${todayTotal.toFixed(2)}`} />
        <Kpi label="calls" value={String(calls)} />
        <Kpi label="eff." tone="good" value="—" sub="needs more data" />
        <Kpi
          label="flags"
          tone={antiPatterns.length > 0 ? 'warn' : 'neutral'}
          value={String(antiPatterns.length)}
        />
      </div>

      <ForecastEodCard todayTotal={todayTotal} forecastEod={cost?.forecastEodUsd ?? null} />

      {antiPatterns.length > 0 && (
        <div className="mb-3 bg-bg-panel border border-accent-amber/40 rounded p-2.5 text-xs">
          <span className="text-accent-amber font-semibold">⚠ {antiPatterns[0].type}</span>
          <span className="text-ink-muted"> — </span>
          <span>{antiPatterns[0].count}× re-edits to </span>
          <code className="bg-bg-line px-1 rounded">{antiPatterns[0].target}</code>
        </div>
      )}

      <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
          tool latency · live
        </div>
        {sparklineValues.length >= 2 ? (
          <Sparkline values={sparklineValues} ariaLabel="Tool call latency, milliseconds" />
        ) : (
          <div className="text-ink-muted text-xs h-[50px] flex items-center">
            Waiting for tool calls…
          </div>
        )}
      </div>

      <div className="bg-bg-panel border border-bg-line rounded p-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">recent</div>
        {recent.length === 0 ? (
          <div className="text-ink-muted text-xs">No calls yet — start a Claude prompt.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-ink-muted">
              <tr>
                <th className="text-left pb-1">tool</th>
                <th className="text-right pb-1">latency</th>
              </tr>
            </thead>
            <tbody>
              {recentReversed.map((c) => (
                <tr key={c.id} className="border-t border-bg-line">
                  <td className="py-1">{c.tool}</td>
                  <td className="py-1 text-right tabular-nums">{c.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function ForecastEodCard({
  todayTotal,
  forecastEod,
}: {
  todayTotal: number;
  forecastEod: number | null;
}): JSX.Element {
  const hasForecast = forecastEod !== null && Number.isFinite(forecastEod);
  const delta = hasForecast ? forecastEod - todayTotal : 0;
  const pct = hasForecast && todayTotal > 0 ? (delta / todayTotal) * 100 : 0;

  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
        forecast · end of day
      </div>
      {hasForecast ? (
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold text-accent-cyan tabular-nums">
            ${forecastEod.toFixed(2)}
          </span>
          <span className="text-xs text-ink-muted tabular-nums">
            +${delta.toFixed(2)}
            {todayTotal > 0 && ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`} from now
          </span>
        </div>
      ) : (
        <div className="text-ink-muted text-xs">
          Insufficient data — forecast appears once burn rate stabilizes.
        </div>
      )}
    </div>
  );
}
