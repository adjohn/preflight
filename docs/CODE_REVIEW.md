# Code Review — Full Codebase (src/, excluding shared)

Reviewed 2026-06-05. Covers all source files under `src/` except `src/shared/` (read-only mirror).

Severity scale: **critical** (will crash/corrupt in normal use) · **security** · **bug** (wrong behavior) · **edge-case** (fails on unusual but reachable inputs) · **cleanup** (code quality / latent hazard)

---

## src/hooks

### `src/hooks/collector-script.ts`

- ✅ **Line 104 · edge-case** — `JSON.stringify(input) ?? ''` nullish coalesce is dead code. `JSON.stringify` never returns `null`/`undefined`; on circular input it throws, propagating up through `processHook` uncaught.

- ✅ **Line 111 · edge-case** — `sizeOf` calls `JSON.stringify(value)` which throws on circular references, bubbling up through `processHook` with no try/catch.

- ✅ **Line 144 · bug** — Windows path munging: `cwd.replace(/\//g, '-')` only strips forward slashes. On Windows (backslash paths) the replacement is a no-op, producing a wrong transcript directory and silently losing token collection.

- ✅ **Lines 539–550 · bug** — PIPE_BUF trim converts the structured `toolInput` object to a truncated JSON string. `event-processor.ts` then passes this string to `parseToolSpecificFields` which expects an object; all input parsers are skipped and `toolFields` returns `{}`. File paths, commands, and all tool metadata are silently lost.

- ✅ **Line 80 · edge-case** — PEM redaction regex `-----BEGIN[\s\S]{0,65536}?-----END` can catastrophically backtrack on inputs that contain `-----BEGIN` with no matching `-----END`. The `MAX_REDACT_LEN` cap helps but does not eliminate the O(n²) worst case.

- ✅ **Line 241 · edge-case** — `currentSize <= lastSize` skips token collection when the transcript file is rotated to a smaller size. The condition should also reset `lastSize` to 0 when `currentSize < lastSize`.

- ✅ **Line 60 · security** — `getHighSecurity()` reads `~/.nr-ai-observe/config.json` on every call with no caching. TOCTOU: the file can change between check and use. An attacker who can write to that file can suppress high-security mode, disabling redaction. Should be cached at module load time.

### `src/hooks/event-processor.ts`

- ✅ **Lines 186–193 · bug** — When a post-event has no `toolUseId`, `findOldestPendingKey` compares `v.tool === tool` with no case normalization. A tool name that differs in case between pre/post events fails to match and emits a spurious orphan record.

- ✅ **Lines 243–262 · edge-case** — Token field casts `?? 0` don't protect against `NaN`. `NaN ?? 0` evaluates to `NaN`, which corrupts all downstream cost calculations if the JSONL buffer contains a `NaN` value.

- ✅ **Line 175 · edge-case** — `this.pending.keys().next().value as string` is a type lie; if the Map were ever empty this would pass `undefined` to `delete`, silently becoming a no-op and leaking the pending entry.

### `src/hooks/tool-parsers.ts`

- ✅ **Line 19 vs collector-script.ts line 120 · bug** — Two copies of `countLines` disagree on empty string: `tool-parsers.ts` returns `0`, `collector-script.ts` returns `1`. This produces inconsistent `lineCount` values for the same file write depending on which code path runs.

---

## src/index.ts, src/server.ts, src/config.ts, src/types.ts

### `src/index.ts`

- ✅ **Line ~362 · edge-case** — `logResult.stdout` truthy check fails for the empty string `''` (zero commits). The guard should be `logResult.stdout !== null`; the actual processing via `filter(Boolean)` is correct but the branch is never entered when git returns no output.

- ✅ **Line ~356 · edge-case** — `--since` git log uses a UTC date string with no timezone suffix. Git interprets it as local time. On UTC+ machines the UTC date differs from the local date, causing commits from the current day to be missed.

- ✅ **Line ~515–527 · edge-case** — `fs.watch` is called on the alert rules path unconditionally even if the file does not yet exist. On Linux, watching a non-existent file throws `ENOENT`. The outer catch handles it, but the watcher is never set up and file-created events are never observed; the process must be restarted once the rules file is created.

- ✅ **Line ~1096 · edge-case** — `computeHistoricalCosts` catch block silently falls back to `priorDailyCostUsd = 0` with no log. A corrupt session file masks all historical cost context; budget tracker thresholds then fire at wrong percentages for the rest of the session.

### `src/config.ts`

- ✅ **Line ~210 · security** — `inferDeveloper()` calls `execSync('git config user.name')` without an `env` override, inheriting the full process environment. An attacker controlling `GIT_DIR`, `GIT_CONFIG_NOSYSTEM`, or `GIT_CONFIG_GLOBAL` can redirect git to an arbitrary config file. `inferProjectId` correctly passes `env: { ...process.env }`.

- ✅ **Line ~317 · edge-case** — `parseOtlpHeaders` splits on `=` using array destructuring, truncating header values that contain `=` (e.g. base64-encoded `Bearer abc==` becomes `Bearer abc`). Fix: use `pair.slice(pair.indexOf('=') + 1)` for the value.

- ✅ **Line ~862 · cleanup** — `redactSensitive` creates 17 new `RegExp` objects per call to reset `lastIndex`. For high-throughput hook processing this is unnecessary allocation. Reset `pattern.lastIndex = 0` directly instead.

- ✅ **Line ~89 · edge-case** — PEM regex in `DEFAULT_REDACTION_PATTERNS` has the same catastrophic-backtracking risk as in `collector-script.ts` (same root cause, same fix needed).

---

## src/metrics — anti-patterns, api-failure, budget, claudemd, collaboration, context trackers

### `src/metrics/anti-patterns.ts`

- ✅ **Line ~140 · edge-case** — Thrashing cycle counter reset targets `lastEditFile` (the most recently edited file), not the file that was tested. If the sequence is `Edit(A) → Edit(B) → Bash(test:pass)`, B's counter is reset even though B was never tested; A's prior failures are silently abandoned.

- ✅ **Line ~303 · edge-case** — Over-delegation uses `>` rather than `>=` (threshold 3), so it fires at 4 agent calls. All other detectors use `>=` and fire at 3. The asymmetry appears unintentional.

- ✅ **Line ~262 · edge-case** — A successful build/lint clears `editStreaks` for all files, not just the files exercised by that build. A legitimate `blind_editing` pattern can be suppressed by an unrelated passing build.

### `src/metrics/api-failure-tracker.ts`

- ✅ **Line ~280 · bug** — `totalModelRequests = latencies.length || modelEvents.length`. For a model with no `recordRequest` calls (latency array empty), failure count is both numerator and denominator, so `failureRate` is always `1.0` for models that only appear in failure events.

- ✅ **Line ~109 · edge-case** — Latency arrays are capped at `maxEvents` per model but there is no total cap across all models. With many distinct models, total memory usage is unbounded (`maxEvents × N models`).

### `src/metrics/budget-tracker.ts`

- ✅ **Line ~88 · bug** — Week ID computation fails near ISO week year boundaries. `Date.getDay() = 0` (Sunday) backs `weekStart` before Jan 4, and `Math.ceil((now - weekStart) / 7days)` returns the wrong week number for dates in early January that belong to ISO week 53 of the prior year.

- ✅ **Line ~162 · edge-case** — `remainingUsd` clamps to `0` when the budget is exceeded. Callers checking `remainingUsd < 0` to detect overage will never see it; they must use the separate `exceeded` flag. The two fields communicate the same state inconsistently.

- ✅ **Line ~152 · edge-case** — `pctUsed = (spent / budget) * 100` is returned as a raw float (e.g. `33.333...`). Every other percentage in the codebase is rounded; this is inconsistent.

### `src/metrics/claudemd-tracker.ts`

- ✅ **Line ~19 · bug** — `computeFileHash` and `estimateContextCost` call `readFileSync` synchronously on the hot path (every harvest cycle). A very large CLAUDE.md blocks the Node.js event loop.

- ✅ **Line ~183 · edge-case** — `detectBetweenSessionChange` returns `true` when `previousHash` is `null` (first session ever). Any caller that acts on the return value records a spurious CLAUDE.md change on session 1 even though no change occurred.

- ✅ **Line ~208 · edge-case** — `null` efficiency/task-success scores are replaced with `0` in `computeImpact`. Delta is computed against 0 rather than "no data", producing misleading positive/negative impact verdicts.

- ✅ **Line ~270 · edge-case** — After trimming `changes`, `lastEmittedIndex` is decremented by `dropped`. When `dropped === lastEmittedIndex`, the result is 0 and all previously-emitted changes are re-emitted on the next harvest, producing duplicate metrics.

### `src/metrics/context-composition-tracker.ts`

- ✅ **Line ~103 · bug** — Fill threshold `firedThresholds` is never re-armed within a session. Once context crosses 75%, the alert fires once and never again—even after a context compaction and re-rise. A long session misses all threshold re-crossings.

- ✅ **Line ~150 · edge-case** — `cacheCreationTokens` is mapped to the `system_prompt` category. In practice, cache-creation tokens represent newly-cached conversation history, not just the system prompt, so the breakdown is misleading from the first turn.

- ✅ **Line ~127 · edge-case** — `fillPercent` in `recordTurn` has no guard for `modelContextWindow === 0` (unlike `getMetrics()`). A zero value produces `Infinity` for `fillPercent`, immediately firing all threshold alerts.

- ✅ **Line ~266 · edge-case** — `checkDominance` fires a `CategoryDominanceAlert` on every qualifying turn with no deduplication. A long session where `conversation_history` consistently dominates produces hundreds of unbounded alert entries returned by `getMetrics()`.

### `src/metrics/collaboration-profile.ts`

- ✅ **Line ~256 · edge-case** — `computeTaskComplexity` saturates at 50 tool calls/task. Sessions with more than 50 tool calls per task all score 1.0; higher complexity is invisible.

---

## src/metrics — cost-forecast, cost-per-outcome, cost-tracker, decision, efficiency, git-efficiency

### `src/metrics/git-efficiency-tracker.ts`

- ✅ **Line ~1271 · bug** — `commitBurstCount` increments once per commit beyond the second in a burst (not once per burst). Four consecutive commits produce `commitBurstCount = 2` instead of `1`. Should increment only when `consecutive === 3`.

