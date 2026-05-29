export interface SparklineProps {
  readonly values: number[];
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
  readonly ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 280,
  height = 50,
  stroke = '#22d3ee',
  ariaLabel,
}: SparklineProps): JSX.Element | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const a11yProps = ariaLabel
    ? { role: 'img' as const, 'aria-label': describeSparkline(ariaLabel, values) }
    : { 'aria-hidden': true as const };
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height }}
      {...a11yProps}
    >
      <polyline fill="none" stroke={stroke} strokeWidth={1.5} points={points} />
    </svg>
  );
}

function describeSparkline(label: string, values: number[]): string {
  const first = values[0];
  const last = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return `${label}: ${values.length} points, start ${fmt(first)}, end ${fmt(last)}, min ${fmt(min)}, max ${fmt(max)}`;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}
