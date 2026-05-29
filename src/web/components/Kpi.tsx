export type KpiTone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const TONE: Record<KpiTone, string> = {
  neutral: 'text-ink-base',
  good: 'text-accent-green',
  warn: 'text-accent-amber',
  bad: 'text-accent-red',
  accent: 'text-accent-cyan',
};

export interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: KpiTone;
}

export function Kpi({ label, value, sub, tone = 'neutral' }: KpiProps): JSX.Element {
  return (
    <div className="bg-bg-panel border border-bg-line rounded p-2.5">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${TONE[tone]}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  );
}