- ✅ **Line ~1289 · bug** — `testBeforePush` compares the single most-recent build/test timestamp against the most-recent push. If the developer pushes at T=200 then runs tests at T=300, `testBeforePush` becomes `false` even though the push was correctly preceded by a build.

- ✅ **Line ~365 · edge-case** — `hydrateGitLog` increments `commitsSinceLastSync` for every historical commit regardless of whether it predates the last sync. After hydration, `commitsSinceLastSync` is inflated by the full log, causing false drift-risk suggestions.

- ✅ **Line ~243 · cleanup** — Private field `this.testBeforePush` is declared and reset in `reset()` but never assigned or read anywhere else. Dead code.

- ✅ **Line ~26 · edge-case** — `GIT_PUSH_FORCE_RE` matches `git push --force-with-lease` because `\b` fires between the `e` in `force` and the `-`. This is masked today because `GIT_PUSH_FORCE_LEASE_RE` is tested first, but a reordering would silently misclassify lease pushes as bare force pushes.

- ✅ **Line ~1297 · edge-case** — `manualMergeCount = resolvedCount - oursCount - theirsCount` can make `totalResolutions` larger than the actual conflict count if `checkout --ours/--theirs` commands were run outside a conflict window.

### `src/metrics/efficiency-score.ts`

- ✅ **Line ~260 · bug** — `updateScore` replaces an existing task score in-place without moving `lastEmittedIndex`. A re-scored task whose index is below `lastEmittedIndex` is never re-emitted to NR; the updated score is silently dropped.

- ✅ **Lines 82–107 and 147–172 · cleanup** — `computeScore` and `updateScore` contain identical scoring arithmetic. Any future formula change must be applied in two places.

### `src/metrics/decision-tracker.ts`

- ✅ **Line ~88 · edge-case** — Retry detection fires at exactly `count === 3`, not `>= 3`. Calls 4–N on the same file never produce a branch, causing `computeLongestFailureStreak` to undercount retry chains beyond the third attempt.

- ✅ **Line ~62 · edge-case** — When both the "recovery" branch and `AskUserQuestion` conditions fire in the same `recordToolCall`, `recordOutcome` tags only the most recently appended branch. The recovery branch retains `outcome: 'unknown'` until the next tool call, creating a one-turn lag.

### `src/metrics/cost-per-outcome.ts`

- ✅ **Line ~171 · edge-case** — Default fallback in `classifyOutcome` returns `'feature'` for sessions with no `Write` calls, no file modifications, and no clear signal. A session of pure Bash commands is labeled a feature, inflating `costPerFeature`.

---

## src/metrics — instruction-drift through tool-selection-score

### `src/metrics/instruction-drift-tracker.ts`

- ✅ **Line ~153 · edge-case** — `loadRecords` pushes external records after in-memory ones then trims from the front. If the external slice is larger than `maxRecords`, pre-existing in-memory records are evicted first—the opposite of FIFO intent.

### `src/metrics/live-session-registry.ts`

- ✅ **Lines 33–47 · bug** — `getLiveSessions()` is the only caller that evicts stale entries. If callers only ever use `isLive()`, `lastActivity` and `sessionNames` grow without bound in proxy scenarios with many short-lived sessions.

- ✅ **Line ~21 · edge-case** — `touch()` only stores the session name on the first call with a non-null `cwd`. If the first touch has no `cwd`, the name is never stored even when `cwd` later becomes available.

### `src/metrics/personal-coach.ts`

- ✅ **Line ~114 · edge-case** — `thisWeekData = weeks[0]` and `lastWeekData = weeks[1]` assume descending sort from `loadRecentWeeks`. If the ordering ever changes, week labels are swapped and streak detection is inverted—with no error or assertion.

### `src/metrics/prompt-feedback.ts`

- ✅ **Line ~178 · bug** — When both comparison groups have exactly 1 member, `stddev` returns `0`, making `pooledVariance = 0 / 0 = NaN`. The `pooledSd === 0` guard does not catch `NaN`, so `cohensD` returns `NaN`. This NaN propagates into `effectSizes` and silently corrupts the comparison result.

### `src/metrics/quality-proxy-tracker.ts`

- ✅ **Lines 176–200 · bug** — `findRepeatedFailures` groups failures by tool name regardless of consecutiveness. A tool that fails at turn 5, succeeds 20 times, then fails at turn 30 is penalized as "repeated." The comment says "consecutive failures" but the implementation does not check consecutiveness.

### `src/metrics/recommendation-engine.ts`

- ✅ **Lines 316–319 · bug** — `getModelRecommendations` picks models in Set insertion order (session load order). Recommendation text correctness (which model is "cheaper") depends on whether sessions are loaded oldest-first or newest-first—an undocumented ordering dependency.

### `src/metrics/session-tracker.ts`

- ✅ **Line ~133 · edge-case** — `toolDurationsByTool` accumulates every duration for every call with no cap. In a long session with thousands of Bash calls this can consume significant memory. `LatencyTracker` caps at 500 samples/tool; `SessionTracker` has no such cap.

### `src/metrics/task-detector.ts`

- ✅ **Lines 336–339 · bug** — `pendingEmission` is never capped. Every completed task is pushed there and stays until `drainNewlyCompletedTasks()` is called. If the caller never drains (unusual shutdown path), `pendingEmission` grows without bound.

- ✅ **Lines 149–151 · edge-case** — `linesChanged` records `Math.abs(newLines - oldLines)`—the net line delta, not total lines touched. A refactor replacing 100 lines with 100 different lines records `linesChanged = 0`.

### `src/metrics/tool-selection-score.ts`

- ✅ **Lines 176–200 · bug** — `findRepeatedFailures` penalizes any tool with 2+ failures in the session as "repeated," without checking whether failures are consecutive. Two failures separated by 20 successes trigger the same penalty as two back-to-back failures.

- ✅ **Lines 250–256 · edge-case** — `isOutputReferenced` for non-Read tools checks whether any of the next 5 calls has `inputSizeBytes > 500`. This 500-byte threshold is low enough that nearly any tool call "references" prior output, making the unused-output penalty nearly dead code for non-Read tools.

---

## src/storage

### `src/storage/local-store.ts`

- ✅ **Lines 67–83 · bug** — `.drain` recovery data loss on write failure. If `writeFileSync` (merging old drain + new buffer) throws, the catch swallows it and execution continues. The code then renames `bufferPath` to `tmpPath`, overwriting the `.drain` file with only the new-buffer contents. The old `.drain` events are permanently lost.

- ✅ **Line 148 · edge-case** — `loadRecentSessions` filters by file mtime, not by `session.startTime`. A file touched by a backup tool appears as recent even if its data is old; `SessionStore.loadAllSessions` uses the filename date, making the two methods inconsistent.

- ✅ **Line 129 · security** — `saveSession` in `LocalStore` does not set `mode: 0o600` on the written file. `SessionStore.saveSession` explicitly sets `0o600`. Session files saved via `LocalStore` may be world-readable depending on the umask.

### `src/storage/session-store.ts`

- ✅ **Line 207 · bug** — `loadTodaySessions` calls `today.setUTCHours(0, 0, 0, 0)`, producing midnight UTC. For developers in negative UTC offsets (e.g., UTC−5), at 23:00 local time it is already the next day in UTC, so `formatDate` returns tomorrow's date and `loadTodaySessions` returns an empty list even though today's sessions exist. Fix: use `setHours` (local time).

- ✅ **Line 429 · security** — `timeline` entries are cast `as ReplayTimelineEntry[]` without field-level validation. All other arrays are explicitly validated element-by-element. A malicious session file can inject arbitrary objects into the timeline.

- ✅ **Line 100 · edge-case** — `new Date(summary.startTime).toISOString()` throws `RangeError` if `startTime` is `NaN` or out-of-range. The `writeFileSync` catch below does not cover this; the exception propagates uncaught from `saveSession`.

### `src/storage/weekly-summary.ts`

- ✅ **Lines 118–120 · bug** — `loadAllSessions({ since: start })` uses `formatDate` which returns the UTC date. For negative UTC-offset developers, sessions near the week boundary whose UTC date falls on the prior day are excluded by the pre-filter, attributing them to the wrong week.

- ✅ **Line 157 · edge-case** — `checkAndGenerateLastWeek` subtracts 7 days in local time then calls `getIsoWeekId` which uses UTC. Near week boundaries in negative UTC offsets this can compute the wrong ISO week ID. Fix: use `Date.now() - 7 * 86_400_000` (pure UTC subtraction).

### `src/storage/retention.ts`

- ✅ **Lines 24–25 · bug** — TOCTOU: `statSync` then `unlinkSync`. If another process deletes the file between the two calls, `unlinkSync` throws `ENOENT`, caught as a generic warning and not counted in `deletedCount`.

---

## src/transport, src/digest, src/install

### `src/transport/nr-ingest.ts`

- ✅ **Line ~759 · bug** — `devAggregator` is cast `as unknown as MetricAggregator` to satisfy the type. If any caller invokes a `MetricAggregator` method beyond `record` on this stub, it throws `TypeError: not a function` at runtime.

- ✅ **Line ~200 · security** — Non-allowlisted string fields from `ToolCallRecord` pass through to NR events without redaction. Any new tool-specific field containing a credential silently leaks to New Relic.

### `src/transport/log-ingest.ts`

- ✅ **Line ~152 · bug** — On retry, old failed batch is appended _after_ new entries (`[...this.buffer, ...batch]`), reversing chronological order. Should be `[...batch, ...this.buffer]` to re-prepend the failed batch.

- ✅ **Lines ~127–149 · edge-case** — `flush()` is not re-entrant-safe. Two concurrent callers each drain the same snapshot; if both fail, `requeueBatch` is called twice, doubling the buffer size.

- ✅ **Lines ~152–158 · edge-case** — No retry backoff or max-retry count. A persistent 4xx re-queues indefinitely, filling the buffer and dropping oldest entries every harvest cycle. The NR Events path has `isNonRetryable4xx` protection; the Logs path has none.

### `src/digest/digest-sender.ts`

- ✅ **Line ~5 · security** — Webhook URL validation uses `startsWith('https://hooks.slack.com/')` which does not verify the hostname. A URL like `https://hooks.slack.com@evil.com/...` passes the check. Use `new URL(webhookUrl).hostname === 'hooks.slack.com'`.

- ✅ **Line ~9 · edge-case** — No timeout on the `fetch` call. If the Slack webhook hangs, `sendSlackDigest` blocks the MCP tool handler indefinitely.

