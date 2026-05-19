import { init, NrAiAgent } from './agent.js';

// Mock the transport so no real HTTP calls are made
jest.mock('@nr-ai-observatory/shared', () => {
  const actual = jest.requireActual<typeof import('@nr-ai-observatory/shared')>(
    '@nr-ai-observatory/shared',
  );
  return {
    ...actual,
    sendEvents: jest.fn().mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 }),
    sendMetrics: jest.fn().mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 }),
  };
});

let stderrSpy: ReturnType<typeof jest.spyOn>;

const validConfig = {
  licenseKey: 'test-license-key-1234567890abcdef',
  appName: 'test-app',
  accountId: '12345',
};

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
});

describe('NrAiAgent Phase 2 methods', () => {
  let agent: NrAiAgent;

  beforeEach(async () => {
    agent = await init(validConfig);
    stderrSpy.mockClear();
  });

  afterEach(async () => {
    await agent.shutdown();
  });

  describe('setConversationId', () => {
    it('does not throw', () => {
      expect(() => agent.setConversationId('conv-abc')).not.toThrow();
    });
  });

  describe('getConversationStats', () => {
    it('returns null for an unknown conversation', () => {
      expect(agent.getConversationStats('no-such-conv')).toBeNull();
    });
  });

  describe('endConversation', () => {
    it('does not throw for an unknown conversation', () => {
      expect(() => agent.endConversation('no-such-conv')).not.toThrow();
    });
  });

  describe('recordFeedback', () => {
    it('logs a warning for an unknown requestId', () => {
      agent.recordFeedback('ghost-id', 0.8);
      const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(output).toContain('Feedback for unknown request ID');
    });

    it('does not throw for a known requestId with a valid score', () => {
      const internal = agent as unknown as { recentRequestIds: Map<string, number> };
      internal.recentRequestIds.set('req-001', Date.now());
      expect(() => agent.recordFeedback('req-001', 0.9)).not.toThrow();
    });

    it('emits an AiQualityFeedback event for a known requestId', () => {
      type PrivateScheduler = { addEvent(event: Record<string, string | number | boolean>): void };
      const priv = agent as unknown as { recentRequestIds: Map<string, number>; scheduler: PrivateScheduler | null };
      priv.recentRequestIds.set('req-fb', Date.now());

      const addEventSpy = jest.spyOn(priv.scheduler!, 'addEvent');
      agent.recordFeedback('req-fb', 0.75);

      const fbCalls = addEventSpy.mock.calls.filter(([ev]) => ev['eventType'] === 'AiQualityFeedback');
      expect(fbCalls).toHaveLength(1);
      expect(fbCalls[0][0]['eventType']).toBe('AiQualityFeedback');
      expect(fbCalls[0][0]['nr.appName']).toBe('test-app');
      expect(fbCalls[0][0]['score']).toBe(0.75);
      expect(fbCalls[0][0]['requestId']).toBe('req-fb');
    });

    it('includes metadata key-value pairs in the AiQualityFeedback event', () => {
      type PrivateScheduler = { addEvent(event: Record<string, string | number | boolean>): void };
      const priv = agent as unknown as { recentRequestIds: Map<string, number>; scheduler: PrivateScheduler | null };
      priv.recentRequestIds.set('req-meta', Date.now());

      const addEventSpy = jest.spyOn(priv.scheduler!, 'addEvent');
      agent.recordFeedback('req-meta', 0.5, { source: 'human', category: 'accuracy' });

      const fbCalls = addEventSpy.mock.calls.filter(([ev]) => ev['eventType'] === 'AiQualityFeedback');
      expect(fbCalls).toHaveLength(1);
      expect(fbCalls[0][0]['source']).toBe('human');
      expect(fbCalls[0][0]['category']).toBe('accuracy');
    });
  });

  describe('recordRegeneration', () => {
    it('logs a warning for an unknown requestId', () => {
      agent.recordRegeneration('ghost-id');
      const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(output).toContain('Regeneration for unknown request ID');
    });

    it('does not throw for a known requestId', () => {
      const internal = agent as unknown as { recentRequestIds: Map<string, number> };
      internal.recentRequestIds.set('req-002', Date.now());
      expect(() => agent.recordRegeneration('req-002')).not.toThrow();
    });
  });

  describe('recordEditDistance', () => {
    it('logs a warning for an unknown requestId', () => {
      agent.recordEditDistance('ghost-id', 0.5);
      const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(output).toContain('Edit distance for unknown request ID');
    });

    it('does not throw for a known requestId with a valid distance', () => {
      const internal = agent as unknown as { recentRequestIds: Map<string, number> };
      internal.recentRequestIds.set('req-003', Date.now());
      expect(() => agent.recordEditDistance('req-003', 0.25)).not.toThrow();
    });
  });

  describe('setAttributionContext', () => {
    it('does not throw when setting attribution tags', () => {
      expect(() =>
        agent.setAttributionContext({ team: 'backend', project: 'api', costCenter: 'eng' }),
      ).not.toThrow();
    });
  });

  describe('recentRequestIds cleanup', () => {
    it('evicts entries older than 1 hour when map exceeds 1000 entries', () => {
      type PrivateAgent = {
        recentRequestIds: Map<string, number>;
        ingestRequestRecord: (r: unknown) => void;
      };
      const priv = agent as unknown as PrivateAgent;
      const map = priv.recentRequestIds;

      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;

      // Insert 999 old entries and 1 recent — map size is 1000
      for (let i = 0; i < 999; i++) {
        map.set(`old-${i}`, twoHoursAgo);
      }
      map.set('recent-keep', now);

      // Inserting a full record via ingestRequestRecord pushes size to 1001
      // which triggers the cleanup loop (size > 1000)
      priv.ingestRequestRecord({
        id: 'trigger-cleanup',
        timestamp: now,
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        requestModel: 'claude-haiku-4-5-20251001',
        requestMethod: 'messages',
        streaming: false,
        maxTokens: null,
        temperature: null,
        topP: null,
        topK: null,
        messageCount: 1,
        toolCount: 0,
        toolNames: [],
        thinkingEnabled: false,
        thinkingBudgetTokens: null,
        systemPromptLength: null,
        durationMs: 10,
        timeToFirstTokenMs: null,
        inputTokens: 10,
        outputTokens: 5,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 15,
        stopReason: 'end_turn',
        contentBlockTypes: [],
        systemPrompt: null,
        lastUserMessage: null,
        responseText: null,
        error: null,
      });

      // All old entries should be gone
      for (let i = 0; i < 999; i++) {
        expect(map.has(`old-${i}`)).toBe(false);
      }
      // Recent entries should survive
      expect(map.has('recent-keep')).toBe(true);
      expect(map.has('trigger-cleanup')).toBe(true);
    });
  });
});

