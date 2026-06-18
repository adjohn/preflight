# Code Review — `src/` (excluding `src/shared/`)

**Date:** 2026-06-15
**Scope:** All TypeScript files under `src/` except `src/shared/` (192 files)
**Method:** 7 parallel finder agents (correctness, security, cross-file, reuse, storage, alerts/tracing, platform/web) → 42 raw candidates → 25 verified → top 10 kept
**Second pass:** 4 more finder agents covering ~100 previously unexamined files → additional 10 confirmed findings appended below

Findings ranked most-severe first.

---

## 1. Team summary NRQL sums a cumulative gauge — ~30× cost inflation

**File:** `src/tools/cross-session-tools.ts:766`
**Severity:** High

```ts
`SELECT sum(ai.cost.session_total_usd.sum) AS totalCost
 FROM Metric WHERE team_id = '${safeTeamId}'
 SINCE ${since} FACET developer LIMIT 50`;
```

`ai.cost.session_total_usd` is a monotonically-growing gauge that records the running session total. Summing all gauge snapshots emitted over the query window multiplies the true value by the number of metric flushes in the window (~12/hour × query hours). Every dollar figure displayed in `nr_observe_get_team_summary` is wildly inflated.

The project's own architecture notes document this as the forbidden pattern. The correct source is `sum(ai.estimated_cost_usd) FROM AiCodingTask`.

---

## 2. Team summary efficiency NRQL queries a non-existent `.sum` rollup attribute

**File:** `src/tools/cross-session-tools.ts:772`
**Severity:** High

```ts
`SELECT average(ai.efficiency.score.sum) AS avgScore
 FROM Metric WHERE team_id = '${safeTeamId}'
 SINCE ${since} FACET developer LIMIT 50`;
```

NR Metrics gauges do not expose a `.sum` rollup field. `ai.efficiency.score.sum` does not exist; the query returns `null` for every developer row. The `toFiniteNumber(row.avgScore, NaN)` path correctly detects the NaN and stores `null`, so the team summary always shows `null` efficiency scores regardless of actual data. The correct attribute is `average(ai.efficiency.score)`.

---

## 3. `requeueBatch()` drops the failed batch on overflow, not the old entries

**File:** `src/transport/log-ingest.ts:173`
**Severity:** High

```ts
private requeueBatch(batch: NrLogEntry[]): void {
  // Prepend failed batch so it retries before any new entries (FIFO order)
  this.buffer = [...batch, ...this.buffer];
  if (this.buffer.length > this.maxBufferSize) {
    const dropped = this.buffer.length - this.maxBufferSize;
    this.buffer = this.buffer.slice(-this.maxBufferSize); // ← drops the front
    logger.warn('Log buffer overflow — oldest entries dropped', { dropped });
  }
}
```

After prepending, `this.buffer` is `[...failedBatch, ...existingBuffer]`. `slice(-maxBufferSize)` keeps the **last** N elements — the back of the array — and discards the **front**, which is the just-prepended failed batch. Under any sustained send failure that fills the buffer, the entries most in need of retry are the first to be dropped. The comment and the logger message both say "oldest entries dropped" but the code does the opposite: it drops the newly-prepended (failed) entries and keeps the newer ones.

**Fix:** trim the existing buffer before prepending rather than after:

```ts
this.buffer = [...batch, ...this.buffer.slice(-(this.maxBufferSize - batch.length))];
```

---

## 4. Inline redaction patterns in `collector-script.ts` omit `ghs_` GitHub Apps tokens

**File:** `src/hooks/collector-script.ts:98`
**Severity:** Medium-High

`config.ts:88` includes `ghs_` in `DEFAULT_REDACTION_PATTERNS`:

```ts
/(?:sk-|ghp_|gho_|ghs_|github_pat_|xoxb-|xoxp-|Bearer\s+)[A-Za-z0-9_-]{20,200}/g;
```

The inline copy in `collector-script.ts` (the comment even says "mirrors config.ts DEFAULT_REDACTION_PATTERNS") is:

```ts
/(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g;
```

`ghs_` is absent. GitHub Apps installation tokens passed as command arguments or in tool output are written unredacted to the on-disk `buffer.jsonl` file. The patterns also diverge on the match-length anchor (`\S+` vs `[A-Za-z0-9_-]{20,200}`), which could match too broadly or too narrowly depending on context.

---

## 5. Session budget alert never clears when new session cost equals the fire-time amount

**File:** `src/alerts/local-alert-engine.ts:451`
**Severity:** Medium

```ts
const sessionReset =
  period === 'session' &&
  state.firedSpentUsd !== undefined &&
  snapshot.cost.sessionUsd < state.firedSpentUsd; // strict less-than
```