### `src/install/cli.ts`

- ✅ **Line ~66 · security** — The symlink guard calls `realpathSync(dir)` on the parent directory but not on the full target file path. A symlink at `~/.claude/settings.json → /etc/cron.d/evil` passes the directory check since `~/.claude` is under HOME, but the write lands in `/etc/cron.d/`.

### `src/install/install-helper.ts`

- ✅ **Line ~163 · bug** — `mergeSettings` throws if the existing file has an unexpected shape, but the caller `handleInstall` in `cli.ts` has no try/catch around it. A malformed `settings.json` crashes the install command with an unhelpful stack trace.

### `src/install/setup-wizard.ts`

- ✅ **Line ~384 · bug** — `writeFileSync(CONFIG_PATH, ...)` writes the config directly without an atomic rename. If interrupted mid-write, the config file is partially written and corrupt. The rest of the codebase uses the atomic `writeJsonFile` helper.

- ✅ **Line ~160 · bug** — The `readline` interface `rl` is never closed on an uncaught exception or Ctrl+C signal. Cleanup calls only cover specific validation error paths. A signal mid-input leaves `rl` open, keeping the process alive. Should use `try/finally`.

- ✅ **Line ~476 · security** — Dashboard deploy commands printed to the user include the raw `nrApiKey` as a shell environment variable. If the user logs or pastes the snippet, the key is exposed in plaintext.

### `src/install/key-validator.ts`

- ✅ **Line ~109 · edge-case** — `validateApiKey` returns `reason: 'unauthorized'` for any non-empty `json.errors` without inspecting error codes. A genuine NerdGraph server-side error is misclassified as "unauthorized," making the user believe their API key is invalid when it is not.

### `src/install/schedule.ts`

- ✅ **Line ~110 · edge-case** — `resolveBinaryPath` uses hardcoded `/usr/bin/which`. On macOS with Nix or Homebrew, tools in `/opt/homebrew/bin` may not be found, so `resolveBinaryPath` returns `null` even though the binary is on the user's interactive PATH, silently skipping schedule installation.

---

## src/dashboard

### `src/dashboard/routes/static-handler.ts`

- ✅ **Lines 62–63 · security** — TOCTOU between `stat(target)` and `readFile(target)`. The path-traversal check runs on the path resolved at construction time; a symlink swapped after resolution is not re-checked before the read.

- ✅ **Lines 81–82 · security** — `isAsset` detection uses `target.includes(`${sep}assets${sep}`)` on the full absolute path. If the `rootDir` itself contains a component named `assets`, every served file is treated as a versioned asset and cached with `max-age=31536000, immutable`, including unhashed files like `index.html`. Check the path relative to `root` instead.

### `src/dashboard/routes/api-handler.ts`

- ✅ **Line ~513 · bug** — `loadSession` return is compared with `!== null` but the type allows `unknown`. If the implementation returns `undefined` for a missing session, the check passes and `JSON.stringify(undefined)` produces no output, sending a 200 with an empty body and a wrong `Content-Length`.

- ✅ **Lines ~304–375 · edge-case** — `GET /api/sessions` appends live-session stubs after `slice(-limit)` and only re-slices when `> limit`. With `limit=1` and 1 persisted + 1 live session, 2 items are returned. The limit contract is broken in both directions.

- ✅ **Lines ~45–101 · edge-case** — Self-correction window check uses `i - lastEditIdx <= 3` (includes the edit at distance 0), so the effective window is 4 turns, not 3 as the comment states.

- ✅ **Line 459 · cleanup** — `console.error` used directly instead of the module logger, bypassing structured JSON logging.

### `src/dashboard/routes/sse-handler.ts`

- ✅ **Line ~48 · bug** — Replay loop writes to `res` after the client has disconnected without checking `res.destroyed` or catching EPIPE. An uncaught error event on the response stream propagates to Node's unhandled error handler.

- ✅ **Line ~12 · security** — `frame()` accepts an unsanitised `event` string. A newline in `event` would inject arbitrary SSE frames. All current callers pass compile-time constants, but the function has no defensive guard.

### `src/dashboard/routes/replay-analyzer.ts`

- ✅ **Line ~246 · edge-case** — `detectReReadingSegments` uses magic number `4` instead of a named constant, inconsistent with `THRASH_THRESHOLD`, `STUCK_LOOP_THRESHOLD`, and `BLIND_EDIT_THRESHOLD` used by the other three detectors.

---

## src/platforms, src/proxy, src/tracing

### `src/proxy/upstream-stdio.ts`

- ✅ **Line 29 · security** — `PATH` stripped from `config.env` is a no-op. `StdioClientTransport` spreads `getDefaultEnvironment()` (which includes `PATH` from `process.env`) _before_ applying `config.env`, so stripping `PATH` from the caller-supplied env has no effect. The comment claiming `PATH` injection is prevented is misleading.

- ✅ **Line 203 · bug** — Force-kill fallback accesses `transport._process` via `as unknown` cast. If the MCP SDK renames that private field, the `kill()` call silently becomes a no-op and the child process leaks indefinitely on disconnect timeout.

### `src/proxy/proxy-manager.ts`

- ✅ **Line 332 · bug** — `success` is `true` for 3xx redirect responses (`statusCode >= 200 && < 400`). Upstream redirects are not valid MCP responses and should be failures. The condition should be `>= 200 && < 300`.

- ✅ **Line 290 · edge-case** — `proxyOverheadMs = totalDurationMs - result.upstreamLatencyMs` can be negative due to measurement jitter. Should be `Math.max(0, ...)` before storing in NR events.

### `src/proxy/upstream-http.ts`

- ✅ **Line 144 · bug** — When `ByteCountTransform` errors, `res.socket?.destroy()` is called but neither `upstreamRes` nor `counter` is destroyed. The upstream response stream continues reading from the network until TCP closes, causing a resource leak.

### `src/proxy/otlp-receiver.ts`

- ✅ **Line 252 · security** — API key comparison uses `===` (timing-sensitive string equality). Use `crypto.timingSafeEqual` on the UTF-8 byte representations to prevent timing-oracle attacks.

- ✅ **Line 39 · bug** — Rate-limiter map grows unboundedly: entries are never evicted after the timestamp window expires. Only the timestamp arrays within existing entries are pruned. Under high load with many unique IPs, the map leaks indefinitely.

- ✅ **Line 50 · edge-case** — `server.on('error', reject)` is never removed after `start()` resolves. Any later server error invokes `reject` on a settled promise, causing an unhandled rejection. Use `once` instead of `on`.

### `src/tracing/session-span.ts`

- ✅ **Lines 19–28 · bug** — If `startSpan` throws after `this.span` is assigned but before `this.started = true`, the span is leaked: `end()` guards on `!this.started` and returns early, never ending the span.

### `src/tracing/task-span-tracker.ts`

- ✅ **Line 43 · bug** — `getContext` uses `context.active()` (the current async context at call time) instead of the parent context stored when `openTask` was called. If `getContext` is invoked from a different async frame, the task span is attached to the wrong parent.

---

## src/tools

### `src/tools/cross-session-tools.ts`

- ✅ **Line ~699 · bug** — `accountId` validation: `Number('')` evaluates to `0`, and `Number.isFinite(0)` is `true`. When `options.accountId` is undefined, the empty-string fallback passes validation and issues a NerdGraph query against account ID `0` instead of returning a "not configured" error.

- ✅ **Line ~766 · bug** — NerdGraph query failure catch block is missing `isError: true`. All other error paths set this flag; the catch block does not, so the MCP client cannot distinguish a network failure from an empty result.

- ✅ **Line ~817 · bug** — `handleSubscribeDigest` validation error (bad webhook URL) returns without `isError: true`, inconsistent with every other error path in the file.

- ✅ **Line ~298 · edge-case** — `sessions.slice(-limit)` with `limit = 0` returns all sessions (`slice(-0) === slice(0)`). A negative `limit` silently slices from the wrong end. No bounds validation exists.

- ✅ **Line ~503 · edge-case** — Invalid `since` date in `handleGetCostPerOutcome` is silently ignored (filter skipped). `handleGetSessionHistory` rejects it with `isError: true`. The two should be consistent.

### `src/tools/session-stats.ts`

- ✅ **Line ~241 · edge-case** — `last_n = 0` in `handleGetSessionTimeline` returns the entire timeline (`slice(-0) === slice(0)`) instead of zero entries or a validation error.

- ✅ **Line ~607 · cleanup** — `handleGetSessionStats` result is JSON-parsed then immediately re-stringified. If the function ever returns non-JSON, the `JSON.parse` throws uncaught inside the switch case. Return the raw object and serialize once.

---

## src/web — TS hooks, store, components

### `src/web/hooks/useAnimatedValue.ts`

- ✅ **Line 24 · edge-case** — `hasAnimated.current` gate prevents re-animation when `target` changes after first render. The guard was intended to suppress StrictMode's double-invoke, but it also suppresses all subsequent animations when target updates.

### `src/web/hooks/useLiveEvents.ts`

- ✅ **Line 14–31 · bug** — `hydrateFromApi()` is called unconditionally on every mount. If the hook unmounts and remounts (hot-reload, test cycle), it pushes duplicate tool-call and anti-pattern events into the store. The store's `pushToolCall` has no deduplication logic.

- ✅ **Line 18 · edge-case** — The two `fetch` calls inside `hydrateFromApi` have no `AbortController`. If the component unmounts before responses arrive, the `.then` callbacks still fire and write stale data into the live store.

### `src/web/components/ShortcutOverlay.tsx`

- ✅ **Line 32 · bug** — `onClose` is in the `useEffect` dependency array. In `App.tsx` it is passed as an inline arrow function recreated on every render, causing the `keydown` listener to be torn down and re-added on every App render. Wrap `onClose` in `useCallback` in `App.tsx`.

### `src/web/components/AlertBanner.tsx`

- ✅ **Line 53 · edge-case** — `` `alert-title-${alert.id}` `` is used as an HTML element `id`. If `alert.id` contains spaces, colons, or slashes, the `aria-labelledby` reference silently breaks.

### `src/web/components/Kpi.tsx`

- ✅ **Line 38 · cleanup** — `useAnimatedValue(0, { enabled: false })` runs unnecessarily on every render when `numericValue` is `undefined`, even though the animated value is never displayed.

### `src/web/lib/format.ts`

