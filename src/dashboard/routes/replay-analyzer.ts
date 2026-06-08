import type { ReplayTimelineEntry } from '../../storage/types.js';

export interface AntiPatternSegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly iterations: number;
  readonly target: string;
  readonly severity: 'warning' | 'critical';
}

export interface ReplayAnalysis {
  readonly segments: AntiPatternSegment[];
  readonly worstSegment: AntiPatternSegment | null;
}

const THRASH_THRESHOLD = 3;
const STUCK_LOOP_THRESHOLD = 3;
const BLIND_EDIT_THRESHOLD = 3;
const RE_READ_THRESHOLD = 4;
const CRITICAL_THRESHOLD = 5;

export function analyzeReplayTimeline(timeline: ReplayTimelineEntry[]): ReplayAnalysis {
  const segments: AntiPatternSegment[] = [];

  segments.push(...detectThrashingSegments(timeline));
  segments.push(...detectStuckLoopSegments(timeline));
  segments.push(...detectBlindEditSegments(timeline));
  segments.push(...detectReReadingSegments(timeline));

  let worstSegment: AntiPatternSegment | null = null;
  let worstScore = 0;
  for (const seg of segments) {
    const score = seg.iterations * (seg.type === 'stuck_loop' ? 2 : 1);
    if (score > worstScore) {
      worstScore = score;
      worstSegment = seg;
    }
  }

  return { segments, worstSegment };
}

function severity(iterations: number): 'warning' | 'critical' {
  return iterations >= CRITICAL_THRESHOLD ? 'critical' : 'warning';
}

function detectThrashingSegments(timeline: ReplayTimelineEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  let lastEditFile: string | null = null;
  let lastEditIndex = -1;
  let cycleStartIndex = -1;
  let cycleCount = 0;
  let cycleFile: string | null = null;

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];

    if ((entry.toolName === 'Edit' || entry.toolName === 'Write') && entry.filePath) {
      if (entry.filePath !== lastEditFile) {
        if (cycleFile && cycleCount >= THRASH_THRESHOLD) {
          segments.push({
            type: 'thrashing',
            startIndex: cycleStartIndex,
            endIndex: i - 1,
            iterations: cycleCount,
            target: cycleFile,
            severity: severity(cycleCount),
          });
        }
        cycleCount = 0;
        cycleStartIndex = i;
        cycleFile = entry.filePath;
      }
      lastEditFile = entry.filePath;
      lastEditIndex = i;
    } else if (entry.toolName === 'Bash' && entry.isTestCommand && lastEditFile !== null) {
      if (!entry.success) {
        cycleCount++;
        if (cycleStartIndex === -1) cycleStartIndex = lastEditIndex;
      } else {
        if (cycleFile && cycleCount >= THRASH_THRESHOLD) {
          segments.push({
            type: 'thrashing',
            startIndex: cycleStartIndex,
            endIndex: i,
            iterations: cycleCount,
            target: cycleFile,
            severity: severity(cycleCount),
          });
        }
        cycleCount = 0;
        cycleStartIndex = i + 1;
      }
    }
  }

  if (cycleFile && cycleCount >= THRASH_THRESHOLD) {
    segments.push({
      type: 'thrashing',
      startIndex: cycleStartIndex,
      endIndex: timeline.length - 1,
      iterations: cycleCount,
      target: cycleFile,
      severity: severity(cycleCount),
    });
  }

  return segments;
}

function detectStuckLoopSegments(timeline: ReplayTimelineEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  let lastCommand: string | null = null;
  let runStart = -1;
  let consecutiveCount = 0;

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];

    if (entry.toolName === 'Bash' && entry.command != null) {
      if (entry.command === lastCommand) {
        consecutiveCount++;
      } else {
        if (lastCommand && consecutiveCount >= STUCK_LOOP_THRESHOLD) {
          segments.push({
            type: 'stuck_loop',
            startIndex: runStart,
            endIndex: i - 1,
            iterations: consecutiveCount,
            target: lastCommand,
            severity: severity(consecutiveCount),
          });
        }
        lastCommand = entry.command;
        runStart = i;
        consecutiveCount = 1;
      }
    } else {
      if (lastCommand && consecutiveCount >= STUCK_LOOP_THRESHOLD) {
        segments.push({
          type: 'stuck_loop',
          startIndex: runStart,
          endIndex: i - 1,
          iterations: consecutiveCount,
          target: lastCommand,
          severity: severity(consecutiveCount),
        });
      }
      lastCommand = null;
      consecutiveCount = 0;
    }
  }

  if (lastCommand && consecutiveCount >= STUCK_LOOP_THRESHOLD) {
    segments.push({
      type: 'stuck_loop',
      startIndex: runStart,
      endIndex: timeline.length - 1,
      iterations: consecutiveCount,
      target: lastCommand,
      severity: severity(consecutiveCount),
    });
  }

  return segments;
}

function detectBlindEditSegments(timeline: ReplayTimelineEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  const streaks = new Map<string, { start: number; count: number }>();

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];

    if ((entry.toolName === 'Edit' || entry.toolName === 'Write') && entry.filePath) {
      const existing = streaks.get(entry.filePath);
      if (existing) {
        existing.count++;
      } else {
        streaks.set(entry.filePath, { start: i, count: 1 });
      }
    } else if (entry.toolName === 'Read' && entry.filePath) {
      const streak = streaks.get(entry.filePath);
      if (streak && streak.count >= BLIND_EDIT_THRESHOLD) {
        segments.push({
          type: 'blind_editing',
          startIndex: streak.start,
          endIndex: i - 1,
          iterations: streak.count,
          target: entry.filePath,
          severity: severity(streak.count),
        });
      }
      streaks.delete(entry.filePath);
    } else if (
      entry.toolName === 'Bash' &&
      (entry.isTestCommand || entry.isBuildCommand || entry.isLintCommand) &&
      entry.success
    ) {
      for (const [file, streak] of streaks) {
        if (streak.count >= BLIND_EDIT_THRESHOLD) {
          segments.push({
            type: 'blind_editing',
            startIndex: streak.start,
            endIndex: i - 1,
            iterations: streak.count,
            target: file,
            severity: severity(streak.count),
          });
        }
      }
      streaks.clear();
    }
  }

  for (const [file, streak] of streaks) {
    if (streak.count >= BLIND_EDIT_THRESHOLD) {
      segments.push({
        type: 'blind_editing',
        startIndex: streak.start,
        endIndex: timeline.length - 1,
        iterations: streak.count,
        target: file,
        severity: severity(streak.count),
      });
    }
  }

  return segments;
}

function detectReReadingSegments(timeline: ReplayTimelineEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  const reads = new Map<string, number[]>();

  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].toolName === 'Read' && timeline[i].filePath) {
      const file = timeline[i].filePath!;
      const indices = reads.get(file) ?? [];
      indices.push(i);
      reads.set(file, indices);
    }
  }

  for (const [file, indices] of reads) {
    if (indices.length >= RE_READ_THRESHOLD) {
      segments.push({
        type: 're_reading',
        startIndex: indices[0],
        endIndex: indices[indices.length - 1],
        iterations: indices.length,
        target: file,
        severity: severity(indices.length),
      });
    }
  }

  return segments;
}
