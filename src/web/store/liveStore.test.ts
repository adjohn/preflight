import { useLiveStore } from './liveStore';

describe('liveStore', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: false,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
    });
  });

  it('starts disconnected with empty arrays', () => {
    const s = useLiveStore.getState();
    expect(s.connected).toBe(false);
    expect(s.recentToolCalls).toEqual([]);
    expect(s.antiPatterns).toEqual([]);
    expect(s.cost).toBeNull();
  });

  it('setConnected toggles the flag', () => {
    useLiveStore.getState().setConnected(true);
    expect(useLiveStore.getState().connected).toBe(true);
  });

  it('pushToolCall appends and caps to last 20', () => {
    const push = useLiveStore.getState().pushToolCall;
    for (let i = 0; i < 25; i++) {
      push({ id: String(i), tool: 'Read', durationMs: 1, costUsd: 0, ts: i });
    }
    const s = useLiveStore.getState();
    expect(s.recentToolCalls.length).toBe(20);
    expect(s.recentToolCalls[0].id).toBe('5');
    expect(s.recentToolCalls[19].id).toBe('24');
  });

  it('setCost replaces the value', () => {
    useLiveStore.getState().setCost({
      sessionTotalUsd: 1.23,
      todayTotalUsd: 4.56,
      forecastEodUsd: null,
    });
    expect(useLiveStore.getState().cost?.sessionTotalUsd).toBe(1.23);
  });

  it('pushAntiPattern appends and caps to last 10', () => {
    const push = useLiveStore.getState().pushAntiPattern;
    for (let i = 0; i < 15; i++) {
      push({ type: 'thrashing', target: `f${i}.ts`, count: 1 });
    }
    const s = useLiveStore.getState();
    expect(s.antiPatterns.length).toBe(10);
    expect(s.antiPatterns[0].target).toBe('f5.ts');
  });
});