- ✅ **Line 19 · edge-case** — Display format jumps from 2-decimal to 0-decimal at the 100 boundary. Values like `99.95` render as `"99.95"` while `100.4` renders as `"100"`, creating a visible inconsistency.

---

## src/web — views and Gantt components

### `src/web/views/Today.tsx`

- ✅ **Line ~164 · bug** — Anti-pattern flags are double-counted: `persistedTodayFlags` already includes the active live session from the sessions list, and `currentSessionFlags` adds the live API count on top.

- ✅ **Line ~166 · edge-case** — `headerTimestamp` is memoized with an empty dependency array, capturing `new Date()` at mount. The displayed time never updates; a "Today" header showing a stale mount time is misleading.

### `src/web/views/Sessions.tsx`

- ✅ **Line 151 · bug** — `initialId` reads `window.location.search` to initialize `useState`. If the URL changes without unmounting (client-side navigation to a different session), `selectedId` is never updated because `useState` initializer only runs once.

- ✅ **Line 523 · bug** — `ScrollableTimeline` auto-scroll effect depends only on `[isLive]`. New timeline entries appended to a live session do not trigger scroll-to-bottom because `isLive` remains `true` throughout. Should also depend on `data?.timeline.length`.

- ✅ **Line 118 · cleanup** — `fmtTime` ternary has identical branches for `number` and `string` input—both call `new Date(value)`. Dead code; simplify to `const d = new Date(value)`.

### `src/web/views/History.tsx`

- ✅ **Line ~443 · edge-case** — `aggregateDailyCost` uses `MM-DD` as the day key (no year). Sessions from the same month/day in different years are bucketed together, inflating costs for days near a year boundary. Fix: use `YYYY-MM-DD` as the key.

- ✅ **Line ~139 · edge-case** — Weekly efficiency score defaults to `0` for weeks with no data. A missing week should plot `null` so Recharts renders a gap rather than a misleading zero.

### `src/web/views/Replay.tsx`

- ✅ **Line 64 · bug** — `isLive` uses `??` but `Array.prototype.includes()` returns a `boolean`, never `null`/`undefined`. When `liveSessions` is present as an empty array, the `??` fallback is never reached. If the server sends `liveSessions: []` with a matching `sessionId`, `isLive` is `false` and the replay won't auto-refresh. Use `||` instead of `??`.

- ✅ **Line 76 · bug** — The "No session ID provided" early return is dead code. With a disabled query (`enabled: false`), `isLoading` is `false` and `data` is `undefined`, so the `!data` check at line 96 fires first, returning an empty fragment. The error message is never rendered.

### `src/web/components/GanttTimeline.tsx`

- ✅ **Line ~62 · edge-case** — `tickIntervalMs` stays at the last (largest) candidate when no candidate satisfies `totalDuration / c <= MAX_TICKS`. For sessions shorter than the smallest candidate (10,000 ms), `tickIntervalMs` exceeds `totalDuration` and zero tick marks are rendered. Add a fallback: `Math.ceil(totalDuration / MAX_TICKS)`.

### `src/web/components/Sparkline.tsx`

- ✅ **Lines 23–27 · bug** — `useEffect` that sets `hasAnimated.current = true` has no dependency array, running after every render. Should have `[]` to fire only once.

### `src/web/views/GitEfficiency.tsx`

- ✅ **Line ~584 · edge-case** — `gitCommandTimeline` rows use array index `i` as the React key after `.reverse().slice(0, 30)`. When the timeline grows and the slice changes, keys map to different rows, causing incorrect reconciliation. Use a stable key such as `${e.type}-${e.timestamp}`.

### Cross-cutting

- ✅ **Cleanup** — `buildSegmentLookup` is copy-pasted identically into `Sessions.tsx`, `Replay.tsx`, and `GanttTimeline.tsx`. Any bug fix must be applied in three places. Extract to a shared utility.

- ✅ **Cleanup** — Index-based React keys (`key={i}`) are used in `GitEfficiency.tsx` (conflict history rows, git timeline rows), `Replay.tsx` (segment summary chips), and `History.tsx` (`CoachCard` lists). These cause incorrect reconciliation when list items are inserted or removed. Use stable keys derived from data fields.

---

## src/security

### `src/security/ssrf.ts`

- ✅ **Line 22 · security** — `BLOCKED_HOST_RE` hex pattern for `10.0.0.0/8` only covers `10.0.x.x`. IPv4-mapped addresses `::ffff:10.1.0.1` through `::ffff:10.255.255.255` do not match the hex pattern. They are currently caught by the `extractIPv4FromMappedIPv6` fallback, but the protection depends entirely on that check's ordering—a refactor that reorders the two checks would create a real SSRF bypass for the `10.1–10.255` range.

- ✅ **Line 22 · security** — The decimal-form `::ffff:` IPv4-mapped branch in `BLOCKED_HOST_RE` is dead code. Node.js's URL parser always normalizes these to hex form before `validateSsrfUrl` sees the hostname. The branch creates a false sense of coverage for `10.1.0.0–10.255.255.255` when the actual protection for most of that range comes entirely from the `extractIPv4FromMappedIPv6` fallback.

- ✅ **Line 225 · bug** (`audit-trail.ts`) — `securityAlertToNrEvent` uses a non-null assertion (`record.securityAlert!`) with no type-level narrowing. The only current caller checks the field first, but any future caller passing an `AuditRecord` without `securityAlert` gets an uncaught `TypeError`.

### `src/security/audit-trail.ts`

- ✅ **Lines 78–89 · edge-case** — `DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS` requires both `-r`/`-R` and `-f`/`-F` flags for `rm` to trigger a `critical` alert. `rm -r /important/path` (recursive without force) is missed. GNU long-form `--recursive --force` is also not detected.

- ✅ **Lines 87–88 · edge-case** — Pipe-to-shell pattern only matches `sh`, `bash`, `zsh`, `ksh`, and `dash`. Commands piped to `fish`, `csh`, `node`, `python3`, `perl`, or `ruby` do not trigger the medium-severity alert.

- ✅ **Lines 269–270 · edge-case** — In-memory `entries[]` and `sensitiveAccessLog[]` arrays have no size cap. In a very long-running session with thousands of tool calls these arrays grow without bound.

---

## src/alerts

### `src/alerts/types.ts`

- ✅ **Line 46 · bug** — `DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin = 40`. The efficiency scorer emits scores in the `[0, 1]` range; a threshold of `40` means `score < 40` is always `true` for any real score, so the `efficiency.below` rule fires unconditionally from the first measurement. The correct value is `0.40`.

### `src/alerts/local-alert-rule.ts`

- ✅ **Line 69–73 · bug** — `efficiencyBelowRuleSchema` inherits `operator: operatorSchema.default('above')` from `baseShape`. A user who writes `{ type: 'efficiency.below', threshold: 0.5 }` without specifying `operator` gets `operator: 'above'`, meaning the rule fires when efficiency is _above_ 50%—the opposite of the name's implication.

### `src/alerts/local-alert-engine.ts`

- ✅ **Line 389–390 · bug** — `evaluateBudgetRule` uses `find(t => t.thresholdPct >= rule.threshold)` which picks the _first_ element in array order, not the _smallest_ qualifying threshold. If `budgetThresholds` is ordered `[80, 50, 100]`, a 50%-threshold rule matches the `80` entry, producing a dedup key that blocks the legitimate 80%-threshold event from ever firing.

- ✅ **Lines 404–409 · edge-case** — When a new budget period starts and the threshold is already crossed, the dedup window can suppress the first fire for up to 300 s, and no `cleared` event is emitted for the old period. The consumer sees two consecutive `'firing'` events with no `'cleared'` in between.

- ✅ **Line 491–493 · edge-case** — `periodKey()` week-number calculation assigns Sunday to the same week number as the preceding Monday–Saturday, so the weekly budget period key changes on Monday rather than Sunday—one day late relative to calendar week boundaries.

- ✅ **Line 334–344 · edge-case** — `computeAntiPatternCountValue` returns `0` (not `null`) when no matching window entry exists. `computeToolFailureValue` returns `null` in the equivalent case. An `antipattern.count below N` rule fires immediately from startup before any data arrives; a `tool.failure below N` rule correctly stays quiet.

### `src/alerts/alert-snapshot-collector.ts`

- ✅ **Lines 57–92 · cleanup** — `sessionTracker` is declared in `AlertSnapshotCollectorDeps` but never read in `snapshot()`. Tool-failure counts come from the internal `toolCallEvents` buffer. Any caller wiring `sessionTracker` expecting its `toolCalls` to feed failure-rate snapshots will silently get 0% failure rate.

- ✅ **Line 347 · edge-case** — `pruneOlderThan` walks from index 0 and stops at the first entry with `ts >= cutoff`. An out-of-order entry inserted after a more-recent one sits past the stopping point and is never pruned, causing inflated window counts in long sessions with occasionally late-arriving hook events.

---

# Pass 2 — Deeper Review (smaller groups, targeted angles)

---

## src/index.ts — startup and shutdown

- ✅ **Lines 211–246 · bug** — SIGTERM/SIGINT handlers are registered before any `await` in the startup body. If a signal arrives while startup is suspended (e.g., at `await mcpServer.connectStdio()`), shutdown runs against a partially-initialized object graph, skips all cleanup because every resource variable is still `undefined`, and calls `process.exit(0)`. The partially-started HTTP socket or child process is leaked.

- ✅ **Lines 245–246 · bug** — `process.on('SIGINT', shutdown)` attaches an `async` function as a synchronous signal handler. Node.js does not attach a rejection handler to the returned Promise. If the body of `shutdown` throws asynchronously after the try/catch (e.g., in the `finally` block), the unhandled rejection crashes the process with a different exit code than intended. Should be `process.on('SIGINT', () => { shutdown().catch(…) })`.

- ✅ **Line ~961 vs ~898 · bug** — `eventProcessor.start()` is called ~63 lines before `nrIngest?.start()`. Any tool-call records arriving in that window are passed to `capturedNrIngest.ingestToolCall(…)` on a not-yet-started `NrIngestManager`. If its harvest scheduler requires `start()` before buffering, those events are silently dropped. `nrIngest.start()` should be called before `eventProcessor.start()`.

- ✅ **Line 249 vs 654 · bug** — `sessionTraceId` is `''` (empty string) in any branch that isn't `options.stdio`. In `--local` mode with `config.mode = 'both'`, `NrIngestManager` is constructed with `sessionTraceId: ''`. Every NR event emitted will carry a blank trace ID, breaking distributed trace stitching.

