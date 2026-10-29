import { describe, expect, it } from '@jest/globals';
import { LocalSessionAggregator, RepoNameResolver } from './local-session-aggregator.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';

const REAL_ID = 'a143754c-f742-40b7-bf1a-7dc01ad1932f';

class StubRepoResolver extends RepoNameResolver {
  override resolve(): string | null {
    return 'acme/widgets';
  }
}

function summariesOf(agg: LocalSessionAggregator): Array<Record<string, unknown>> {
  return agg.toSummaries({
    developer: 'tester',
    platform: 'copilot',
    outcome: 'in progress',
    repoResolver: new StubRepoResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
  });
}

describe('LocalSessionAggregator durability gaps', () => {
  it('persists a chat-only session (usage, no tool calls) that it observed', () => {
    const agg = new LocalSessionAggregator();
    agg.recordTokenUsage(REAL_ID, {
      timestamp: Date.now(),
      costUsd: 3,
      model: 'claude-opus-4-7',
      inputTokens: 1000,
      outputTokens: 100,
    });
    const rollups = summariesOf(agg);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ sessionId: REAL_ID, estimatedCostUsd: 3 });
  });
});