This detects a session reset by checking whether the current session cost has dropped below what it was at fire time (i.e. a new session started with lower cost). If the new session's accumulated cost reaches exactly `state.firedSpentUsd` (e.g. both are `0.00` at startup, or costs coincidentally align), `<` is `false` and `sessionReset` stays `false`. The rule remains permanently stuck in `'firing'` state for that new session. Subsequent threshold crossings in the new session are suppressed via the `firedPeriodKey` dedup check, so the user never receives another alert for that period.

**Fix:** use `<=` instead of `<`.

---

## 6. `lastFiredAt` is overwritten at clear time, breaking subsequent dedup windows

**File:** `src/alerts/local-alert-engine.ts:455`
**Severity:** Medium

```ts
if (storedPeriodKey !== currentPeriodKey || sessionReset) {
  state.status = 'idle';
  const lastFiredAt = state.lastFiredAt;  // captured for the cleared event
  state.lastFiredAt = now;                // ← overwrites with clear time
  ...
}
```

After clearing, `state.lastFiredAt` holds the clear timestamp. When the new period immediately crosses the threshold again (e.g. within seconds of the clear), the deduplication check `now - state.lastFiredAt < deduplicateSeconds` (evaluated on the next re-fire) measures from the clear time rather than the original fire time. This silently suppresses the re-fire for up to `deduplicateSeconds` into the new period.

`lastFiredAt` should only be updated when an alert is **fired**, not when it clears.

---

## 7. Efficiency score displayed as `X/100` in Slack digest but the range is `[0, 1]`

**File:** `src/digest/digest-formatter.ts:22`
**Severity:** Medium

```ts
{ type: 'mrkdwn', text: `*Avg Efficiency:*\n${avgEfficiency}/100` },
```

`avgEfficiency` is `summary.avgEfficiencyScore?.toFixed(1)`, where `avgEfficiencyScore` is the average of per-session `efficiency.score` values. `EfficiencyScorer` clamps scores to `[0, 1]` (not `[0, 100]`). Every Slack digest sent via `nr_observe_send_digest` displays values like `0.8/100` instead of `80/100`, making scores appear near-zero to all recipients.

**Fix:** multiply by 100 before displaying: `(summary.avgEfficiencyScore * 100)?.toFixed(1)`.

---

## 8. `buildDailyGrid` uses UTC day boundaries; server-side uses local time

**File:** `src/web/lib/bucket.ts:46`
**Severity:** Medium

```ts
startDate.setUTCDate(startDate.getUTCDate() - weeks * 7);
startDate.setUTCHours(0, 0, 0, 0);
// ...
dayMap.set(cursor.toISOString().slice(0, 10), 0); // UTC key
// ...
const key = d.toISOString().slice(0, 10); // UTC key for session lookup
```

The day-map keys and the per-session lookup key both use UTC midnight boundaries. `src/lib/date.ts` exports `localDateKey()` / `localStartOfDay()` (using `getHours`/`setHours`) specifically for this purpose — the file comment explains the containerized-UTC vs. browser-local-time problem this was created to solve. For users in UTC-offset timezones, sessions occurring near local midnight are bucketed to the wrong calendar day, causing the activity heatmap to misattribute tool call counts relative to the cost and session panels that use `localDateKey()`.

---

## 9. `r.json()` called before `r.ok` check — non-JSON error bodies throw `SyntaxError`

**File:** `src/web/api/client.ts:92, 99`
**Severity:** Medium

```ts
// patchSettings
.then(async (r) => {
  const json = (await r.json()) as unknown;  // throws SyntaxError on HTML error pages
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return json;
});

// postDigestSend (same pattern)
.then(async (r) => {
  const json = (await r.json()) as unknown;
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return json;
});
```

When the server returns a 502/504 with an HTML body, `r.json()` throws a `SyntaxError` before the `if (!r.ok)` guard is reached. The caller receives an opaque parse error with no HTTP status code, endpoint path, or actionable context.

**Fix:** check `r.ok` first:

```ts
if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
return (await r.json()) as unknown;
```

---

## 10. `hasAnimated.current` never resets — count-up animation only fires on first mount

**File:** `src/web/hooks/useAnimatedValue.ts:24`
**Severity:** Low

```ts
const hasAnimated = useRef(false);

useEffect(() => {
  if (!shouldAnimate || hasAnimated.current) {
    setCurrent(target); // snap to value, no animation
    return;
  }
  hasAnimated.current = true;
  // ... rAF animation loop
}, [target, duration, shouldAnimate]);
```

