/**
 * Tracks which sessions are currently active based on recent tool call activity.
 * A session is "live" if it received a tool call within the staleness threshold.
 */

const DEFAULT_STALE_THRESHOLD_MS = 180_000; // 3 minutes

export class LiveSessionRegistry {
  private readonly lastActivity = new Map<string, number>();
  private readonly staleThresholdMs: number;

  constructor(staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS) {
    this.staleThresholdMs = staleThresholdMs;
  }

  touch(sessionId: string): void {
    this.lastActivity.set(sessionId, Date.now());
  }

  getLiveSessions(): string[] {
    const now = Date.now();
    const live: string[] = [];
    for (const [id, ts] of this.lastActivity) {
      if (now - ts <= this.staleThresholdMs) {
        live.push(id);
      }
    }
    for (const [id, ts] of this.lastActivity) {
      if (now - ts > this.staleThresholdMs) {
        this.lastActivity.delete(id);
      }
    }
    return live;
  }

  reset(): void {
    this.lastActivity.clear();
  }

  isLive(sessionId: string): boolean {
    const ts = this.lastActivity.get(sessionId);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.staleThresholdMs) {
      this.lastActivity.delete(sessionId);
      return false;
    }
    return true;
  }
}
