import type { FullSessionSummary, SessionStore } from '../storage/session-store.js';
import type { SaveResult, SessionWriter } from '../storage/session-writers.js';

const writers = new WeakMap<SessionStore, SessionWriter>();

/**
 * Saves `summary` as the whole share of one engine writer per store, the way a
 * process saves its own share. Saving a session again through the same store
 * replaces that share. Another store on the same directory is another process.
 */
export function saveAsWriter(store: SessionStore, summary: FullSessionSummary): SaveResult {
  let writer = writers.get(store);
  if (!writer) {
    writer = store.writer('engine');
    writers.set(store, writer);
  }
  return writer.save({ summary, retracted: false });
}