`hasAnimated.current` is set to `true` on the first animation and is **never reset**. When `target` changes on subsequent renders (e.g. a live cost value updating), `useEffect` re-runs but `hasAnimated.current` is already `true`, so the guard fires immediately and `setCurrent(target)` is called with no animation. Every value change after the initial mount snaps instantly. If the intended behavior is one animation per session, this is correct — but if the intent is to animate each new value, the ref needs to be reset before the rAF loop or removed in favor of comparing `current !== target`.

---

## Second Pass — Additional Findings

---

## 11. Efficiency highlight/regression thresholds are unreachable dead code

**File:** `src/metrics/personal-coach.ts:212`
**Severity:** High

```ts
const delta = thisWeek.avgEfficiencyScore - baseline.avgEfficiencyScore;
if (delta >= 5) {
  highlights.push(
    `Your efficiency score this week (${thisWeek.avgEfficiencyScore.toFixed(0)}) is ${delta.toFixed(0)} points above your historical average.`,
  );
}
// ...
if (delta <= -5) {
  regressions.push(
    `Your efficiency score dropped ${Math.abs(delta).toFixed(0)} points below your historical average.`,
  );
}
```

`avgEfficiencyScore` is the raw value from `EfficiencyScorer`, which clamps every score to `[0, 1]` (see `efficiency-score.ts` line 90: `clamp(Math.round(raw * 1000) / 1000, 0, 1)`). The maximum possible delta between any two `[0, 1]` values is 1.0. Neither `delta >= 5` nor `delta <= -5` can ever be true. Efficiency highlights and regressions are permanently dead code — the personal coach report never produces an efficiency observation regardless of how much the score improves or degrades.

The `toFixed(0)` display on line 214 also prints `0` or `1` (the raw value) rather than a human-readable percentage.

**Fix:** multiply by 100 before comparing (threshold `>= 5` maps to `>= 0.05` on the raw scale, or compare against `thisWeek.avgEfficiencyScore * 100`).

---

## 12. `compareWeeks` treats "no baseline data" identically to "no data in either week" for efficiency

**File:** `src/metrics/trend-analyzer.ts:251`
**Severity:** Medium

```ts
efficiencyPctChange:
  effA === null && effB === null ? null : percentChange(effA ?? 0, effB ?? 0),
```

`percentChange(oldValue, newValue)` returns `null` whenever `oldValue === 0` and `newValue !== 0` (there is no meaningful percentage from zero). When week A had no efficiency data (`effA === null`), `effA ?? 0` passes `0` as `oldValue`. If week B has real data (`effB = 0.8`), `percentChange(0, 0.8)` returns `null` — indistinguishable from the "both weeks null" case. A developer's first full week of efficiency data will always show `null` for `efficiencyPctChange` rather than indicating "new data / no baseline", making trend reports silent for new users.

The same `?? 0` pattern also causes a valid "efficiency improved from 0% to 80%" to look like no data.

---

## 13. All-skipped test run classified as `failed_attempt`

**File:** `src/metrics/cost-per-outcome.ts:312`
**Severity:** Medium

```ts
if (s.testRunCount > 0 && s.testPassCount === 0) return 'failed_attempt';
```

This condition fires whenever tests ran but zero passed — which includes sessions where an entire test suite was skipped or pending (Jest `--testPathPattern` matched zero tests, or all tests were `it.skip`). A session that produced valid feature work but ran a suite of all-pending tests is permanently classified as `failed_attempt`, inflating `wasteRatio` and deflating the `completed` count. There is no signal for skipped/pending vs genuinely-failed tests in the current `FullSessionSummary` shape, so the only conservative fix is to gate this classification on an explicit failure signal (e.g. `testFailCount > 0`) rather than the absence of passes.

---

## 14. Backtrack detection fires on legitimate post-edit verification reads

**File:** `src/metrics/quality-proxy-tracker.ts:97`
**Severity:** Medium

```ts
// Detect backtrack: Read of a file we recently edited
if (record.toolName === 'Read' && this.lastEditFile !== null) {
  if (filePath === this.lastEditFile && turn - this.lastEditTurn <= 2) {
    this.addEvent('backtrack', turn, record.toolName);
  }
}
```

`lastEditFile` is set on every successful or failed Edit/Write call — there is no check on `record.success`. The standard Claude Code workflow is Edit → Read (verify the change). That Read always matches `lastEditFile` and is within 2 turns, so it is always counted as a backtrack regardless of whether the edit succeeded. Every normal post-edit verification read inflates `backtrackCount` and degrades `diffApplyRate`. A backtrack should only be recorded when the edit failed or a test failure prompted the re-read.

---

## 15. `isOutputReferenced` size heuristic gives false positives on unrelated large inputs

**File:** `src/metrics/tool-selection-scorer.ts:252`
**Severity:** Medium

