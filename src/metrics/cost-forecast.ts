export interface CostForecast {
  readonly elapsedMs: number;
  readonly spentUsd: number;
  readonly rateUsdPerMs: number;
  readonly forecastEndOfDayUsd: number | null;
  readonly forecastEndOfWeekUsd: number | null;
  readonly forecastSessionEndUsd: number | null;
  readonly confidenceNote: string;
}

export function buildCostForecast(
  spentUsd: number,
  sessionStartMs: number,
  nowMs: number = Date.now(),
): CostForecast {
  const elapsedMs = nowMs - sessionStartMs;
  if (elapsedMs < 1) {
    return {
      elapsedMs: 0,
      spentUsd: 0,
      rateUsdPerMs: 0,
      forecastEndOfDayUsd: null,
      forecastEndOfWeekUsd: null,
      forecastSessionEndUsd: null,
      confidenceNote: 'Insufficient data for forecast.',
    };
  }

  // Session is running but nothing has been spent yet — return zero forecasts
  // rather than null so callers can display $0.00 instead of "—".
  if (spentUsd === 0) {
    return {
      elapsedMs,
      spentUsd: 0,
      rateUsdPerMs: 0,
      forecastEndOfDayUsd: 0,
      forecastEndOfWeekUsd: 0,
      forecastSessionEndUsd: 0,
      confidenceNote: 'Session running — no spend recorded yet.',
    };
  }

  const rateUsdPerMs = spentUsd / elapsedMs;

  const now = new Date(nowMs);
  const endOfDay = new Date(now);
  endOfDay.setUTCHours(23, 59, 59, 999);
  const msUntilEndOfDay = endOfDay.getTime() - nowMs;
  const forecastEndOfDayUsd = spentUsd + rateUsdPerMs * msUntilEndOfDay;

  // ISO week ends on Sunday. Convert getUTCDay() (0=Sun…6=Sat) to ISO day (1=Mon…7=Sun)
  // then compute remaining days: Sunday → 0 remaining, Monday → 6, …, Saturday → 1.
  const dayOfWeek = now.getUTCDay();
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  const msUntilEndOfWeek = ((7 - isoDay) % 7) * 86_400_000 + msUntilEndOfDay;
  const forecastEndOfWeekUsd = spentUsd + rateUsdPerMs * msUntilEndOfWeek;

  const SESSION_TARGET_MS = 8 * 60 * 60 * 1000;
  const msUntilSessionEnd = Math.max(0, SESSION_TARGET_MS - elapsedMs);
  const forecastSessionEndUsd = spentUsd + rateUsdPerMs * msUntilSessionEnd;

  const elapsedMinutes = elapsedMs / 60_000;
  const confidenceNote =
    elapsedMinutes < 10
      ? 'Low confidence — less than 10 minutes of data.'
      : elapsedMinutes < 30
        ? 'Moderate confidence — based on less than 30 minutes of data.'
        : 'Reasonable confidence — based on 30+ minutes of data.';

  return {
    elapsedMs,
    spentUsd,
    rateUsdPerMs,
    forecastEndOfDayUsd,
    forecastEndOfWeekUsd,
    forecastSessionEndUsd,
    confidenceNote,
  };
}
