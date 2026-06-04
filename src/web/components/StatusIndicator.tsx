export type StatusTone = 'good' | 'warn' | 'bad' | 'neutral';

const TONE_CLASS: Record<StatusTone, string> = {
  good: 'text-accent-green',
  warn: 'text-accent-amber',
  bad: 'text-accent-red',
  neutral: 'text-ink-muted',
};

export interface StatusIndicatorProps {
  readonly tone: StatusTone;
  readonly label: string;
  readonly className?: string;
}

export function StatusIndicator({ tone, label, className }: StatusIndicatorProps): JSX.Element {
  const classes = `${TONE_CLASS[tone]} text-xs${className ? ` ${className}` : ''}`;
  return (
    <div className={classes}>
      <span aria-hidden="true">● </span>
      {label}
    </div>
  );
}
