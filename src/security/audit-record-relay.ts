import type { AuditRecord } from './audit-trail.js';

export interface AuditRecordRelay {
  /** Forwards the record to the attached sink, or holds it until one is attached. */
  readonly send: (record: AuditRecord) => void;
  /** Sets the sink and delivers everything held so far, oldest first. */
  readonly attach: (sink: (record: AuditRecord) => void) => void;
}

/**
 * Carries audit records that originate before the NR ingest manager exists
 * (a stdio session that is still pending) to the manager once it is built.
 */
export function createAuditRecordRelay(): AuditRecordRelay {
  const held: AuditRecord[] = [];
  let sink: ((record: AuditRecord) => void) | undefined;

  return {
    send: (record) => {
      if (sink) sink(record);
      else held.push(record);
    },
    attach: (next) => {
      sink = next;
      for (const record of held.splice(0)) next(record);
    },
  };
}