describe('init()', () => {
  // ---------------------------------------------------------------------------
  // 1. Returns NrAiAgent with all expected methods
  // ---------------------------------------------------------------------------
  it('returns NrAiAgent with all expected methods', async () => {
    const agent = await init(validConfig);

    expect(agent).toBeInstanceOf(NrAiAgent);
    expect(typeof agent.wrapAnthropicClient).toBe('function');
    expect(typeof agent.wrapGeminiClient).toBe('function');
    expect(typeof agent.shutdown).toBe('function');
    expect(typeof agent.getStats).toBe('function');

    await agent.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 2. Missing license key rejects with clear error
  // ---------------------------------------------------------------------------
  it('rejects when license key is missing', async () => {
    const savedKey = process.env.NEW_RELIC_LICENSE_KEY;
    const savedApp = process.env.NEW_RELIC_APP_NAME;
    delete process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_APP_NAME;

    try {
      await expect(init({ appName: 'test' })).rejects.toThrow('NEW_RELIC_LICENSE_KEY');
    } finally {
      if (savedKey) process.env.NEW_RELIC_LICENSE_KEY = savedKey;
      if (savedApp) process.env.NEW_RELIC_APP_NAME = savedApp;
    }
  });

  // ---------------------------------------------------------------------------
  // 3. enabled=false returns no-op agent
  // ---------------------------------------------------------------------------
  it('returns no-op agent when enabled=false', async () => {
    const agent = await init({ ...validConfig, enabled: false });

    expect(agent.getStats().enabled).toBe(false);

    await agent.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 4. Concurrent init() calls return the same agent instance
  // ---------------------------------------------------------------------------
  it('concurrent calls return the same agent instance', async () => {
    const [first, second] = await Promise.all([init(validConfig), init(validConfig)]);

    expect(second).toBe(first);

    await first.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 5. shutdown() clears initPromise so re-init creates a new agent
  // ---------------------------------------------------------------------------
  it('shutdown clears initPromise allowing re-initialization', async () => {
    const first = await init(validConfig);
    await first.shutdown();

    const second = await init(validConfig);
    expect(second).not.toBe(first);

    await second.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 6. getStats() reflects agent state
  // ---------------------------------------------------------------------------
  it('getStats reflects enabled state and uptime', async () => {
    const agent = await init(validConfig);
    const stats = agent.getStats();

    expect(stats.enabled).toBe(true);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(stats.eventsBuffered).toBe(0);
    expect(stats.eventsSent).toBe(0);
    expect(stats.eventsDropped).toBe(0);

    await agent.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 7. Failed init() resets initPromise so the next call can retry
  // ---------------------------------------------------------------------------
  it('resets initPromise after rejection so callers can retry', async () => {
    const savedKey = process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_LICENSE_KEY;

    try {
      await expect(init({ appName: 'test' })).rejects.toThrow();
      // After rejection, a valid init() should succeed
      const agent = await init(validConfig);
      expect(agent).toBeInstanceOf(NrAiAgent);
      await agent.shutdown();
    } finally {
      if (savedKey) process.env.NEW_RELIC_LICENSE_KEY = savedKey;
    }
  });
});

describe('NrAiAgent Phase 3 agentic methods', () => {
  let agent: NrAiAgent;

  beforeEach(async () => {
    agent = await init(validConfig);
    stderrSpy.mockClear();
  });

  afterEach(async () => {
    await agent.shutdown();
  });

  describe('startTask()', () => {
    it('returns a TaskSpan with traceId and spanId', () => {
      const span = agent.startTask('my-task');
      expect(span.traceId).toBeDefined();
      expect(span.spanId).toBeDefined();
      expect(span.spanType).toBe('agent_task');
    });

    it('two tasks have different traceIds', () => {
      const s1 = agent.startTask('task-1');
      const s2 = agent.startTask('task-2');
      expect(s1.traceId).not.toBe(s2.traceId);
    });
  });

  describe('getTaskMetrics()', () => {
    it('returns TaskAggregateStats shape with completedTaskCount 0 initially', () => {
      const stats = agent.getTaskMetrics();
      expect(stats).toHaveProperty('completedTaskCount', 0);
      expect(stats).toHaveProperty('avgCostPerTask');
      expect(stats).toHaveProperty('completionRate');
      expect(stats).toHaveProperty('avgStepsPerTask');
      expect(stats).toHaveProperty('avgDurationMs');
    });
  });

  describe('recordContextReset()', () => {
    it('does not throw when called with valid arguments', () => {
      expect(() =>
        agent.recordContextReset('conv-abc', {
          reason: 'summarization',
          tokensBefore: 5000,
          tokensAfter: 1200,
        })
      ).not.toThrow();
    });

    it('does not throw when optional fields are omitted', () => {
      expect(() =>
        agent.recordContextReset('conv-abc', { reason: 'manual' })
      ).not.toThrow();
    });
  });

  describe('registerIntegration()', () => {
    it('rejects with a helpful error for an unknown framework', async () => {
      await expect(agent.registerIntegration('no-such-framework')).rejects.toThrow(
        'no-such-framework',
      );
    });
  });

  describe('task summary event includes sub-agent delegation fields', () => {
    it('merges sub-agent metrics into the AiAgentTaskSummary NR event', () => {
      type PrivateScheduler = { addEvent(event: Record<string, string | number | boolean>): void };
      type PrivateAgent = { taskSummaryListener: (e: Event) => void; scheduler: PrivateScheduler };
      const priv = agent as unknown as PrivateAgent;
      const addEventSpy = jest.spyOn(priv.scheduler!, 'addEvent');

      const fakeTaskSummary = {
        id: 'evt-1',
        timestamp: Date.now(),
        traceId: 'trace-abc',
        spanId: 'span-xyz',
        taskName: 'test-task',
        durationMs: 500,
        totalLlmCalls: 1,
        totalToolCalls: 1,
        totalTokens: 100,
        totalCostUsd: 0.001,
        stepCount: 2,
        success: true,
        'nr.appName': 'test-app',
        customAttributes: {},
      };

      // Call the listener directly — globalThis.dispatchEvent is unavailable in Node.js test env
      priv.taskSummaryListener(new CustomEvent('ai-agent-task-summary', { detail: fakeTaskSummary }));

      const taskSummaryCalls = addEventSpy.mock.calls.filter(
        (args) => (args[0] as Record<string, unknown>)['eventType'] === 'AiAgentTaskSummary',
      );
      expect(taskSummaryCalls.length).toBeGreaterThan(0);
      const emitted = taskSummaryCalls[0][0];
      const emittedKeys = Object.keys(emitted);
      // Sub-agent metrics fields must be present (even if 0) in the NR event
      expect(emittedKeys).toContain('ai.agent.delegation_count');
      expect(emittedKeys).toContain('ai.agent.spawn_count');
    });
  });
});

describe('NrAiAgent Phase 4 — experiment variant tag schema', () => {
  it('emits ai.experiment.name and ai.experiment.variant attributes on NR events', async () => {
    const agent = await init(validConfig);

    type PrivateAgent = {
      scheduler: { addEvent(e: Record<string, unknown>): void };
      ingestRequestRecord: (r: unknown) => void;
      experimentTracker: { defineExperiment(c: unknown): void; tagRequest(n: string, v: string): void };
    };
    const priv = agent as unknown as PrivateAgent;
    const addEventSpy = jest.spyOn(priv.scheduler, 'addEvent');

    priv.experimentTracker.defineExperiment({
      name: 'my-exp',
      variants: ['control', 'treatment'],
      metrics: ['cost'],
      startDate: new Date(),
    });
    priv.experimentTracker.tagRequest('my-exp', 'treatment');

    priv.ingestRequestRecord({
      id: 'exp-rec',
      timestamp: Date.now(),
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      requestModel: 'claude-haiku-4-5-20251001',
      requestMethod: 'messages',
      streaming: false,
      maxTokens: null, temperature: null, topP: null, topK: null,
      messageCount: 1, toolCount: 0, toolNames: [],
      thinkingEnabled: false, thinkingBudgetTokens: null, systemPromptLength: null,
      durationMs: 50, timeToFirstTokenMs: null,
      inputTokens: 10, outputTokens: 5, thinkingTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15,
      stopReason: 'end_turn', contentBlockTypes: [],
      systemPrompt: null, lastUserMessage: null, responseText: null,
      error: null,
    });

    const requestEvents = addEventSpy.mock.calls
      .map(([e]) => e as Record<string, unknown>)
      .filter((e) => e['eventType'] === 'AiRequest');
    expect(requestEvents.length).toBeGreaterThan(0);
    // Custom attributes are prefixed with "custom." in serialized NR events
    expect(requestEvents[0]['custom.ai.experiment.name']).toBe('my-exp');
    expect(requestEvents[0]['custom.ai.experiment.variant']).toBe('treatment');

    await agent.shutdown();
  });
});

describe('NrAiAgent Phase 4 — forecast metrics', () => {
  it('emits ai.forecast.projected_daily_cost_usd metric', async () => {
    const agent = await init(validConfig);

    type PrivateAgent = {
      scheduler: { recordMetric(name: string, value: number, dims: Record<string, string>): void };
      emitCostForecastMetrics: () => void;
      costForecaster: { recordCost(ts: number, cost: number, dims?: Record<string, string>): void };
    };
    const priv = agent as unknown as PrivateAgent;
    const recordMetricSpy = jest.spyOn(priv.scheduler, 'recordMetric');

    // Seed forecaster with enough data to produce non-zero daily projections
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (let i = 7; i >= 0; i--) {
      priv.costForecaster.recordCost(now - i * day, 1.0);
    }

    priv.emitCostForecastMetrics();

    const dailyCostCalls = recordMetricSpy.mock.calls.filter(
      ([name]) => name === 'ai.forecast.projected_daily_cost_usd',
    );
    expect(dailyCostCalls.length).toBeGreaterThan(0);

    await agent.shutdown();
  });
});

describe('NrAiAgent Phase 4 cost alert events', () => {
  it('emits AiCostGrowthAlert and AiCostForecastAlert events via scheduler', async () => {
    const agent = await init(validConfig);

    type PrivateScheduler = { addEvent(event: Record<string, string | number | boolean>): void };
    type PrivateAgent = {
      scheduler: PrivateScheduler | null;
      costForecaster: {
        recordCost(ts: number, cost: number, dims?: Record<string, string>): void;
        forecast(days: number): unknown;
      };
    };
    const priv = agent as unknown as PrivateAgent;
    const addEventSpy = jest.spyOn(priv.scheduler!, 'addEvent');

    // Feed the forecaster with rapidly growing costs to trigger growth alert
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    [1, 5, 20, 50, 100].forEach((cost, i) => {
      priv.costForecaster.recordCost(now - (4 - i) * day, cost);
    });

    // Force forecaster to run with a very low growth threshold (reconfigure via internal state)
    // Instead, directly force a forecast which uses a low threshold via a new forecaster
    // For the agent test, we verify the event shape by directly calling the onAlert callback.
    // Access private costForecaster and force it to invoke its alert callback:
    type CostForecasterPrivate = {
      onAlert: ((details: Record<string, unknown>) => void) | undefined;
    };
    const forecasterPriv = priv.costForecaster as unknown as CostForecasterPrivate;
    forecasterPriv.onAlert?.({ type: 'growth', growthRatePercent: 200, growthThresholdPercent: 10 });
    forecasterPriv.onAlert?.({ type: 'forecast', projectedMonthlyCostUsd: 5000, monthlyBudgetUsd: 1000 });

    const growthAlerts = addEventSpy.mock.calls.filter(
      ([ev]) => ev['eventType'] === 'AiCostGrowthAlert',
    );
    const forecastAlerts = addEventSpy.mock.calls.filter(
      ([ev]) => ev['eventType'] === 'AiCostForecastAlert',
    );

    expect(growthAlerts.length).toBe(1);
    expect(growthAlerts[0][0]['growthRatePercent']).toBe(200);
    expect(forecastAlerts.length).toBe(1);
    expect(forecastAlerts[0][0]['projectedMonthlyCostUsd']).toBe(5000);

    await agent.shutdown();
  });
});

describe('NrAiAgent Phase 4 — AiExperimentSummary per-variant stats', () => {
  it('includes primaryMetric and per-variant mean/p95/sampleCount in summary event', async () => {
    const agent = await init(validConfig);

    type PrivateAgent = {
      scheduler: { addEvent(e: Record<string, unknown>): void };
      experimentTracker: {
        defineExperiment(c: unknown): void;
        recordMetricValue(exp: string, variant: string, metric: string, value: number): void;
      };
    };
    const priv = agent as unknown as PrivateAgent;
    const addEventSpy = jest.spyOn(priv.scheduler, 'addEvent');

    priv.experimentTracker.defineExperiment({
      name: 'perf-test',
      variants: ['control', 'fast'],
      metrics: ['latency_ms'],
      startDate: new Date(),
    });

    // Record enough data points for meaningful stats
    for (let i = 0; i < 10; i++) {
      priv.experimentTracker.recordMetricValue('perf-test', 'control', 'latency_ms', 200 + i);
      priv.experimentTracker.recordMetricValue('perf-test', 'fast', 'latency_ms', 100 + i);
    }

    await agent.shutdown();

    const summaryEvents = addEventSpy.mock.calls
      .map(([e]) => e as Record<string, unknown>)
      .filter((e) => e['eventType'] === 'AiExperimentSummary' && e['experimentName'] === 'perf-test');

    expect(summaryEvents.length).toBeGreaterThan(0);
    const ev = summaryEvents[0];
    expect(ev['primaryMetric']).toBe('latency_ms');
    expect(typeof ev['variant.control.mean']).toBe('number');
    expect(typeof ev['variant.control.p95']).toBe('number');
    expect(ev['variant.control.sampleCount']).toBe(10);
    expect(typeof ev['variant.fast.mean']).toBe('number');
    expect(ev['variant.fast.sampleCount']).toBe(10);
    // fast variant mean should be lower (100-109 vs 200-209)
    expect((ev['variant.fast.mean'] as number)).toBeLessThan((ev['variant.control.mean'] as number));
  });
});

describe('NrAiAgent Phase 4 — AiExperimentConclusion statistical fields', () => {
  it('includes pValue, effectSize, and sample counts when a significant winner is found', async () => {
    const agent = await init(validConfig);

    type PrivateAgent = {
      scheduler: { addEvent(e: Record<string, unknown>): void };
      experimentTracker: {
        defineExperiment(c: unknown): void;
        recordMetricValue(exp: string, variant: string, metric: string, value: number): void;
      };
    };
    const priv = agent as unknown as PrivateAgent;
    const addEventSpy = jest.spyOn(priv.scheduler, 'addEvent');

    priv.experimentTracker.defineExperiment({
      name: 'conclude-test',
      variants: ['a', 'b'],
      metrics: ['score'],
      startDate: new Date(Date.now() - 1000),
      endDate: new Date(Date.now() - 1),  // already ended → forces conclusion
    });

    // Large, clearly different distributions so t-test yields p < 0.05
    for (let i = 0; i < 30; i++) {
      priv.experimentTracker.recordMetricValue('conclude-test', 'a', 'score', 10 + i * 0.1);
      priv.experimentTracker.recordMetricValue('conclude-test', 'b', 'score', 50 + i * 0.1);
    }

    await agent.shutdown();

    const conclusionEvents = addEventSpy.mock.calls
      .map(([e]) => e as Record<string, unknown>)
      .filter((e) => e['eventType'] === 'AiExperimentConclusion' && e['experimentName'] === 'conclude-test');

    expect(conclusionEvents.length).toBe(1);
    const ev = conclusionEvents[0];
    expect(ev['concluded']).toBe(1);
    // Statistical fields should be present when comparison is significant
    expect(typeof ev['pValue']).toBe('number');
    expect(typeof ev['effectSize']).toBe('number');
    expect(typeof ev['winnerSampleCount']).toBe('number');
    expect(typeof ev['loserSampleCount']).toBe('number');
    expect((ev['winnerSampleCount'] as number)).toBe(30);
    expect((ev['loserSampleCount'] as number)).toBe(30);
  });

  it('omits statistical fields when experiment expires with no winner', async () => {
    const agent = await init(validConfig);

    type PrivateAgent = {
      scheduler: { addEvent(e: Record<string, unknown>): void };
      experimentTracker: {
        defineExperiment(c: unknown): void;
        recordMetricValue(exp: string, variant: string, metric: string, value: number): void;
      };
    };
    const priv = agent as unknown as PrivateAgent;
    const addEventSpy = jest.spyOn(priv.scheduler, 'addEvent');

    priv.experimentTracker.defineExperiment({
      name: 'no-winner-test',
      variants: ['x', 'y'],
      metrics: ['score'],
      startDate: new Date(Date.now() - 1000),
      endDate: new Date(Date.now() - 1),  // expired
    });

    // Identical distributions → no significant winner
    for (let i = 0; i < 10; i++) {
      priv.experimentTracker.recordMetricValue('no-winner-test', 'x', 'score', 50);
      priv.experimentTracker.recordMetricValue('no-winner-test', 'y', 'score', 50);
    }

    await agent.shutdown();

    const conclusionEvents = addEventSpy.mock.calls
      .map(([e]) => e as Record<string, unknown>)
      .filter((e) => e['eventType'] === 'AiExperimentConclusion' && e['experimentName'] === 'no-winner-test');

    expect(conclusionEvents.length).toBe(1);
    const ev = conclusionEvents[0];
    expect(ev['endDateReached']).toBe(1);
    // No winner → statistical fields must be absent (not undefined/null — simply not set)
    expect(ev['pValue']).toBeUndefined();
    expect(ev['effectSize']).toBeUndefined();
    expect(ev['winnerSampleCount']).toBeUndefined();
    expect(ev['loserSampleCount']).toBeUndefined();
  });
});