- ✅ **Line ~515–527 · edge-case** — `fs.watch` on the alert rules path calls `loadAlertRulesFromDisk`, which uses `existsSync` then `readFileSync`. If the file is deleted between those two calls (e.g., on the second of two rapid `fs.watch` firings), `readFileSync` throws `ENOENT` with a confusing error message. Remove the `existsSync` guard and catch `ENOENT` explicitly in the `readFileSync` catch.

- ✅ **Line ~964 · bug** — `process.stdin.once('end', …)` is registered in stdio mode but no `'error'` handler is registered. If the MCP client disconnects with an I/O error (`ECONNRESET`, `EPIPE`), Node emits `'error'` on stdin rather than `'end'`. The unhandled `'error'` event propagates as an uncaught exception, bypassing the graceful shutdown path entirely.

- ✅ **Line ~992–1025 · bug** — If `proxyManager.start()` throws (e.g., port already in use), the error propagates to the `main().catch` IIFE which calls `process.exit(1)` directly. Any partial state inside `ProxyManager` (open file handles, child processes) is not cleaned up because `shutdown()` is never called.

- ✅ **Line ~1043 · edge-case** — `loadAlertRulesFromDisk` guards with `existsSync` before `readFileSync` — classic TOCTOU. On macOS, `fs.watch` fires twice per save (inode + content events), so the first event sees the file, then the editor's atomic rename deletes it, then `readFileSync` on the second call throws `ENOENT` and logs a confusing "Failed to load alert rules from disk" message.

- ✅ **Line ~357–374 · cleanup** — Three `spawnSync` blocks each have a `try/catch` that is documented as catching a "slow/missing git" case. But `spawnSync` with `ENOENT` does not throw — it returns `{ status: null, error: Error }`. The `catch` is dead code for the intended failure scenario. The `status === 0` guard is the correct filter, but the misleading `try/catch` should be removed or the `error` field should be checked explicitly.

---

## src/metrics/session-tracker.ts, task-detector.ts, anti-patterns.ts

### `src/metrics/session-tracker.ts`

- ✅ **Line ~122 · edge-case** — Session name is locked on the first non-degenerate `cwd`. If the first tool call fires from `/tmp` or a system directory, the session is permanently named `tmp` for its entire lifetime. There is no mechanism to prefer a later, more meaningful cwd.

- ✅ **Line ~184 · edge-case** — Timeline cap silently discards records beyond `MAX_TIMELINE_ENTRIES` with no flag, no count of dropped entries, and no `timelineTruncated` boolean in `getMetrics()`. Tools that page through the timeline silently believe they have the full picture.

- ✅ **Line ~162 · edge-case** — `filesRead` and `filesWritten` are `Set<string>` keyed on raw `filePath`. Relative vs absolute paths (`'src/foo.ts'` vs `'/src/foo.ts'`) and case differences on case-insensitive filesystems count as separate files, inflating unique-file counts.

### `src/metrics/task-detector.ts`

- ✅ **Line ~375 · bug** — The idle timer fires `closeCurrentTask(Date.now())` using real wall time. If the process is suspended (laptop sleep, container pause), the timer fires on resume and the resulting `durationMs` includes the entire sleep period. `averageTaskDurationMs` becomes wildly inflated with no cap or sanity check.

- ✅ **Lines ~199–309 · bug** — If `reset()` is called (which zeroes `costAtTaskStart = 0` and `tokensAtTaskStart = 0`) and then `dispose()` is called with an active task, `computeCostDelta` computes `currentCost - 0`, attributing the entire session's accumulated cost to the last task.

- ✅ **Lines ~336–339 · bug** — `completedTasks` is capped at `maxCompletedTasks`, but `getMetrics().totalTasksCompleted` returns `completed.length` (the capped slice), not a lifetime counter. Once the cap is hit, the metric silently reports a number lower than the actual total. There is no separate lifetime counter.

- ✅ **Line ~340 · bug** — `pendingEmission` is populated alongside `completedTasks` but unlike `completedTasks` it is never capped. If `drainNewlyCompletedTasks()` is never called, `pendingEmission` holds strong references to every completed task's `ToolCallRecord` array indefinitely.

### `src/metrics/anti-patterns.ts`

- ✅ **Line ~135 · bug** — The thrashing cycle counter for a file is only reset when a test passes. A successful build or lint run does not reset it. A developer who fixes a failure by running a build first, then the test, keeps the stale cycle count through the build step.

- ✅ **Line ~106 · bug** — `analyze([])` with an empty array overwrites `lastMetrics` with an empty-patterns object. Any caller that passes an empty snapshot at task start loses the previously computed pattern results. There is no `if (toolCalls.length === 0) return this.lastMetrics` guard.

- ✅ **Line ~171 · edge-case** — `re_reading` detection only checks for the exact tool name `'Read'`. `NotebookRead`, `mcp__ide__read`, or any platform-specific read variant is not counted. A developer who re-reads the same file 10 times via a custom MCP read tool sees zero re-reading patterns.

---

## src/metrics/git-efficiency-tracker.ts

- ✅ **Line ~617 · bug** — A `git commit --amend` does not close the pending conflict record, leaving `pendingConflictTimestamp` set indefinitely. A subsequent non-amend commit then sees the stale timestamp and records a wildly inflated `resolutionTimeMs` — potentially hours or days old.

- ✅ **Lines ~660–668 · bug** — `buildBeforePush` is set whenever `lastBuildOrTestTimestamp !== null` at push time, regardless of whether the build/test occurred after the most recent commit. Tests run at session start, followed by 10 commits, then a push, report `buildBeforePush = true` even though the tests predate all changes.

- ✅ **Lines ~348–368 · bug** — `hydrateGitLog` increments `commitsSinceLastSync` for every historical commit injected at initialization, regardless of whether those commits predate the last sync. After hydration, `riskIndicators.commitsSinceLastSync` is inflated by the full log, falsely triggering drift-risk suggestions.

- ✅ **Lines ~599–613 · bug** — `cherry_pick_abort` only closes a pending conflict if `pendingConflictTimestamp !== null`. Since conflicts from cherry-pick operations may not have been classified as `merge_conflict` or `rebase_conflict`, the abort silently does nothing — the conflict is invisible in `conflictHistory`.

- ✅ **Line ~330 · edge-case** — `avgTimeToCreateMs` is computed as `firstCreate.timestamp - this.firstCommitTimestamp`. This can be negative when a PR is created before the first commit tracked in the session (e.g., session starts mid-workflow after the PR already existed). Returned as-is with no clamping.

- ✅ **Line ~283 · edge-case** — The GitHub CLI guard `!GIT_COMMIT_RE.test(command)` tests the command string itself for the substring `git commit`. A command like `gh pr create --title "fix: run git commit hook"` contains `git commit` in its title argument and is incorrectly skipped.

- ✅ **Line ~713 vs ~748 · cleanup** — `computeRiskIndicators` captures `const now = Date.now()` at line 734 but then calls `Date.now()` again at line 748 for `sessionDurationMs`. Two different "now" values in the same snapshot; should reuse `now`.

---

## src/storage/session-store.ts + local-store.ts

### `src/storage/session-store.ts`

- ✅ **Lines 96–105 · bug** — `saveSession` uses `existsSync` then `mkdirSync` without `{ recursive: true }`. Two concurrent sessions saving simultaneously can both observe "dir does not exist", both call `mkdirSync`, one succeeds, the other throws an unhandled `EEXIST`. The `mkdirSync` call is outside the `try/catch` wrapping `writeFileSync`.

- ✅ **Lines 47–63 · bug** (`aggregateQualityFromHistory` in api-handler) — `lastEditFile` and `lastEditIdx` are not reset between sessions in the outer loop. If session A ends with an edit to `foo.ts` and session B starts with a re-edit to `foo.ts`, the cross-session pair is treated as a self-correction. `i - lastEditIdx` is negative (i resets to 0 each inner loop), which satisfies `<= 3`, producing a false positive.

- ✅ **Line 429 · security** — `timeline` is assigned `obj.timeline as ReplayTimelineEntry[]` with no field-level validation, unlike every other complex array in `deserializeSession`. A hand-edited session file can inject arbitrary objects into timeline entries including `filePath` and `command` fields that should be redacted.

- ✅ **Line 391 · edge-case** — `sessionId` silently defaults to `''` when absent or wrong-typed. Empty string passes the `!== null` check in callers and flows into file paths, event fields, and log lines silently.

- ✅ **Line 315 · edge-case** — `durationMs: sessionMetrics.sessionDurationMs` is not recalculated from `endTime - startTime` at save time. If the tracker is polled infrequently, the stored `durationMs` can be significantly less than `endTime - startTime`, producing an inconsistent record.

### `src/storage/local-store.ts`

- ✅ **Lines 67–83 · bug** — The drain-file recovery writes the merged buffer with `writeFileSync` (no `mode` option), creating the file with default umask permissions (`0o644`) instead of the `0o600` used everywhere else. Hook events — containing tool inputs, file paths, command strings — are world-readable on shared systems.

- ✅ **Line 50 · security** — `appendToBuffer` calls `appendFileSync` with no `mode` option. A freshly-created `buffer.jsonl` inherits umask defaults (`0o644`), exposing hook event data to other local users.

- ✅ **Line 151 · bug** — `loadRecentSessions` calls `JSON.parse(raw) as SessionSummary` directly with no validation, unlike `SessionStore.loadAllSessions` which routes through `deserializeSession`. A file containing `null` or `42` is silently coerced; `sessions.sort((a,b) => a.startTime - b.startTime)` then accesses `.startTime` on a non-object, producing `NaN` and an undefined sort order.

---

## src/dashboard/routes/api-handler.ts

- ✅ **Lines 247–254 · security** — `buildReplayResponse` returns the persisted session's raw `timeline` array to the browser without running `redactSensitive` on `filePath` or `command` fields. The live-session path calls `toolCallToTimelineEntry` which does redact; the persisted path trusts raw disk data and serves it directly.

- ✅ **Lines 47–63 · bug** — `lastEditFile` and `lastEditIdx` persist across sessions in `aggregateQualityFromHistory`'s outer loop (same bug as above — cross-session false positives in self-correction detection).

- ✅ **Line 514 · bug** — `session !== null` check passes `undefined` through (if `loadSession` returns `undefined`). `jsonOk(res, undefined)` calls `JSON.stringify(undefined)` which returns the JS value `undefined` (not a string), and `Buffer.byteLength(undefined)` throws a `TypeError`, crashing the handler with no response sent to the client.