```ts
// For any tool: if subsequent calls have non-trivial input that likely
// incorporates this output, consider it referenced. Check the next 5 calls.
const lookAhead = subsequentCalls.slice(0, 5);
for (const call of lookAhead) {
  const inputSize = call.inputSizeBytes ?? 0;
  if (inputSize > 500) return true;
}
```

After the file-path check for `Read` sources, the fallback heuristic returns `true` for any tool call in the next 5 whose `inputSizeBytes > 500`. There is no relationship check — a large Bash script, a long path argument, or any other unrelated large-input call in the window fully satisfies "referenced." In active sessions with frequent large Bash invocations (scripts, grep pipelines, build commands), virtually every tool output is marked as referenced regardless of whether it was actually used. `unusedOutputCount` is near-zero in any busy session, making the tool-selection quality score unreliable.

---

## 16. Cost trend arrow is semantically inverted

**File:** `src/metrics/trend-analyzer.ts:341`
**Severity:** Medium

```ts
// Lower cost = improvement, so flip arrow
const arrow = pct <= 0 ? '↑' : '↓';
costStr += ` (${arrow}${Math.abs(pct)}% vs prev)`;
```

The intent expressed in the comment is that ↑ signals improvement (lower cost = good). But the arrow chosen (`↑` when `pct <= 0`, i.e. cost decreased) looks like cost went **up** to any reader who interprets arrows as directional movement indicators. A session where cost jumped 40% displays `↓40% vs prev` — visually suggesting a 40% improvement — while a 40% cost reduction displays `↑40% vs prev` — visually suggesting cost spiked. Every other metric in the same `generateWeekSummary` function uses `pct >= 0 ? '↑' : '↓'` (direction of the value), making cost the only counter-convention metric.

---

## 17. Backslash not escaped in dashboard entity-search Lucene query

**File:** `src/deploy/deploy-dashboards.ts:190`
**Severity:** Medium

```ts
query: `type = 'DASHBOARD' AND name = '${name.replace(/'/g, "\\'")}' AND accountId = ${accountId}`,
```

Single quotes are escaped, but backslashes are not. A dashboard named `AI\Coding` produces the fragment `name = 'AI\Coding'` in which the backslash is a Lucene escape character, either mangling the name match or producing a NerdGraph query error. Both `--update` and `--teardown` call `findDashboardGuid` to locate the existing dashboard; a `\`-containing name causes both operations to silently fail to find the dashboard, with the `--update` path then creating a duplicate instead of updating, and `--teardown` doing nothing.

**Fix:** escape backslashes before escaping single quotes: `name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")`

---

## 18. `parseInt` allows negative account IDs to reach NerdGraph

**File:** `src/deploy/deploy-alerts.ts:427`
**Severity:** Low-Medium

```ts
const accountId = parseInt(accountIdStr, 10);
if (Number.isNaN(accountId)) { ... }
```

`parseInt('-1', 10)` returns `-1`, which passes `Number.isNaN`. Negative values and partial-parse strings like `'123abc'` (which parse to `123`) are forwarded to NerdGraph as the `Int!` account ID argument. NerdGraph will reject them with an opaque API error rather than a local validation failure with a helpful message. The same pattern exists in `deploy-dashboards.ts`.

---

## 19. `resolveBinaryPath` accepts non-executable files

**File:** `src/install/schedule.ts:115`
**Severity:** Low

```ts
if (statSync(candidate).isFile()) return candidate;
```

`isFile()` returns `true` for any regular file, including one without execute permission (e.g. mode `0o644`). If `npm install` fails to set the execute bit on the binary (a known `tsc` strips-execute-bits issue documented in project memory), `resolveBinaryPath` returns the non-executable path, it is written into the LaunchAgent plist, and scheduled update jobs silently fail at runtime with a permission error. Since launchd failures are written to a log file rather than the terminal, the user has no feedback that scheduled updates are broken.

**Fix:** add an `accessSync(candidate, fs.constants.X_OK)` check after `isFile()`.

---

## 20. `readRecent` has a narrow race window during log rotation

**File:** `src/alerts/alert-log.ts:86`
**Severity:** Low

`readRecent()` fires `Promise.all([readLines(path), readLines(path.1)])`. Log rotation renames `log.jsonl` → `log.jsonl.1` and then appends the triggering event to a new `log.jsonl`. Between the `rename` and the subsequent `appendFile`, the primary file does not exist. A concurrent `readRecent` call in that window gets `ENOENT` on the primary (caught, returns `[]`) while reading the pre-rotation content from `.1`. The event that triggered the rotation is in neither file — it was the reason `appendFile` is about to run. The combined read silently omits that one event. This is a narrow window under normal load, but it can produce an empty alert history display immediately after the first rotation.
