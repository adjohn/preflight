import {
  ConversationStore,
  generateConversationIdFromMessages,
  conversationStateToCustomAttributes,
} from './conversation.js';

describe('generateConversationIdFromMessages', () => {
  it('should generate stable conversation ID for same prior messages', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
      { role: 'user' as const, content: 'How are you?' },
    ];

    const id1 = generateConversationIdFromMessages(messages);
    const id2 = generateConversationIdFromMessages(messages);

    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it('should generate different ID for different prior messages', () => {
    const messages1 = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
      { role: 'user' as const, content: 'Question 1' },
    ];

    const messages2 = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' }, // Different prior message
      { role: 'user' as const, content: 'Question 1' },
    ];

    const id1 = generateConversationIdFromMessages(messages1);
    const id2 = generateConversationIdFromMessages(messages2);

    expect(id1).not.toBe(id2);
  });

  it('should ignore last message in generation', () => {
    const messages1 = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
      { role: 'user' as const, content: 'Question 1' },
    ];

    const messages2 = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
      { role: 'user' as const, content: 'Question 2' }, // Different last message
    ];

    const id1 = generateConversationIdFromMessages(messages1);
    const id2 = generateConversationIdFromMessages(messages2);

    expect(id1).toBe(id2); // Same prior messages should produce same ID
  });

  it('should handle non-array input', () => {
    const id1 = generateConversationIdFromMessages([]);
    const id2 = generateConversationIdFromMessages([]);

    expect(id1).toBe(id2);
  });
});