- ✅ **Lines 545–550 · bug** — Live session timeline synthesized from `sessionTracker.getMetrics()` unconditionally sets `success: true` for every entry. Real failed tool calls are hidden; the replay view shows no failures for the current session.

- ✅ **Line 472 · edge-case** — `loadTodaySessions()` deserializes all of today's sessions into memory on every `GET /api/quality-proxy` request. On a heavy day with large session files, this can exhaust memory. Two concurrent requests can independently load the full dataset.

- ✅ **Lines 404–408 · cleanup** — `weeklySummaryGenerator.generate()` errors are silently swallowed with `/* best-effort */` and no logging. A persistent generation failure (disk full, corrupted state) is invisible to operators; the response returns stale data with no signal.

---

## src/hooks/event-processor.ts + tool-parsers.ts (second pass)

### `src/hooks/event-processor.ts`

- ✅ **Lines 113–114 · bug** — `flushPending()` is called unconditionally at the bottom of `stop()`. On a second call to `stop()` (e.g., both `beforeExit` and `SIGTERM` fire), `this.running` is already `false` so the `if (this.running)` block is skipped, but `flushPending()` still runs. If `this.pending` still has entries at that point, records are emitted again—duplicate delivery.

- ✅ **Lines 163–183 · bug** — Capacity-overflow eviction silently deletes a pre-event with no record emitted. `sweepOrphans()` and `flushPending()` both emit a synthetic `success: false, errorType: 'timeout'` record for evicted entries; the capacity-overflow path is the only eviction that produces no record, creating a silent data gap. The matching post event will produce an orphaned record with `durationMs: null`.

- ✅ **Lines 185–241 · bug** — `findOldestPendingKey` does not distinguish between `toolUseId`-keyed entries and fallback-UUID-keyed entries. A no-`toolUseId` post event for tool "Bash" will consume the oldest pending Bash entry regardless of whether that entry is keyed by its `toolUseId`. A subsequent post that does carry that `toolUseId` finds no pre-event and emits an orphaned record with `durationMs: null`.

- ✅ **Lines 296–314 · edge-case** — `flushPending` iterates `this.pending` and calls `onRecord` inside the loop. An `onRecord` callback that triggers re-entrant `handlePreEvent` calls inserts new entries into `this.pending` during iteration; per spec, those entries will be visited in the same iteration and flushed—almost certainly not intended.

### `src/hooks/tool-parsers.ts`

- ✅ **Line ~156 · edge-case** — `INPUT_PARSERS` and `OUTPUT_PARSERS` are keyed with exact PascalCase tool names with no normalization. A tool name differing by case (`"read"` vs `"Read"`) silently returns no parser and `{}` for all structured fields. The collector never normalizes tool names.

- ✅ **Lines 64–79 · edge-case** — `parseEdit` sets `isDelete` in the pre-computed-metadata branch only if `input.isDelete` is explicitly present. In the fallback path, `isDelete` is always derived from `newStringLength === 0`. A pre-computed delete operation (where the collector omits `isDelete`) is silently misclassified as a non-delete by any caller that treats absent `isDelete` as false.

---

## src/transport/nr-ingest.ts + log-ingest.ts (second pass)

### `src/transport/nr-ingest.ts`

- ✅ **Lines 700–720 · bug** — `stop()` has no guard against concurrent invocations. Two simultaneous callers both pass before either sets `running = false`, both call `this.scheduler.stop()` (safe—coalesced) and both call `this.logIngest.stop()` (NOT safe—`LogIngestManager.stop()` uses a simple `!this.running` guard). Both callers then `await this.flush()` concurrently, draining and re-queuing the buffer simultaneously, risking double-send.

- ✅ **Lines 484–493 · security** — `classifyingEventsFn` logs `result.error` on failure without calling `redactSensitive()`. If the NR Events API echoes back auth headers in error responses, the raw error string (potentially containing the license key) is written to stderr.

- ✅ **Line 373 · edge-case** — `antiPatternToNrEvent` stamps the NR event with `Date.now()` at serialization time, not the pattern's detection time. When events are queued during a network outage and flushed later, the NR timestamp reflects flush time rather than detection time, skewing dashboard timelines.

- ✅ **Line ~789 · edge-case** — `emitSessionGauges` iterates `proxyMetrics.toolPopularity` and emits a metric per `(tool, server)` combination with no cardinality cap. A session that calls hundreds of distinct MCP tools across multiple servers can exhaust the NR Metric API's per-account cardinality limit, silently dropping metric data.

- ✅ **Line ~303 · edge-case** — `codingTaskToNrEvent` emits `estimated_cost_usd: task.estimatedCostUsd ?? 0`. A zero value is indistinguishable from a genuine zero-cost task vs. a task where cost was never computed. There is no `cost_estimated: false` flag; NRQL `sum(estimated_cost_usd)` silently undercounts.

### `src/transport/log-ingest.ts`

- ✅ **Lines 152–158 · bug** — `requeueBatch` uses `[...this.buffer, ...batch]`: **`this.buffer` first, `batch` second**. This places newly-arrived entries before the failed batch in the queue. Entries that arrived during the failed network call are sent before the original failed entries, producing out-of-chronological-order log delivery to NR.

---

## src/metrics/recommendation-engine.ts + personal-coach.ts + weekly-summary.ts

### `src/metrics/weekly-summary.ts`

- ✅ **Line ~111 · bug** — `generate()` has no concurrency guard. Two simultaneous MCP tool calls that both trigger `generate(weekId)` will independently call `loadAllSessions`, compute the summary, and call `writeFileSync` on the same file. The second write wins but both return their own object, which may differ if session data changed between the two reads.

- ✅ **Line ~253 · bug** — `taskSuccessRate = totalTestsPassed / totalTestsRun` has no upper-bound clamp. If a session has `testPassCount > testRunCount` (possible from a tracker bug), the ratio silently exceeds `1.0` and is stored in the summary and propagates into all trend and coaching displays.

- ✅ **Lines ~140–153 · edge-case** — `getLatest()` and `loadRecentWeeks()` sort files lexicographically. While `getIsoWeekId` zero-pads week numbers, any summary file written by an older version without zero-padding (e.g., `"2026-W9.json"`) would sort incorrectly, returning the wrong "latest" file.

### `src/metrics/personal-coach.ts`

- ✅ **Lines ~163–194 · bug** — `computeBaseline` averages over `weeks` which includes `weeks[0]` (this week). Every delta is compared against a mean that includes the current value itself. With only 2 weeks of data the baseline is `(thisWeek + lastWeek) / 2`, so a 5-point threshold requires a 7.5-point gap between the two weeks—not 5 points above a true historical average.

- ✅ **Lines ~79–81 · bug** — `lastWeekData = weeks[1]` assumes dense weekly data. `loadDeveloperWeeks` skips weeks with no sessions, so index 1 could be 3+ weeks ago. The coaching narrative labels this "last week" and computes "week-over-week" deltas against a potentially much older baseline.

### `src/metrics/recommendation-engine.ts`

- ✅ **Line ~126 · bug** — `teamCorrectionPct = (1 - baseline.dimensions.correctionRate) * 100`. The formula is inverted. When `correctionRate = 0.8` (high corrections—should fire), `teamCorrectionPct = 20` and the recommendation does NOT fire. When `correctionRate = 0.6` (lower corrections), `teamCorrectionPct = 40` and it fires. The formula should be `correctionRate * 100`.

- ✅ **Line ~202 · edge-case** — `costPerFailedAttempt` can be `NaN` if no failed attempts exist but `wasteRatio > 0.2` fired from other outcomes. String interpolation then produces `"could save ~$NaN"` in the recommendation text shown to the user.

---

## src/web/components/GanttTimeline.tsx + Replay.tsx + liveStore.ts (second pass)

### `src/web/components/GanttTimeline.tsx`

- ✅ **Line ~112 · bug** — `offsetMs = entry.timestamp - firstTs` is negative whenever any entry has a timestamp earlier than `entries[0]`. The timeline is never sorted before rendering. Out-of-order entries (clock skew, live injection) place bars to the left of the track—silently clipped behind the label column.

- ✅ **Line ~54 · bug** — `totalDuration = lastEntry.timestamp + lastEntry.durationMs - firstTs` uses only the last array entry, not the maximum end time. An intermediate entry with a longer duration overflows the track and is clipped silently.

- ✅ **Lines ~76–83 · bug** — `buildSegmentLookup` never clamps `seg.startIndex` to be `>= 0`. A negative `startIndex` from a malformed server response silently sets a named property on the array object instead of a numeric index; all segment badges disappear with no error.

### `src/web/views/Replay.tsx`

- ✅ **Line 64 · bug** — `isLive` uses `??` but `includes()` returns `boolean`, never `null`/`undefined`. When `liveSessions` is absent (undefined), `??` activates and `isLive = currentSession.data?.sessionId === sessionId`. Any historical session that happens to match the active session ID is treated as live, triggering a 3-second refetch interval indefinitely.

- ✅ **Lines 301 · bug** — `buildSegmentLookup`: `seg.severity === 'critical'` unconditionally overwrites any prior assignment, including a prior `critical`. Two critical segments covering the same row produce an arbitrary winner based on iteration order, not priority.

### `src/web/store/liveStore.ts`

- ✅ **Lines 129–142 · bug** — `selectVisibleFiringAlerts` allocates a new array on every call. Zustand uses `Object.is` for equality by default. Any consumer calling `useLiveStore(selectVisibleFiringAlerts)` without `useShallow` will re-render on every store mutation regardless of whether the visible alert set changed.

- ✅ **Lines 21–29 (useLiveEvents.ts) · bug** — SSE events and the `hydrateFromApi()` REST response both call `pushToolCall` for recent tool calls. `pushToolCall` never deduplicates by event `id`. If the most recent tool call appears in both the API response and a live SSE event, it is pushed twice, causing `recentToolCalls` to contain duplicates.

---

## src/web/views/Today.tsx + Sessions.tsx (second pass)

### `src/web/views/Today.tsx`

- ✅ **Line 157 · bug** — `spendLoading = !cost && costPending && sessionsPending` is `false` as soon as either query resolves, even though `todayTotal` may still show `$0.00` from the other query's empty state. The spend KPI briefly renders `$0.00` as a real value instead of a loading spinner during partial load.

