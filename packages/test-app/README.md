# test-app

End-to-end integration test for `nr-ai-agent`. Exercises the full instrumentation pipeline: Anthropic and Google Gemini API calls → token extraction → cost calculation → event creation → harvest scheduler → New Relic delivery.

## Purpose

This application validates that:
- SDK wrappers correctly intercept and instrument API calls
- Token extraction works for all providers
- Cost calculation produces accurate USD costs
- Events are correctly formatted and sent to New Relic
- The harvest scheduler batches and flushes events reliably

Used during development to catch regressions and verify new provider integrations.

## Running

```bash
# Install dependencies
npm install

# Build
npm run build

# Run with Anthropic
NEW_RELIC_LICENSE_KEY=... \
  NEW_RELIC_ACCOUNT_ID=... \
  ANTHROPIC_API_KEY=... \
  npm start

# Run with Google Gemini
NEW_RELIC_LICENSE_KEY=... \
  NEW_RELIC_ACCOUNT_ID=... \
  GOOGLE_API_KEY=... \
  npm start
```

### Development Mode

```bash
npx tsx src/index.ts
```

## What It Tests

### Anthropic Integration

- Wraps `Anthropic` client
- Makes `messages.create()` call with streaming
- Verifies token extraction from response usage
- Confirms `AiRequest` event fired at call initiation
- Confirms `AiResponse` event fired with latency and costs
- Validates USD cost calculation matches expected pricing

### Google Gemini Integration

- Wraps `GoogleGenerativeAI` client
- Calls `getGenerativeModel().generateContent()`
- Extracts token counts from Gemini response metadata
- Verifies events sent to New Relic
- Validates pricing for Gemini models

### Harvest Scheduler

- Events batched and queued for delivery
- Harvest timer triggers flush after ~5s
- Shutdown waits for final flush before exiting

## Example Output

```
18:32:45 | INFO | anthropic-test
  Request: claude-opus-4-20250805, 45 input tokens
  Response: 120 output tokens, 2.345s latency, $0.0067 cost

18:32:50 | INFO | harvest
  Flushing 2 events to New Relic

18:32:51 | INFO | harvest
  Events delivered successfully (batch-001)

18:32:51 | INFO | app
  ✅ Test completed. Check New Relic for AiRequest and AiResponse events.
```

## New Relic Verification

After running, check New Relic for:

1. **AiRequest event** — Should contain:
   - `provider` = "anthropic"
   - `model` = "claude-opus-4-20250805"
   - `messageCount` = 1
   - `streamingEnabled` = true/false

2. **AiResponse event** — Should contain:
   - `durationMs` > 0
   - `inputTokens` = ~45
   - `outputTokens` = ~120
   - `costUsd` ≈ $0.0067
   - `stopReason` = "end_turn"

Query via NRQL:

```sql
SELECT * FROM AiRequest, AiResponse 
WHERE provider = 'anthropic' 
  AND appName = 'test-app'
LIMIT 10
```

## Configuration

All config via environment variables:

```bash
# New Relic (required)
export NEW_RELIC_LICENSE_KEY=...
export NEW_RELIC_ACCOUNT_ID=...
export NEW_RELIC_APP_NAME=test-app         # default: "test-app"

# Provider API keys (required for respective provider)
export ANTHROPIC_API_KEY=...
export GOOGLE_API_KEY=...

# Harvest intervals (optional)
export NEW_RELIC_AI_HARVEST_EVENTS_MS=5000
export NEW_RELIC_AI_HARVEST_METRICS_MS=60000

# Recording (optional)
export NEW_RELIC_AI_RECORD_CONTENT=false   # Log full message text
export NEW_RELIC_AI_HIGH_SECURITY=false    # Force no content recording
```

## Source Code

`src/index.ts` demonstrates:

```typescript
import { init } from 'nr-ai-agent';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/genai';

// Initialize the agent
const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY!,
  accountId: Number(process.env.NEW_RELIC_ACCOUNT_ID!),
  appName: 'test-app',
});

// Wrap Anthropic client
const anthropic = new Anthropic();
const wrappedAnthropicClient = agent.wrapAnthropicClient(anthropic);

// Make instrumented API call
const response = await wrappedAnthropicClient.messages.create({
  model: 'claude-opus-4-20250805',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello Claude!' }],
});

// Or wrap Google Gemini client
const { GoogleGenAI } = await import('@google/genai');
const googleGenai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
const wrappedGeminiClient = agent.wrapGeminiClient(googleGenai);

const geminiResponse = await wrappedGeminiClient.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello!',
});

// Graceful shutdown flushes all pending events
await agent.shutdown();
```

## Troubleshooting

### Events not appearing in New Relic

1. Verify license key and account ID are correct
2. Check stderr for harvest errors (look for "400 Unauthorized" or similar)
3. Confirm `NEW_RELIC_APP_NAME` matches your NRQL query filter
4. Wait 1-2 minutes for events to propagate to New Relic UI

### Wrong token counts

- Verify the provider SDK version matches the wrapper expectations
- Check that response structure hasn't changed (use latest SDK versions)
- Look at stderr logger output for token extraction warnings

### Shutdown hangs

- Increase timeout in `src/index.ts` (default 30s)
- Check that harvest scheduler isn't deadlocked (look for debug logs)
- Ensure all wrapped clients are referenced and released

## Development

- **Build:** `npm run build`
- **Dev:** `npx tsx src/index.ts` (runs TS directly without build)
- **Test:** `npm test` (runs Jest suite if any tests exist)

## Dependencies

- `nr-ai-agent` — The SDK wrapper being tested
- `@anthropic-ai/sdk` — Anthropic API client
- `@google/genai` — Google Generative AI client
- `dotenv` — Load `.env` config

## See Also

- [nr-ai-agent](../nr-ai-agent/) — The SDK wrapper library
- [@nr-ai-observatory/shared](../shared/) — Shared transport layer
- [ONBOARDING.md](../../docs/ONBOARDING.md) — Full setup guide
