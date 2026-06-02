import { describe, it, expect } from '@jest/globals';
import { analyzeReplayTimeline } from './replay-analyzer.js';
import type { ReplayTimelineEntry } from '../../storage/types.js';

function makeEntry(overrides?: Partial<ReplayTimelineEntry>): ReplayTimelineEntry {
  return {
    timestamp: Date.now(),
    toolName: 'Read',
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

describe('analyzeReplayTimeline', () => {
  it('returns empty segments for a clean timeline', () => {
    const timeline = [
      makeEntry({ toolName: 'Read', filePath: '/a.ts' }),
      makeEntry({ toolName: 'Edit', filePath: '/a.ts' }),
      makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: true }),
    ];
    const result = analyzeReplayTimeline(timeline);
    expect(result.segments).toHaveLength(0);
    expect(result.worstSegment).toBeNull();
  });

  describe('thrashing detection', () => {
    it('detects edit-test-fail cycle >= 3 iterations', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 4; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts' }));
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const thrash = result.segments.filter((s) => s.type === 'thrashing');
      expect(thrash.length).toBeGreaterThanOrEqual(1);
      expect(thrash[0]!.target).toBe('/src/bug.ts');
      expect(thrash[0]!.iterations).toBeGreaterThanOrEqual(3);
    });

    it('ends thrashing segment when test passes', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts' }));
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: false }));
      }
      timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts' }));
      timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: true }));
      // Add more entries after the pass — they should not be in the segment
      timeline.push(makeEntry({ toolName: 'Read', filePath: '/src/other.ts' }));

      const result = analyzeReplayTimeline(timeline);
      const thrash = result.segments.filter((s) => s.type === 'thrashing');
      expect(thrash).toHaveLength(1);
      expect(thrash[0]!.endIndex).toBeLessThan(timeline.length - 1);
    });
  });

  describe('stuck loop detection', () => {
    it('detects same command run >= 3 consecutive times', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 4; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.iterations).toBe(4);
      expect(stuck[0]!.target).toBe('npm test');
      expect(stuck[0]!.startIndex).toBe(0);
      expect(stuck[0]!.endIndex).toBe(3);
    });

    it('does not flag different commands as stuck', () => {
      const timeline = [
        makeEntry({ toolName: 'Bash', command: 'npm test' }),
        makeEntry({ toolName: 'Bash', command: 'npm build' }),
        makeEntry({ toolName: 'Bash', command: 'npm lint' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(0);
    });
  });

  describe('blind editing detection', () => {
    it('detects >= 3 edits to same file without reading it', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 4; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }));
      }

      const result = analyzeReplayTimeline(timeline);
      const blind = result.segments.filter((s) => s.type === 'blind_editing');
      expect(blind).toHaveLength(1);
      expect(blind[0]!.iterations).toBe(4);
      expect(blind[0]!.target).toBe('/src/x.ts');
    });

    it('resets count when file is read', () => {
      const timeline = [
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Read', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const blind = result.segments.filter((s) => s.type === 'blind_editing');
      expect(blind).toHaveLength(0);
    });
  });

  describe('re-reading detection', () => {
    it('detects reading same file >= 4 times', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 5; i++) {
        timeline.push(makeEntry({ toolName: 'Read', filePath: '/src/big.ts' }));
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/other.ts' }));
      }

      const result = analyzeReplayTimeline(timeline);
      const reread = result.segments.filter((s) => s.type === 're_reading');
      expect(reread).toHaveLength(1);
      expect(reread[0]!.iterations).toBe(5);
      expect(reread[0]!.target).toBe('/src/big.ts');
    });

    it('does not flag file read only 3 times', () => {
      const timeline = [
        makeEntry({ toolName: 'Read', filePath: '/src/a.ts' }),
        makeEntry({ toolName: 'Read', filePath: '/src/a.ts' }),
        makeEntry({ toolName: 'Read', filePath: '/src/a.ts' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const reread = result.segments.filter((s) => s.type === 're_reading');
      expect(reread).toHaveLength(0);
    });
  });

  describe('severity', () => {
    it('marks >= 5 iterations as critical', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 6; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck[0]!.severity).toBe('critical');
    });

    it('marks < 5 iterations as warning', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck[0]!.severity).toBe('warning');
    });
  });

  describe('worstSegment', () => {
    it('selects stuck_loop with highest weighted score', () => {
      const timeline: ReplayTimelineEntry[] = [];
      // 3 blind edits (score: 3*1=3)
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/a.ts' }));
      }
      // 3 stuck loops (score: 3*2=6, due to 2x weight)
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      expect(result.worstSegment).not.toBeNull();
      expect(result.worstSegment!.type).toBe('stuck_loop');
    });
  });
});
