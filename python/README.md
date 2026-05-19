# Python SDK

Python wrapper for NR AI Observatory. Automatically instruments API calls from Anthropic, Google Gemini, OpenAI, AWS Bedrock, Mistral, and Cohere — measuring latency, token usage, cost, and errors. All telemetry flows to New Relic.

## Supported Providers

| Provider | Module | Models | Streaming | Reasoning Tokens |
|----------|--------|--------|-----------|------------------|
| **Anthropic** | `wrap_anthropic_client()` | Claude Opus/Sonnet/Haiku | ✅ | ✅ |
| **Google** | `wrap_gemini_client()` | Gemini 1.5/2.0 | ✅ | ✅ |
| **OpenAI** | `wrap_openai_client()` | GPT-4o, o1, o3 | ✅ | ✅ |
| **AWS Bedrock** | `wrap_bedrock_client()` | Claude, Titan, Llama | ✅ | ✅ |
| **Mistral** | `wrap_mistral_client()` | Mistral Large, 7B | ✅ | — |
| **Cohere** | `wrap_cohere_client()` | Command R, R+ | ✅ | — |

## Installation

```bash
pip install nr-ai-agent
```

### Optional Dependencies

Install support for specific providers:

```bash
pip install nr-ai-agent[anthropic]
pip install nr-ai-agent[google-genai]
pip install nr-ai-agent[openai]
pip install nr-ai-agent[bedrock]
pip install nr-ai-agent[mistral]
pip install nr-ai-agent[cohere]
```

For development:

```bash
pip install nr-ai-agent[dev]
```

## Quick Start

### Anthropic

```python
import nr_ai_agent
from anthropic import Anthropic

# Initialize the agent
agent = nr_ai_agent.init(
    license_key="your-license-key",
    account_id=12345,
    app_name="my-app",
)

# Wrap your Anthropic client
client = Anthropic()
client = agent.wrap_anthropic_client(client)

# Make API calls as normal — events sent automatically
response = client.messages.create(
    model="claude-opus-4-20250805",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude!"}],
)

print(response.content[0].text)
agent.shutdown()
```

### Google Gemini

```python
import nr_ai_agent
from google.genai import GoogleGenerativeAI

# Initialize the agent
agent = nr_ai_agent.init(
    license_key="your-license-key",
    account_id=12345,
    app_name="my-app",
)

# Wrap your Google Gemini client
client = GoogleGenerativeAI(api_key="your-api-key")
client = agent.wrap_gemini_client(client)

# Make API calls
model = client.get_generative_model(model_name="gemini-2.0-flash")
response = model.generate_content("Hello!")
print(response.text)

agent.shutdown()
```

### OpenAI

```python
import nr_ai_agent
from openai import OpenAI

# Initialize the agent
agent = nr_ai_agent.init(
    license_key="your-license-key",
    account_id=12345,
    app_name="my-app",
)

# Wrap your OpenAI client
client = OpenAI(api_key="your-api-key")
client = agent.wrap_openai_client(client)

# Make API calls
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response.choices[0].message.content)
agent.shutdown()
```

### AWS Bedrock

```python
import nr_ai_agent
import boto3

# Initialize the agent
agent = nr_ai_agent.init(
    license_key="your-license-key",
    account_id=12345,
    app_name="my-app",
)

# Wrap your Bedrock client
bedrock = boto3.client("bedrock-runtime", region_name="us-west-2")
bedrock = agent.wrap_bedrock_client(bedrock)

# Make API calls
response = bedrock.invoke_model(
    modelId="anthropic.claude-opus-4-20250805-v1:0",
    body=json.dumps({"prompt": "Hello!"}),
)

agent.shutdown()
```

### Streaming

All wrappers support streaming:

```python
response = client.messages.stream(
    model="claude-opus-4-20250805",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Count to 10"}],
)

for text in response.text_stream:
    print(text, end="", flush=True)
```

## Configuration

```python
agent = nr_ai_agent.init(
    license_key="your-license-key",     # Required
    account_id=12345,                    # Required
    app_name="my-app",                   # Optional
    record_content=False,                # Optional: record message content (default: False)
    high_security=False,                 # Optional: force record_content=False (default: False)
)
```

Or via environment variables:

- `NEW_RELIC_LICENSE_KEY` — 40-char ingest key
- `NEW_RELIC_ACCOUNT_ID` — Numeric account ID
- `NEW_RELIC_APP_NAME` — Application identifier
- `NEW_RELIC_AI_RECORD_CONTENT` — Include message text in telemetry
- `NEW_RELIC_AI_HIGH_SECURITY` — Force content recording off

## Events Sent

Every wrapped call produces:

- **AiRequest** — API call initiated (model, parameters, token estimates)
- **AiResponse** — Response received (latency, actual tokens, cost in USD)
- **AiMessage** (optional) — Message content if `record_content=True`

See [METRICS_TABLE.md](../docs/METRICS_TABLE.md) for complete event schema.

## Features

- **Automatic token tracking** — Captures input, output, thinking, and cache tokens
- **Cost calculation** — Computes request costs using real-time pricing data
- **Request timing** — Measures latency and time-to-first-token
- **Error classification** — Tracks error types and status codes
- **Cache economics** — Monitors cache hit rates and savings
- **Conversation tracking** — Tracks multi-turn conversations and context pressure
- **Quality signals** — Detects quality anomalies and monitors response quality
- **Multi-modal support** — Detects images, PDFs, audio, and video in requests
- **Cost attribution** — Tags costs by feature, team, user, and environment

## Testing

```bash
pytest tests/ -v
```

## Architecture

The Python agent provides:

- **Config module** — Environment-based configuration with validation
- **Pricing module** — Token pricing tables and cost calculation
- **Timing module** — Request latency measurement
- **Errors module** — Error classification and extraction
- **Transport module** — Event and metric delivery to New Relic
- **Wrapper modules** — Provider-specific client wrappers

## Supported Models

### Anthropic
- claude-opus-4
- claude-sonnet-4
- claude-haiku-4

### Google Genai
- gemini-2.0-flash
- gemini-1.5-pro
- gemini-1.5-flash

### OpenAI
- gpt-4o
- gpt-4-turbo
- gpt-4

### AWS Bedrock
- anthropic.claude-opus-4
- anthropic.claude-sonnet-4
- amazon.titan-text-premier

### Mistral
- mistral-large
- mistral-medium
- mistral-small

### Cohere
- command-r-plus
- command-r

## Pricing Data

Token rates are automatically loaded for all providers and models. To use custom rates:

```bash
export NEW_RELIC_AI_CUSTOM_PRICING_FILE=/path/to/pricing.json
```

See `pricing.py` for the schema.

## Troubleshooting

### Events not appearing in New Relic

1. Verify license key and account ID
2. Check stderr for transport errors
3. Call `agent.shutdown()` to flush final batch of events
4. Wait 1-2 minutes for events to propagate

### Import errors

Install the provider's SDK:

```bash
pip install anthropic            # For Anthropic support
pip install google-generativeai  # For Google Genai
pip install openai               # For OpenAI
pip install boto3                # For AWS Bedrock
pip install mistralai            # For Mistral
pip install cohere               # For Cohere
```

## See Also

- [nr-ai-agent (TypeScript)](../packages/nr-ai-agent/) — TypeScript SDK wrapper
- [@nr-ai-observatory/shared](../packages/shared/) — Shared transport layer
- [ONBOARDING.md](../docs/ONBOARDING.md) — Full setup guide