- ✅ **Line ~244 · bug** — The anti-pattern banner is visible when `flagsCount > 0` is satisfied purely from `persistedTodayFlags` (historical sessions), but `antiPatterns.length === 0` AND `apiAntiPatterns` is empty. The amber banner renders with no content inside—visible container, empty body.

- ✅ **Line 275 · bug** — "Loading sessions / Selecting the most recent session…" empty state is shown permanently when no sessions exist at all. When `rows` is empty and `liveSessionIds` is empty, `setSelectedId` is never called; `selectedId` stays `null` and the misleading loading message persists indefinitely even after queries complete.

### `src/web/views/Sessions.tsx`

- ✅ **Line 151 · bug** — `window.location.search` is read once at component initialization, not reactively. SPA navigation to `/sessions?id=X` after `Sessions` is already mounted does not update `selectedId`. The `initialId` captures the URL from when the component first rendered.

- ✅ **Lines 523–526 · bug** — `ScrollableTimeline` auto-scroll effect depends only on `[isLive]`. New timeline entries appended to a live session never trigger scroll-to-bottom because `isLive` remains `true`. The `InlineReplay` scroll path works via a separate forwarded ref, but this coupling is fragile and undocumented.

---

## Numeric edge cases (cross-cutting)

- ✅ **`git-efficiency-tracker.ts` line ~1269 · bug** — `Math.max(...gaps)` spreads the `commitTimestamps` array into `Math.max`. This array is unbounded. In a session with thousands of commits (e.g., after `hydrateGitLog`), the spread exceeds V8's argument limit (~65,535), throwing `RangeError: Maximum call stack size exceeded` inside `getMetrics()`. Fix: use `gaps.reduce((a, b) => Math.max(a, b), 0)`.

- ✅ **`quality-proxy-tracker.ts` line ~181 · edge-case** — `Math.max(...this.events.map(...))` has the same spread-on-large-array risk if `maxEvents` is configured above ~65k.

- ✅ **`budget-tracker.ts` line ~95 · edge-case** — ISO week numbers for Dec 28–31 that belong to next year's W01 are keyed under the current year's last week ID. Fired thresholds with those keys are never pruned when the new year begins, so those thresholds can re-fire at the correct time in the new year.

---

## src/web/views/History.tsx + GitEfficiency.tsx (second pass)

### `src/web/views/History.tsx`

- ✅ **Lines 443–447 · bug** — `aggregateDailyCost` uses `MM-DD` as the day key and sorts by `localeCompare` on that string. When the 30-day window spans a year boundary, January (`"01-XX"`) sorts before December (`"12-XX"`) even though December came first chronologically. The chart renders days in the wrong order.

- ✅ **Line ~303 · edge-case** — `Math.round(m.avgEfficiency * 100)` and `Math.round(m.avgSuccessRate * 100)` have no clamping. A session reporting efficiency slightly above `1.0` produces `105%` in the table; the Y-axis domain is fixed `[0, 100]` so recharts renders data points outside the visible area.

### `src/web/views/GitEfficiency.tsx`

- ✅ **Lines 169–174 · bug** — `ScoreRing` uses `score / 100` to compute `strokeDashoffset` with no clamping. A score outside `[0, 100]` (e.g., `105` from a rounding error, or negative) produces an SVG arc that overflows or disappears entirely with no error.

- ✅ **Lines 195–196 · bug** — `color.split(' ')[1]` extracts the border class for the SVG stroke. If the `color` string has extra whitespace or a different format, `split(' ')[1]` returns `undefined`, and `className={undefined}` renders as the literal string `"undefined"` as the class name, removing all arc color styling.

- ✅ **Lines 329–332 · edge-case** — Best practices "passing" denominator is `data.bestPractices.filter(bp => bp.status !== 'unknown').length`. When all items have `status === 'unknown'` (no data yet), the display renders `"0/0 passing"`. No guard or N/A fallback exists.

---

## src/hooks/collector-script.ts (deep second pass)

- ✅ **Line ~341 · security** — `extractInputMeta` stores `meta.command` and `meta.description` verbatim with no `redact()` call. These go into `event.toolInput` and are written to `buffer.jsonl` unconditionally. A Bash command like `curl -H "Authorization: Bearer ghp_abc123"` leaks the secret to disk regardless of `highSecurity` or `recordContent` settings.

- ✅ **Line ~77 · security** — The `API_KEY`/`SECRET`/`TOKEN` redaction regex uses `\b` word-boundary anchors. Because `_` is a word character, compound names like `MY_API_KEY=secret`, `DATABASE_PASSWORD=secret`, and `SECRET_KEY=secret` do not match—the boundary between the prefix and the known keyword is not a word boundary.

- ✅ **Line ~250 · bug** — In `collectTranscriptTokens`, `setLastTranscriptSize(sessionId, currentSize)` is called before the token event is written to the buffer. If the buffer write fails, the new size is already persisted and the token usage for that turn is permanently lost on the next invocation.

- ✅ **Lines ~543–550 · bug** — PIPE_BUF comparison uses JavaScript character length (`line.length > PIPE_BUF`), not byte length. A line of 2048 four-byte emoji characters has `length = 2048` (passes) but `Buffer.byteLength = 8192` (far over the 4096-byte limit). Fix: `Buffer.byteLength(line, 'utf8') > PIPE_BUF`.

- ✅ **Lines ~543–550 · bug** — The comment claims `O_APPEND` gives atomic writes at PIPE_BUF size. PIPE_BUF atomicity applies only to named pipes/FIFOs, not regular files. `buffer.jsonl` is a regular file. POSIX does not guarantee atomic writes of any size to regular files even with `O_APPEND`. The atomicity guarantee the code relies on does not exist.

- ✅ **Line ~458 · bug** — `JSON.parse(raw)` in `processHook` has no try/catch wrapper in the `processHook` function itself. The exported function gives no indication it can throw on malformed input. Any caller outside the entry-point IIFE that passes arbitrary input must add its own guard.

- ✅ **Line ~194 · security** — `resolve(bufferDir, '.transcript-pos-' + sessionId)` concatenates an untrusted string from the hook JSON into a file path. If `sessionId` is `../../etc/cron.d/evil`, `resolve` produces a path outside `bufferDir`. Same issue in `setLastTranscriptSize`. Should validate `sessionId` with `/^[a-zA-Z0-9_-]{1,128}$/` before use.

- ✅ **Line ~91 · edge-case** — `redact()` truncates at `MAX_REDACT_LEN` JavaScript characters (described as "1 MB"). For 4-byte emoji, 1M characters = 4 MB UTF-8, running redaction regexes on 4× more bytes than intended. Should truncate by byte count instead of character count.

---

## src/server.ts + src/config.ts (second pass)

### `src/server.ts`

- ✅ **Line 17 · bug** — `auditTrailManager` is a public mutable field. Any caller can write `server.auditTrailManager = undefined` after construction. It is part of the server's security posture and should be `readonly`.

- ✅ **Lines 57–86 · edge-case** — Resource handlers (`ListResourcesRequestSchema`, `ReadResourceRequestSchema`) have no try/catch. If `getAuditLog()` throws, the MCP SDK converts it to an `InternalError` response but no log entry is written—errors are silently swallowed from the application's perspective.

### `src/config.ts`

- ✅ **Lines 862–871 · bug** — `redactSensitive` has no runtime type guard. Passing `undefined`, `null`, a number, or an object throws `TypeError`. The function is on the security-critical path—a crash here propagates unredacted data to logs or NR events instead of being safely redacted. Fix: `if (typeof value !== 'string') return String(value ?? '')`.

- ✅ **Line ~322 · edge-case** — `parseOtlpHeaders` splits `pair.split('=')` and discards everything after the first `=`. Already noted in Pass 1; confirmed again as a distinct issue.

- ✅ **Lines ~441–443 · edge-case** — `licenseKey = "null"` (the string) is truthy and passes the `!licenseKeyRaw` guard. It is used as the actual license key, producing silent authentication failures at transport time rather than a clear startup error. NR license keys are 40 characters; a minimum-length or prefix check would catch this.

- ✅ **Lines ~544–568 · edge-case** — Budget env vars use `if (raw)` to gate parsing, making `"0"` (the string zero) falsy. `NEW_RELIC_AI_SESSION_BUDGET_USD=0` silently falls through to the file config. Should use `if (raw !== undefined && raw !== '')`.

---

## src/proxy — second pass

### `src/proxy/upstream-http.ts`

- ✅ **Lines 183–198 · bug** — When a non-SSE upstream error fires after chunks have already been sent, the code writes the upstream's status code (e.g., `200`) while also writing an error JSON body. The client receives `200 {"error":"upstream_error"}` which fools any caller trusting the status code. Should write `502` in this path.

- ✅ **Lines 86–96 / types.ts 107–109 · security** — `shouldForwardHeader` allows any header starting with `x-` to pass through. This includes `x-forwarded-for`, `x-real-ip`, `x-forwarded-host`. An upstream that trusts these for authentication or rate-limiting is fooled into thinking requests originate from a different IP. The proxy should strip all `x-forwarded-*` headers from the inbound request and re-add its own.

- ✅ **Line ~98 · bug** — `_reject` in the `forward()` Promise constructor is never called. Every error path calls `resolve()` instead. If a future code path is added that falls off without calling `resolve`, the caller hangs forever with no timeout and no rejection.

### `src/proxy/proxy-manager.ts`

- ✅ **Lines 189–207 · bug** — `stop()` closes the HTTP server but immediately disconnects upstreams while in-flight `forward()` calls may still be running. For `StdioUpstream`, `disconnect()` SIGKILLs the child after 5s; any concurrent `dispatchToClient()` throws, propagates to a response that may already be in an indeterminate state.

- ✅ **Lines 374–416 · bug** — When the body-read timeout fires, `req` is never destroyed. Node.js continues buffering data from the client, holding the TCP connection open until the client closes it. Should call `req.destroy()` after the 408 response to reclaim the connection immediately.

- ✅ **Lines 398–405 · bug** — When body exceeds max size, the `data` handler sets the `settled` flag but never calls `req.destroy()`. The large payload continues consuming network bandwidth and kernel buffers. Should call `req.destroy()` in the large-body rejection branch.

### `src/proxy/upstream-stdio.ts`

- ✅ **Lines 211–263 · bug** — `dispatchToClient` has no timeout. If the child process hangs, the `await` never resolves, the HTTP response is never written, and the connection is held open indefinitely. A single rogue tool call can permanently tie up a request handler.