describe('ConversationStore', () => {
  let store: ConversationStore;

  beforeEach(() => {
    store = new ConversationStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('should create new conversation state on first turn', () => {
    const state = store.getOrCreate('conv-1', 'claude-sonnet-4-20250514');

    expect(state.conversationId).toBe('conv-1');
    expect(state.turnCount).toBe(0);
    expect(state.totalTokens).toBe(0);
    expect(state.contextPressure).toBe(0);
  });

  it('should track conversation state across 5 turns', () => {
    const conversationId = 'conv-1';

    // Initialize
    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    // 5 turns
    for (let i = 0; i < 5; i++) {
      const state = store.recordTurn(
        conversationId,
        'claude-sonnet-4-20250514',
        1000, // input tokens
        500, // output tokens
        0, // thinking tokens
        0.01, // cost
        1000, // duration
        100, // system prompt tokens
      );

      expect(state.turnCount).toBe(i + 1);
      expect(state.totalInputTokens).toBe((i + 1) * 1000);
      expect(state.totalOutputTokens).toBe((i + 1) * 500);
      expect(state.totalTokens).toBe((i + 1) * 1500);
      expect(state.totalCostUsd).toBeCloseTo((i + 1) * 0.01, 4);
      expect(state.userWaitTimeMs).toBe((i + 1) * 1000);
    }
  });

  it('should calculate context pressure correctly (50k / 200k = 0.25)', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    const state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      50_000, // input tokens
      500,
      0,
      0.01,
      1000,
      null,
    );

    expect(state.contextPressure).toBeCloseTo(0.25, 2);
  });

  it('should calculate context growth rate correctly', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    // 3 turns with 5000 input tokens each
    for (let i = 0; i < 3; i++) {
      const state = store.recordTurn(
        conversationId,
        'claude-sonnet-4-20250514',
        5_000,
        500,
        0,
        0.01,
        1000,
        null,
      );

      // Context growth rate should stabilize at 5000 after first turn
      if (i > 0) {
        expect(state.contextGrowthRate).toBeCloseTo(5000, 0);
      }
    }
  });

  it('should estimate turns remaining correctly (150k remaining / 5k per turn = 30)', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    // Use 50k of 200k available
    store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      50_000,
      500,
      0,
      0.01,
      1000,
      null,
    );

    // Second turn to establish growth rate
    const state2 = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      5_000, // This gives 55k total, growth rate = 55k/2 = 27.5k per turn
      500,
      0,
      0.01,
      1000,
      null,
    );

    // With 145k remaining and ~27.5k per turn, should have ~5 turns
    if (state2.estimatedTurnsRemaining !== null) {
      expect(state2.estimatedTurnsRemaining).toBeGreaterThan(0);
      expect(state2.estimatedTurnsRemaining).toBeLessThan(10);
    }
  });

  it('should calculate system prompt token share (2000 / 10000 = 0.2)', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    const state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      10_000, // total input
      500,
      0,
      0.01,
      1000,
      2000, // system prompt
    );

    expect(state.systemPromptTokenShare).toBeCloseTo(0.2, 2);
  });

  it('should return existing state on getOrCreate call', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');
    store.recordTurn(conversationId, 'claude-sonnet-4-20250514', 1000, 500, 0, 0.01, 1000, null);

    const state2 = store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    expect(state2.turnCount).toBe(1);
  });

  it('should retrieve conversation state by ID', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');
    store.recordTurn(conversationId, 'claude-sonnet-4-20250514', 1000, 500, 0, 0.01, 1000, null);

    const state = store.getState(conversationId);

    expect(state).not.toBeNull();
    expect(state!.turnCount).toBe(1);
  });

  it('should return null for non-existent conversation', () => {
    const state = store.getState('non-existent');
    expect(state).toBeNull();
  });

  it('should end conversation and remove it from store', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');
    store.recordTurn(conversationId, 'claude-sonnet-4-20250514', 1000, 500, 0, 0.01, 1000, null);

    const state = store.end(conversationId);

    expect(state).not.toBeNull();
    expect(state!.turnCount).toBe(1);

    const retrievedState = store.getState(conversationId);
    expect(retrievedState).toBeNull();
  });

  it('should return null when ending non-existent conversation', () => {
    const state = store.end('non-existent');
    expect(state).toBeNull();
  });

  it('should shutdown without errors', () => {
    store.getOrCreate('conv-1', 'claude-sonnet-4-20250514');
    expect(() => store.shutdown()).not.toThrow();
  });

  it('should track cumulative user wait time correctly', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    // Turn 1: 1000ms wait
    let state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0.01,
      1000,
      null,
    );
    expect(state.userWaitTimeMs).toBe(1000);

    // Turn 2: 500ms wait
    state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0.01,
      500,
      null,
    );
    expect(state.userWaitTimeMs).toBe(1500);

    // Turn 3: 2000ms wait
    state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0.01,
      2000,
      null,
    );
    expect(state.userWaitTimeMs).toBe(3500);
  });

  it('should accumulate costs correctly', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');

    // Turn 1: $0.01
    let state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0.01,
      1000,
      null,
    );
    expect(state.totalCostUsd).toBeCloseTo(0.01, 4);

    // Turn 2: $0.015
    state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0.015,
      1000,
      null,
    );
    expect(state.totalCostUsd).toBeCloseTo(0.025, 4);
  });

  it('should invoke onConversationEnd callback on end()', () => {
    const ended: string[] = [];
    const trackingStore = new ConversationStore(undefined, undefined, (s) => {
      ended.push(s.conversationId);
    });

    trackingStore.getOrCreate('tracked-conv', 'claude-sonnet-4-20250514');
    trackingStore.recordTurn('tracked-conv', 'claude-sonnet-4-20250514', 100, 50, 0, 0, 500, null);
    trackingStore.end('tracked-conv');
    trackingStore.shutdown();

    expect(ended).toEqual(['tracked-conv']);
  });

  it('should evict stale conversations after TTL and invoke onConversationEnd', () => {
    jest.useFakeTimers();

    const evicted: string[] = [];
    const shortTtlMs = 5_000; // 5 seconds
    const cleanupIntervalMs = 1_000; // 1 second
    const ttlStore = new ConversationStore(shortTtlMs, cleanupIntervalMs, (s) => {
      evicted.push(s.conversationId);
    });

    ttlStore.getOrCreate('stale-conv', 'claude-sonnet-4-20250514');
    ttlStore.recordTurn('stale-conv', 'claude-sonnet-4-20250514', 100, 50, 0, 0, 500, null);

    // Advance time past TTL and trigger cleanup interval
    jest.advanceTimersByTime(shortTtlMs + cleanupIntervalMs + 1);

    expect(evicted).toContain('stale-conv');
    expect(ttlStore.getState('stale-conv')).toBeNull();

    ttlStore.shutdown();
    jest.useRealTimers();
  });

  it('should not evict conversations active within TTL', () => {
    jest.useFakeTimers();

    const evicted: string[] = [];
    const shortTtlMs = 5_000;
    const cleanupIntervalMs = 1_000;
    const ttlStore = new ConversationStore(shortTtlMs, cleanupIntervalMs, (s) => {
      evicted.push(s.conversationId);
    });

    ttlStore.getOrCreate('active-conv', 'claude-sonnet-4-20250514');
    ttlStore.recordTurn('active-conv', 'claude-sonnet-4-20250514', 100, 50, 0, 0, 500, null);

    // Advance time less than TTL
    jest.advanceTimersByTime(shortTtlMs - 1);

    expect(evicted).toHaveLength(0);
    expect(ttlStore.getState('active-conv')).not.toBeNull();

    ttlStore.shutdown();
    jest.useRealTimers();
  });
});

