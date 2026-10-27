import { describe, it, expect } from '@jest/globals';
import { createAuditRecordRelay } from './audit-record-relay.js';
import type { AuditRecord } from './audit-trail.js';

function makeAuditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'audit-1',
    timestamp: 1_700_000_000_000,
    sessionId: null,
    action: 'HookInstall',
    tool: 'nr_observe_install_hooks',
    detail: 'HookInstall: /home/dev/.claude/settings.json',
    developer: 'dev',
    ...overrides,
  };
}

describe('createAuditRecordRelay()', () => {
  it('holds records sent before a sink is attached and delivers them in order on attach', () => {
    const relay = createAuditRecordRelay();
    const delivered: string[] = [];

    relay.send(makeAuditRecord({ id: 'a' }));
    relay.send(makeAuditRecord({ id: 'b' }));
    expect(delivered).toEqual([]);

    relay.attach((record) => delivered.push(record.id));

    expect(delivered).toEqual(['a', 'b']);
  });

  it('forwards records straight to the sink once attached', () => {
    const relay = createAuditRecordRelay();
    const delivered: string[] = [];
    relay.attach((record) => delivered.push(record.id));

    relay.send(makeAuditRecord({ id: 'c' }));

    expect(delivered).toEqual(['c']);
  });

  it('delivers a held record once, even when a second sink attaches', () => {
    const relay = createAuditRecordRelay();
    const first: string[] = [];
    const second: string[] = [];
    relay.send(makeAuditRecord({ id: 'a' }));

    relay.attach((record) => first.push(record.id));
    relay.attach((record) => second.push(record.id));
    relay.send(makeAuditRecord({ id: 'b' }));

    expect(first).toEqual(['a']);
    expect(second).toEqual(['b']);
  });
});