- ✅ **Lines 178–208 · bug** — No listener for unexpected child process exit. If the child crashes between requests, `this.client` is still non-null. The null-check passes, `dispatchToClient` is called on a dead client, and every subsequent request fails with a 500 until the proxy restarts. No reconnect logic exists.

- ✅ **Lines 33–55 · bug** — `sanitizeEnv` strips `PATH` from the child environment. When a caller provides any `env` object that includes `PATH`, it gets stripped, likely breaking the child process's ability to find executables. Since `validateCommand` requires an absolute command path, stripping `PATH` is unnecessarily aggressive.

---

## src/alerts — second pass

### `src/alerts/local-alert-engine.ts`

- ✅ **Line ~390 · bug** — `thresholds.find(t => t.thresholdPct >= rule.threshold)` returns the first array element satisfying the condition. For an ascending-ordered array `[50, 80, 100]` and a 50%-threshold rule, the engine permanently encodes `50` in `periodKey`. After the 80% level is crossed, `firedPeriodKey` already matches the 50% key and the early-return suppresses escalation—the 80% alert never fires.

- ✅ **Lines ~404–409 · bug** — The second dedup guard for budget rules unintentionally blocks escalation between threshold levels. A budget escalating from 50% to 80% within `deduplicateSeconds` fires the 50% alert but suppresses the 80% escalation. The dedup was designed to prevent re-fire of the same threshold, not to block escalation.

- ✅ **Line ~344 · bug** — `computeAntiPatternCountValue` returns `0` instead of `null` when no matching window entry exists. An `antipattern.count below N` rule fires immediately from startup before any data has been collected. The engine treats `0` (absent) identically to `0` (no anti-patterns detected). Should return `null` for "no data."

- ✅ **Line ~492 · bug** — Weekly `periodKey` uses `Math.ceil((d - weekStart) / weekMs)`. For dates in Dec 28–31 that belong to next year's ISO W01, `weekStart` is anchored to the current year's Jan 4, producing the wrong week key. A threshold fired in late December re-fires on Jan 1 instead of carrying over, and the stale Dec key is never pruned.

- ✅ **Lines 270–276 · edge-case** — Post-clear deduplication suppresses firing for `deduplicateSeconds` after a clear. During that window, if the condition briefly exits and re-enters (oscillates near threshold), `firstBelowAt` resets, restarting the sustained-below clock. Efficiency score oscillation near the threshold can delay the alert indefinitely.

### `src/alerts/local-alert-rule.ts`

- ✅ **Line ~34 · edge-case** — `threshold: z.number()` accepts `NaN` and `Infinity`. A rule loaded with `"threshold": 1e308` produces `Infinity`. `compareOp(value, NaN, 'above')` is always `false`, causing the rule to silently never fire. Should add `.finite()` to the Zod schema.

### `src/alerts/alert-log.ts`

- ✅ **Lines ~71–103 · bug** — `readRecent()` only reads the primary log file. Immediately after a rotation, the primary file is empty and all history is in `.1`. A call to `readRecent(100)` returns zero events, silently dropping all recent alert history. The method should read the `.1` file first and merge before slicing to `limit`.

---

## Cross-cutting: error handling

- ✅ **`setup-wizard.ts` lines 159–495 · bug** — `runSetupWizard` has no `try/finally` to guarantee `rl.close()`. Any thrown exception (network error in `validateLicenseKey`, `writeFileSync` failure) propagates out without closing the readline interface, keeping stdin open and preventing clean process exit.

- ✅ **`setup-wizard.ts` line ~384 · bug** — `writeFileSync(CONFIG_PATH, ...)` (config write) and `mkdirSync` have no try/catch. A write failure produces a raw Node stack trace instead of a wizard-style error message. User is left with a partially-written or missing config file.

- ✅ **`api-handler.ts` lines ~486–492 · bug** — The outer route dispatcher `await fn(req, res)` is not wrapped in try/catch. If any synchronous route handler throws (or any async one rejects), the exception propagates to the HTTP server's `request` event handler—either crashing the process or leaving the HTTP response hanging open (client timeout). All dispatches need a top-level catch that writes a `500` response.

- ✅ **`nr-ingest.ts` line ~712 · edge-case** — `Promise.all([scheduler.stop(), logIngest.stop(), ...])` rejects with the first error and silently discards errors from remaining promises. If both `scheduler.stop()` and `otlpTransport.shutdown()` throw, the second error is lost. Use `Promise.allSettled`.

- ✅ **`cli.ts` lines ~327–330 · bug** — The `setup` action `await runSetupWizard()` is not wrapped in a catch. Commander does not catch async action rejections in all versions. If `runSetupWizard` throws, the error escapes to the process-level unhandled rejection handler and the process exits with a cryptic message rather than the CLI's own error formatting.

- ✅ **`collector-script.ts` lines ~199–202 · bug** — `getLastTranscriptSize` and `setLastTranscriptSize` both have empty catch blocks. If `setLastTranscriptSize` silently fails on every call (permissions problem), token collection runs on every hook invocation and re-emits the same usage, producing duplicate cost records.

---

## Cross-cutting: input validation

- ✅ **`config.ts` lines ~544–568 · edge-case** — Budget env vars use `if (raw)` which is falsy for `"0"`. `NEW_RELIC_AI_SESSION_BUDGET_USD=0` falls through to the file config rather than setting a zero budget cap. Should use `if (raw !== undefined && raw !== '')`. Same issue for `retainSessionsDays`.

- ✅ **`tools/session-stats.ts` line ~641 · edge-case** — `last_n` passed directly to `slice(-lastN)` without bounds checking. `last_n = 0` returns the full timeline (`slice(-0) === slice(0)`). Should clamp: `Math.max(1, Math.min(lastN, 1000))`.

- ✅ **`otlp-receiver.ts` line ~171 · edge-case** — `Content-Length` header parsed with `Number()` without NaN guard. `Number("abc")` = `NaN`; `receivedBytes < NaN` is always `false`, so a body with a malformed `Content-Length` header is silently accepted regardless of actual size. Use `parseInt` + `Number.isFinite` check.

- ✅ **`cross-session-tools.ts` lines ~784–797 · edge-case** — `byDev[dev]` uses developer names from NerdGraph as plain-object keys. A developer named `"__proto__"` or `"constructor"` would mutate `Object.prototype`. Use `Object.create(null)` or a `Map` for accumulator objects. Same pattern in `api-handler.ts` line ~573 for tool name breakdown.

---

## src/tools — cross-session and session-stats (second pass)

### `src/tools/cross-session-tools.ts`

- ✅ **Line ~767 · bug** — NerdGraph query failure catch block missing `isError: true`. The MCP client treats the failure as a successful tool call, silently swallowing the error. All other error returns in `handleGetTeamSummary` correctly set `isError: true`.

- ✅ **Line ~818 · bug** — `handleSubscribeDigest` invalid-URL error returns without `isError: true`. The MCP SDK reports success to the caller when an invalid webhook URL is provided.

- ✅ **Line ~298 · bug** — `limit = 0` causes `sessions.slice(-0)` which equals `slice(0)`, returning the entire session list instead of zero results. Negative limits (e.g., `-3`) become `slice(3)`, silently dropping the first 3 sessions.

- ✅ **Lines ~384–385 · bug** — Negative `weeks` computes a `since` date in the future (`Date.now() - (-1) * 7days`). `loadAllSessions` returns nothing; the tool silently returns an empty dataset with no diagnostic.

- ✅ **Lines ~425, ~537 · edge-case** — Empty-string `developer` passes through unguarded. `computeProfile("")` and `getRecommendations("")` match no sessions and return vacuous or misleading results.

- ✅ **Line ~700 · bug** — `Number('')` is `0`; `Number.isFinite(0)` is `true`. When `accountId` is not configured, the empty-string fallback passes validation and fires a NerdGraph query against account ID `0`. Fix: also require `accountId > 0`.

### `src/tools/session-stats.ts`

- ✅ **Line ~607 · bug** — `handleGetSessionStats` returns a JSON string; the handler `JSON.parse`s it just to merge in `identity` and re-stringifies. If `handleGetSessionStats` ever returns non-JSON text, this throws uncaught inside the switch. Return the raw object and serialize once.

- ✅ **Line ~242 · edge-case** — No upper bound on `last_n`; a caller passing `last_n: 10000` gets all 10,000 timeline entries in a single MCP content block. Large payloads can cause downstream JSON-parse timeouts in the client.

---

## Cross-cutting: async/Promise handling

- ✅ **`log-ingest.ts` lines ~109–124 · bug** — Race condition on shutdown: the periodic `void this.flush()` interval can be in-flight when `stop()` is called. `stop()` sees an empty buffer (already grabbed by the in-flight flush), returns, and then the in-flight flush fails, calls `requeueBatch()`, but nobody ever drains it again. The batch is silently lost. `HarvestScheduler` solves this correctly by tracking `inFlightEventHarvest`; `LogIngestManager` has no equivalent guard.

- ✅ **`index.ts` lines ~234–237 · bug** — Sequential shutdown chain: if `dashboardServer.stop()` throws, `nrIngest.stop()` is never called, queued telemetry events are dropped, and the MCP transport is left open. Each stop call should be wrapped individually or all run via `Promise.allSettled`.

- ✅ **`proxy-manager.ts` lines ~163–169 · bug** — After `start()` resolves, the `once('error', reject)` listener is still registered. The first post-start server error fires `reject()` on an already-resolved promise (no-op), removes the listener, and subsequent errors have no handler at all—becoming unhandled Node.js errors. Replace with a permanent `on('error', logger)` after startup resolves.

- ✅ **`proxy-manager.ts` lines ~192–194 · bug** — `stop()` wraps `server.close()` in a Promise. `server.close()` only stops accepting new connections; it waits for all existing keep-alive connections to end naturally. MCP clients holding persistent HTTP/1.1 connections to the proxy never close them, so `stop()` hangs forever. Should call `server.closeAllConnections()` (Node 18.2+) or explicitly destroy all open sockets.

- ✅ **`dashboard-server.ts` line ~108 · edge-case** — `void this.handle(req, res)` with no outer try/catch in `handle()`. If `setSecurityHeaders()` or `isHostAllowed()` throws, the rejection is unhandled. Should add a top-level try/catch in `handle()` that logs and destroys the response.

---
