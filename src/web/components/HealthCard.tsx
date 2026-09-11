import type { JSX } from 'react';

import { Panel, Pill, type PillTone } from './ui';

export type HealthTone = 'good' | 'warn' | 'bad' | 'neutral';

export interface HealthCardStatus {
  readonly tone: HealthTone;
  readonly label: string;
}

export interface HealthCardRow {
  readonly label: string;
  readonly value: string;
}

export interface HealthCardProps {
  readonly title: string;
  readonly tooltip?: string;
  readonly value: string;
  readonly status?: HealthCardStatus;
  readonly detail?: string;
  readonly rows?: ReadonlyArray<HealthCardRow>;
}

// Same tone tokens as Kpi.tsx's TONE map, kept local since that map isn't exported.
const VALUE_TONE_CLASS: Record<HealthTone, string> = {
  good: 'text-accent-green',
  warn: 'text-accent-amber',
  bad: 'text-accent-red',
  neutral: 'text-ink-base',
};

const STATUS_PILL_TONE: Record<HealthTone, PillTone> = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
  neutral: 'neutral',
};

export function HealthCard({
  title,
  tooltip,
  value,
  status,
  detail,
  rows,
}: HealthCardProps): JSX.Element {
  return (
    <Panel title={title} tooltip={tooltip}>
      <div className="flex items-center gap-2">
        <span className={`text-2xl font-semibold ${VALUE_TONE_CLASS[status?.tone ?? 'neutral']}`}>
          {value}
        </span>
        {status && <Pill tone={STATUS_PILL_TONE[status.tone]}>{status.label}</Pill>}
      </div>
      {detail && <div className="mt-1 text-[10px] text-ink-muted">{detail}</div>}
      {rows && rows.length > 0 && (
        <div className="mt-3 space-y-1">
          {rows.slice(0, 4).map((row) => (
            <div key={row.label} className="flex items-center justify-between text-[11px]">
              <span className="text-ink-muted">{row.label}</span>
              <span className="text-ink-base tabular-nums">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