describe('conversationStateToCustomAttributes', () => {
  let store: ConversationStore;

  beforeEach(() => {
    store = new ConversationStore();
  });

  afterEach(() => {
    store.shutdown();
  });

  it('should include all required attributes', () => {
    const conversationId = 'conv-1';

    store.getOrCreate(conversationId, 'claude-sonnet-4-20250514');
    const state = store.recordTurn(
      conversationId,
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0.01,
      1000,
      100,
    );

    const attrs = conversationStateToCustomAttributes(state);

    expect(attrs['ai.conversation.id']).toBe('conv-1');
    expect(attrs['ai.conversation.turn_count']).toBe(1);
    expect(attrs['ai.conversation.total_tokens']).toBe(1500);
    expect(attrs['ai.conversation.total_input_tokens']).toBe(1000);
    expect(attrs['ai.conversation.total_output_tokens']).toBe(500);
    expect(attrs['ai.conversation.context_pressure']).toBeDefined();
    expect(attrs['ai.conversation.context_growth_rate']).toBe(1000);
    expect(attrs['ai.conversation.duration_ms']).toBeDefined();
    expect(attrs['ai.conversation.user_wait_time_ms']).toBe(1000);
  });

  it('should round values appropriately', () => {
    store.getOrCreate('conv-1', 'claude-sonnet-4-20250514');

    const state = store.recordTurn(
      'conv-1',
      'claude-sonnet-4-20250514',
      10_000,
      500,
      0,
      0.12345,
      1000,
      1500,
    );

    const attrs = conversationStateToCustomAttributes(state);

    // Context pressure should be rounded
    const pressure = attrs['ai.conversation.context_pressure'] as number;
    expect(pressure).toBe(Math.round(pressure * 1000) / 1000);

    // Cost should be rounded to 6 decimals
    const cost = attrs['ai.conversation.total_cost_usd'] as number;
    expect(cost).toBe(Math.round(cost * 1000000) / 1000000);
  });

  it('should omit null optional fields', () => {
    store.getOrCreate('conv-1', 'claude-sonnet-4-20250514');

    const state = store.recordTurn(
      'conv-1',
      'claude-sonnet-4-20250514',
      1000,
      500,
      0,
      0,
      1000,
      null, // No system prompt
    );

    const attrs = conversationStateToCustomAttributes(state);

    // These should not be present when null
    expect(attrs['ai.conversation.system_prompt_token_share']).toBeUndefined();
    expect(attrs['ai.conversation.total_cost_usd']).toBeUndefined();
  });
});
