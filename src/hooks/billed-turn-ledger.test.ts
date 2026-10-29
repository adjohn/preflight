import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilledTurnLedger, pruneBilledTurns } from './billed-turn-ledger.js';

const PARENT = 'c0ac675e-9be7-48e9-87b8-86394606f2dc';
const FORK = '5634b9b2-8fa1-42c8-aff0-a4b50a704343';
const DAY_MS = 24 * 60 * 60 * 1000;

function turn(messageId: string, iso: string) {
  return { messageId, timestampMs: Date.parse(iso) };
}

describe('BilledTurnLedger', () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'billed-turn-ledger-'));
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  const makeLedger = (now?: () => number, retainDays?: number | null) =>
    new BilledTurnLedger({ storagePath, now, retainDays });

  it('returns a new turn once, and nothing when the same input is claimed again', () => {
    const ledger = makeLedger();
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(ledger.claim(PARENT, [a])).toEqual([a]);
    expect(ledger.claim(PARENT, [a])).toEqual([]);
    expect(makeLedger().claim(PARENT, [a])).toEqual([]);
  });

  it('returns only the first line of a multi-line message, in and across batches', () => {
    const ledger = makeLedger();
    const first = turn('msg_A', '2026-06-15T12:00:00.000Z');
    const second = turn('msg_A', '2026-06-15T12:00:01.000Z');
    const other = turn('msg_B', '2026-06-15T12:00:02.000Z');
    expect(ledger.claim(PARENT, [first, second, other])).toEqual([first, other]);
    expect(ledger.claim(PARENT, [turn('msg_A', '2026-06-15T12:00:03.000Z')])).toEqual([]);
  });

  it("drops another session's copy of a billed turn, including after a restart", () => {
    const a = turn('msg_A', '2026-10-29T22:30:50.181Z');
    const c = turn('msg_C', '2026-10-29T22:31:31.042Z');
    expect(makeLedger().claim(PARENT, [a])).toEqual([a]);
    expect(makeLedger().claim(FORK, [a, c])).toEqual([c]);
    expect(makeLedger().claim(PARENT, [a, c])).toEqual([]);
  });

  it('resolves a message whose lines straddle UTC midnight to one owner', () => {
    const beforeMidnight = turn('msg_A', '2026-06-15T23:59:59.900Z');
    const afterMidnight = turn('msg_A', '2026-06-16T00:00:00.100Z');
    expect(makeLedger().claim(PARENT, [beforeMidnight])).toEqual([beforeMidnight]);
    expect(makeLedger().claim(PARENT, [afterMidnight])).toEqual([]);
    expect(makeLedger().claim(FORK, [afterMidnight])).toEqual([]);
  });

  it('ignores a torn line left by a crashed writer', () => {
    const dir = join(storagePath, 'billed-turns');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, '2026-06-15.jsonl'), `{"m":"msg_A","s":"${FORK}`);
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(makeLedger().claim(PARENT, [a])).toEqual([a]);
    expect(makeLedger().claim(FORK, [a])).toEqual([]);
  });

  it('refuses turns beyond the retention horizon and never re-bills a pruned day', () => {
    const t = turn('msg_A', '2026-06-15T12:00:00.000Z');
    const soon = t.timestampMs + DAY_MS;
    const later = t.timestampMs + 100 * DAY_MS;
    expect(makeLedger(() => soon, 90).claim(PARENT, [t])).toEqual([t]);

    expect(pruneBilledTurns(storagePath, 90, soon)).toBe(0);
    expect(pruneBilledTurns(storagePath, 90, later)).toBe(1);
    expect(readdirSync(join(storagePath, 'billed-turns'))).toEqual([]);

    expect(makeLedger(() => later, 90).claim(PARENT, [t])).toEqual([]);
    expect(makeLedger(() => later, 90).claim(FORK, [t])).toEqual([]);
    expect(makeLedger(() => later, null).claim(FORK, [t])).toEqual([t]);
  });

  it('awards each message to exactly one of two processes racing on the same ids', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `msg_${i}`);
    const startAt = Date.now() + 1_000;
    const script = `
      const { BilledTurnLedger } = await import(${JSON.stringify(join(process.cwd(), 'src/hooks/billed-turn-ledger.ts'))});
      const [storagePath, sessionId, startAt, ids] = JSON.parse(process.argv[1]);
      const ledger = new BilledTurnLedger({ storagePath });
      const ts = Date.parse('2026-06-15T12:00:00.000Z');
      while (Date.now() < startAt);
      const won = ids.flatMap((id) => ledger.claim(sessionId, [{ messageId: id, timestampMs: ts }]));
      process.stdout.write(JSON.stringify(won.map((t) => t.messageId)));
    `;
    const runClaimer = (sessionId: string) =>
      new Promise<string[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            script,
            JSON.stringify([storagePath, sessionId, startAt, ids]),
          ],
          { cwd: process.cwd() },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(err)),
        );
      });

    const [parentWon, forkWon] = await Promise.all([runClaimer(PARENT), runClaimer(FORK)]);

    expect(parentWon.filter((id) => forkWon.includes(id))).toEqual([]);
    expect([...parentWon, ...forkWon].sort()).toEqual([...ids].sort());
  }, 15_000);
});
