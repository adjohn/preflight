/**
 * Append order in an O_APPEND file is the cross-process arbiter, so two
 * racing claimants both read back the same winner without a lock.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

type DayKey = string & { readonly __brand: 'DayKey' };
type MidnightStraddle = readonly [DayKey, DayKey, DayKey];

export interface BillableTurn {
  readonly messageId: string;
  readonly timestampMs: number;
}

export interface BilledTurnLedgerOptions {
  readonly storagePath: string;
  readonly retainDays?: number | null;
  readonly now?: () => number;
}

interface DayIndex {
  offset: number;
  partial: string;
  readonly owners: Map<string, string>;
}

const LEDGER_DIR = 'billed-turns';
const MAX_CACHED_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const TORN_LINE_TERMINATOR = '\n';

export class BilledTurnLedger {
  private readonly dir: string;
  private readonly retainDays: number | null;
  private readonly now: () => number;
  private readonly days = new Map<DayKey, DayIndex>();

  constructor(options: BilledTurnLedgerOptions) {
    this.dir = join(options.storagePath, LEDGER_DIR);
    this.retainDays = options.retainDays ?? null;
    this.now = options.now ?? Date.now;
  }

  claim<T extends BillableTurn>(sessionId: string, turns: readonly T[]): T[] {
    this.trimCache();
    const nowMs = this.now();
    const live = turns
      .map((turn) => ({ turn, days: midnightStraddle(dayKeyOf(turn.timestampMs)) }))
      .filter(({ days: [earliest] }) => !dayIsBeyondHorizon(earliest, nowMs, this.retainDays));
    this.syncDays(live.flatMap(({ days }) => days));

    const candidates = new Map<string, { turn: T; days: MidnightStraddle }>();
    for (const entry of live) {
      const id = entry.turn.messageId;
      if (candidates.has(id) || this.ownerOf(id, entry.days) !== undefined) continue;
      candidates.set(id, entry);
    }
    if (candidates.size === 0) return [];

    const linesByDay = new Map<DayKey, string>();
    for (const { turn, days } of candidates.values()) {
      const line = TORN_LINE_TERMINATOR + JSON.stringify({ m: turn.messageId, s: sessionId });
      linesByDay.set(days[1], (linesByDay.get(days[1]) ?? '') + line);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [day, lines] of linesByDay) {
      appendFileSync(this.dayPath(day), lines + '\n', { mode: 0o600 });
    }

    const claimed = [...candidates.values()];
    this.syncDays(claimed.flatMap(({ days }) => days));
    return claimed
      .filter(({ turn, days }) => this.ownerOf(turn.messageId, days) === sessionId)
      .map(({ turn }) => turn);
  }

  private ownerOf(messageId: string, days: MidnightStraddle): string | undefined {
    for (const day of days) {
      const owner = this.days.get(day)?.owners.get(messageId);
      if (owner !== undefined) return owner;
    }
    return undefined;
  }

  private trimCache(): void {
    for (const day of this.days.keys()) {
      if (this.days.size <= MAX_CACHED_DAYS) return;
      this.days.delete(day);
    }
  }

  private syncDays(days: readonly DayKey[]): void {
    for (const day of new Set(days)) {
      const index = this.days.get(day) ?? { offset: 0, partial: '', owners: new Map() };
      this.days.delete(day);
      this.days.set(day, index);

      let size: number;
      try {
        size = statSync(this.dayPath(day)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        size = 0;
      }
      const prunedAndRecreated = size < index.offset;
      if (prunedAndRecreated) {
        index.offset = 0;
        index.partial = '';
        index.owners.clear();
      }
      if (size === index.offset) continue;

      const text = index.partial + readRange(this.dayPath(day), index.offset, size);
      const lastNewline = text.lastIndexOf('\n');
      foldLines(text.slice(0, lastNewline + 1), index.owners);
      index.partial = text.slice(lastNewline + 1);
      index.offset = size;
    }
  }

  private dayPath(day: DayKey): string {
    return join(this.dir, `${day}.jsonl`);
  }
}

export function pruneBilledTurns(storagePath: string, retainDays: number, nowMs: number): number {
  const dir = join(storagePath, LEDGER_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match || !dayIsBeyondHorizon(match[1] as DayKey, nowMs, retainDays)) continue;
    try {
      unlinkSync(join(dir, name));
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return deleted;
}

function dayKeyOf(timestampMs: number): DayKey {
  return new Date(timestampMs).toISOString().slice(0, 10) as DayKey;
}

function midnightStraddle(day: DayKey): MidnightStraddle {
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  return [dayKeyOf(startMs - DAY_MS), day, dayKeyOf(startMs + DAY_MS)];
}

function dayIsBeyondHorizon(day: DayKey, nowMs: number, retainDays: number | null): boolean {
  if (retainDays === null || retainDays <= 0) return false;
  return Date.parse(`${day}T00:00:00.000Z`) + DAY_MS <= nowMs - retainDays * DAY_MS;
}

function readRange(path: string, start: number, end: number): string {
  const buf = Buffer.allocUnsafe(end - start);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString('utf-8', 0, read);
  } finally {
    closeSync(fd);
  }
}

function foldLines(text: string, owners: Map<string, string>): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: { m?: unknown; s?: unknown };
    try {
      parsed = JSON.parse(line) as { m?: unknown; s?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.m !== 'string' || typeof parsed.s !== 'string') continue;
    if (!owners.has(parsed.m)) owners.set(parsed.m, parsed.s);
  }
}
