export interface BucketOptions {
  readonly startMs: number;
  readonly endMs: number;
  readonly bucketSizeMs: number;
}

export function bucketTimeline(
  entries: ReadonlyArray<{ timestamp: number }>,
  options: BucketOptions,
): number[] {
  const { startMs, endMs, bucketSizeMs } = options;
  const bucketCount = Math.max(1, Math.ceil((endMs - startMs) / bucketSizeMs));
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const entry of entries) {
    const idx = Math.floor((entry.timestamp - startMs) / bucketSizeMs);
    if (idx >= 0 && idx < bucketCount) {
      buckets[idx]++;
    }
  }
  return buckets;
}

export function autoBucketSize(durationMs: number): number {
  if (durationMs < 600_000) return 30_000;
  if (durationMs < 3_600_000) return 60_000;
  if (durationMs < 14_400_000) return 300_000;
  return 900_000;
}

export interface DailyGridDay {
  readonly date: string;
  readonly count: number;
}

export interface DailyGridResult {
  readonly days: DailyGridDay[];
  readonly maxCount: number;
}

export function buildDailyGrid(
  sessions: ReadonlyArray<{ startTime?: number | string; toolCallCount?: number }>,
  weeks: number,
): DailyGridResult {
  const now = new Date();
  // Use local-time arithmetic so day boundaries match the server-side localDateKey() used
  // for session bucketing. UTC boundaries would misattribute sessions near local midnight.
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weeks * 7);

  const dayMap = new Map<string, number>();
  const cursor = new Date(startDate);
  while (cursor <= now) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    dayMap.set(key, 0);
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const s of sessions) {
    if (!s.startTime) continue;
    const d = new Date(typeof s.startTime === 'number' ? s.startTime : s.startTime);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (dayMap.has(key)) {
      dayMap.set(key, (dayMap.get(key) ?? 0) + (s.toolCallCount ?? 0));
    }
  }

  const days = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));
  const maxCount = Math.max(...days.map((d) => d.count), 1);
  return { days, maxCount };
}
