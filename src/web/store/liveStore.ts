import { create } from 'zustand';

export interface ToolCallEvent {
  readonly id: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

interface LiveState {
  readonly connected: boolean;
  readonly recentToolCalls: ToolCallEvent[];
  readonly cost: CostUpdateEvent | null;
  readonly antiPatterns: AntiPatternEvent[];
  setConnected(v: boolean): void;
  pushToolCall(e: ToolCallEvent): void;
  setCost(c: CostUpdateEvent): void;
  pushAntiPattern(e: AntiPatternEvent): void;
}

const RECENT_CAP = 20;
const ANTI_CAP = 10;

export const useLiveStore = create<LiveState>((set) => ({
  connected: false,
  recentToolCalls: [],
  cost: null,
  antiPatterns: [],

  setConnected: (v) => set({ connected: v }),

  pushToolCall: (e) =>
    set((s) => {
      const next = [...s.recentToolCalls, e];
      return {
        recentToolCalls: next.length > RECENT_CAP ? next.slice(next.length - RECENT_CAP) : next,
      };
    }),

  setCost: (c) => set({ cost: c }),

  pushAntiPattern: (e) =>
    set((s) => {
      const next = [...s.antiPatterns, e];
      return { antiPatterns: next.length > ANTI_CAP ? next.slice(next.length - ANTI_CAP) : next };
    }),
}));
