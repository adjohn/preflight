import pytest

from nr_ai_agent import NrAiAgent, init
from nr_ai_agent.config import AgentConfig


# ---------------------------------------------------------------------------
# Mock clients for interception tests
# ---------------------------------------------------------------------------

class _MockUsage:
    def __init__(self, input_tokens: int, output_tokens: int):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _MockAnthropicResponse:
    def __init__(self):
        self.model = "claude-3-5-sonnet-20241022"
        self.usage = _MockUsage(100, 50)
        self.stop_reason = "end_turn"


class _MockAnthropicMessages:
    def create(self, **kwargs):  # type: ignore[override]
        return _MockAnthropicResponse()


class _MockAnthropicClient:
    def __init__(self):
        self.messages = _MockAnthropicMessages()


class _MockAnthropicStreamFinalMessage:
    model = "claude-3-5-sonnet-20241022"
    usage = _MockUsage(200, 100)


class _MockAnthropicRawStream:
    _chunks = ["Hello", " world"]

    @property
    def text_stream(self):  # type: ignore[override]
        yield from self._chunks

    def get_final_message(self):  # type: ignore[override]
        return _MockAnthropicStreamFinalMessage()


class _MockAnthropicStreamContextManager:
    def __enter__(self):  # type: ignore[override]
        self._stream = _MockAnthropicRawStream()
        return self._stream

    def __exit__(self, exc_type, exc_val, exc_tb):  # type: ignore[override]
        return None


class _MockAnthropicMessagesWithStream:
    def create(self, **kwargs):  # type: ignore[override]
        return _MockAnthropicResponse()

    def stream(self, **kwargs):  # type: ignore[override]
        return _MockAnthropicStreamContextManager()


class _MockAnthropicClientWithStream:
    def __init__(self):
        self.messages = _MockAnthropicMessagesWithStream()


class _MockGeminiUsage:
    def __init__(self, prompt_token_count: int, candidates_token_count: int):
        self.prompt_token_count = prompt_token_count
        self.candidates_token_count = candidates_token_count


class _MockGeminiResponse:
    def __init__(self):
        self.usage_metadata = _MockGeminiUsage(80, 40)


class _MockGeminiModels:
    def generate_content(self, **kwargs):  # type: ignore[override]
        return _MockGeminiResponse()


class _MockGeminiClient:
    def __init__(self):
        self.models = _MockGeminiModels()


class _MockGeminiChunk:
    def __init__(self, text: str, usage: object = None):
        self.text = text
        self.usage_metadata = usage


class _MockGeminiModelsWithStream:
    def generate_content(self, **kwargs):  # type: ignore[override]
        return _MockGeminiResponse()

    def generate_content_stream(self, **kwargs):  # type: ignore[override]
        yield _MockGeminiChunk("Hello")
        yield _MockGeminiChunk(" world", _MockGeminiUsage(80, 40))


class _MockGeminiClientWithStream:
    def __init__(self):
        self.models = _MockGeminiModelsWithStream()


def test_agent_initialization_disabled():
    """Test agent initialization with disabled config."""
    config = AgentConfig(enabled=False)
    agent = NrAiAgent(config)

    assert agent.config.enabled is False
    assert agent.event_transport is None
    assert agent.metric_transport is None


def test_agent_initialization_enabled():
    """Test agent initialization with enabled config."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)

    assert agent.config.enabled is True
    assert agent.event_transport is not None
    assert agent.metric_transport is not None


def test_agent_record_event_when_disabled():
    """Test recording event when agent is disabled."""
    config = AgentConfig(enabled=False)
    agent = NrAiAgent(config)
    agent.record_event({"test": "event"})

    assert len(agent.event_buffer) == 0


def test_agent_record_event_when_enabled():
    """Test recording event when agent is enabled."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)
    agent.record_event({"test": "event"})

    assert len(agent.event_buffer) == 1
    assert agent.event_buffer[0]["test"] == "event"


def test_agent_record_multiple_events():
    """Test recording multiple events."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)

    for i in range(5):
        agent.record_event({"index": i})

    assert len(agent.event_buffer) == 5


def test_agent_record_metric_when_disabled():
    """Test recording metric when agent is disabled."""
    config = AgentConfig(enabled=False)
    agent = NrAiAgent(config)
    agent.record_metric("test.metric", 123.45)

    assert len(agent.metric_buffer) == 0


def test_agent_record_metric_when_enabled():
    """Test recording metric when agent is enabled."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)
    agent.record_metric("test.metric", 123.45, {"tag": "value"})

    assert len(agent.metric_buffer) == 1
    assert agent.metric_buffer[0]["name"] == "test.metric"
    assert agent.metric_buffer[0]["value"] == 123.45
    assert agent.metric_buffer[0]["attributes"]["tag"] == "value"


def test_agent_wrap_anthropic_client_when_disabled():
    """Test wrapping Anthropic client when disabled."""
    config = AgentConfig(enabled=False)
    agent = NrAiAgent(config)
    client = {"test": "client"}
    wrapped = agent.wrap_anthropic_client(client)

    assert wrapped is client


def test_agent_wrap_anthropic_client_when_enabled():
    """Test wrapping Anthropic client when enabled returns same object."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)
    client = _MockAnthropicClient()
    wrapped = agent.wrap_anthropic_client(client)

    assert wrapped is client


def test_agent_wrap_gemini_client_when_disabled():
    """Test wrapping Gemini client when disabled."""
    config = AgentConfig(enabled=False)
    agent = NrAiAgent(config)
    client = {"test": "client"}
    wrapped = agent.wrap_gemini_client(client)

    assert wrapped is client


def test_agent_wrap_gemini_client_when_enabled():
    """Test wrapping Gemini client when enabled returns same object."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)
    client = _MockGeminiClient()
    wrapped = agent.wrap_gemini_client(client)

    assert wrapped is client


def test_agent_wrap_anthropic_client_intercepts_create():
    """Test that wrapped Anthropic client intercepts messages.create and records event."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)
    client = _MockAnthropicClient()
    agent.wrap_anthropic_client(client)

    client.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=100, messages=[])

    assert len(agent.event_buffer) == 1
    event = agent.event_buffer[0]
    assert event["eventType"] == "AiResponse"
    assert event["provider"] == "anthropic"
    assert event["model"] == "claude-3-5-sonnet-20241022"
    assert event["inputTokens"] == 100
    assert event["outputTokens"] == 50
    assert event["stopReason"] == "end_turn"
    assert event["durationMs"] >= 0


def test_agent_wrap_anthropic_client_records_error_event():
    """Test that wrapped Anthropic client records an event on error."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)

    class _ErrorMessages:
        def create(self, **kwargs):  # type: ignore[override]
            raise ValueError("API error")

    class _ErrorClient:
        def __init__(self):
            self.messages = _ErrorMessages()

    client = _ErrorClient()
    agent.wrap_anthropic_client(client)

    with pytest.raises(ValueError):
        client.messages.create(model="claude-3-5-sonnet-20241022", messages=[])

    assert len(agent.event_buffer) == 1
    assert "error" in agent.event_buffer[0]


def test_agent_wrap_anthropic_client_skips_if_no_messages_create():
    """Test that a client without messages.create is returned unchanged."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)
    client = {"test": "client"}
    wrapped = agent.wrap_anthropic_client(client)

    assert wrapped is client
    assert len(agent.event_buffer) == 0


def test_agent_wrap_gemini_client_intercepts_generate_content():
    """Test that wrapped Gemini client intercepts models.generate_content and records event."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)
    client = _MockGeminiClient()
    agent.wrap_gemini_client(client)

    client.models.generate_content(model="gemini-2.5-pro", contents="Hello")

    assert len(agent.event_buffer) == 1
    event = agent.event_buffer[0]
    assert event["eventType"] == "AiResponse"
    assert event["provider"] == "google"
    assert event["model"] == "gemini-2.5-pro"
    assert event["inputTokens"] == 80
    assert event["outputTokens"] == 40
    assert event["durationMs"] >= 0


def test_agent_wrap_gemini_client_records_error_event():
    """Test that wrapped Gemini client records an event on error."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)

    class _ErrorModels:
        def generate_content(self, **kwargs):  # type: ignore[override]
            raise RuntimeError("Gemini error")

    class _ErrorClient:
        def __init__(self):
            self.models = _ErrorModels()

    client = _ErrorClient()
    agent.wrap_gemini_client(client)

    with pytest.raises(RuntimeError):
        client.models.generate_content(model="gemini-2.5-pro", contents="Hello")

    assert len(agent.event_buffer) == 1
    assert "error" in agent.event_buffer[0]


def test_agent_wrap_gemini_client_skips_if_no_generate_content():
    """Test that a client without models.generate_content is returned unchanged."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)
    client = {"test": "client"}
    wrapped = agent.wrap_gemini_client(client)

    assert wrapped is client
    assert len(agent.event_buffer) == 0


def test_agent_wrap_anthropic_client_stream_intercepts_and_records():
    """Test that wrapped Anthropic streaming client intercepts messages.stream and records event."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)
    client = _MockAnthropicClientWithStream()
    agent.wrap_anthropic_client(client)

    chunks = []
    with client.messages.stream(model="claude-3-5-sonnet-20241022", max_tokens=100, messages=[]) as stream:
        for text in stream.text_stream:
            chunks.append(text)

    assert chunks == ["Hello", " world"]
    assert len(agent.event_buffer) == 1
    event = agent.event_buffer[0]
    assert event["eventType"] == "AiResponse"
    assert event["provider"] == "anthropic"
    assert event["inputTokens"] == 200
    assert event["outputTokens"] == 100
    assert event["streaming"] is True
    assert event["durationMs"] >= 0
    assert event.get("timeToFirstTokenMs") is not None


def test_agent_wrap_anthropic_client_stream_records_error_event():
    """Test that wrapped Anthropic streaming client records error event on exception."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)

    class _ErrorStream:
        def __enter__(self):  # type: ignore[override]
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):  # type: ignore[override]
            return None

        @property
        def text_stream(self):  # type: ignore[override]
            raise RuntimeError("stream error")
            yield  # make it a generator

    class _ErrorMessagesWithStream:
        def create(self, **kwargs):  # type: ignore[override]
            return _MockAnthropicResponse()

        def stream(self, **kwargs):  # type: ignore[override]
            return _ErrorStream()

    class _ErrorClientWithStream:
        def __init__(self):
            self.messages = _ErrorMessagesWithStream()

    client = _ErrorClientWithStream()
    agent.wrap_anthropic_client(client)

    with pytest.raises(RuntimeError):
        with client.messages.stream(model="claude-3-5-sonnet-20241022", messages=[]) as stream:
            list(stream.text_stream)

    assert len(agent.event_buffer) == 1
    assert agent.event_buffer[0].get("error") is not None
    assert agent.event_buffer[0]["streaming"] is True


def test_agent_wrap_gemini_client_stream_intercepts_and_records():
    """Test that wrapped Gemini streaming client intercepts generate_content_stream and records event."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)
    client = _MockGeminiClientWithStream()
    agent.wrap_gemini_client(client)

    chunks = list(client.models.generate_content_stream(model="gemini-2.5-pro", contents="Hello"))

    assert len(chunks) == 2
    assert chunks[0].text == "Hello"
    assert len(agent.event_buffer) == 1
    event = agent.event_buffer[0]
    assert event["eventType"] == "AiResponse"
    assert event["provider"] == "google"
    assert event["inputTokens"] == 80
    assert event["outputTokens"] == 40
    assert event["streaming"] is True
    assert event["durationMs"] >= 0
    assert event.get("timeToFirstTokenMs") is not None


def test_agent_wrap_gemini_client_stream_records_error_event():
    """Test that wrapped Gemini streaming client records error event on exception."""
    config = AgentConfig(enabled=True, license_key="test-key", account_id=123)
    agent = NrAiAgent(config)

    class _ErrorModelsWithStream:
        def generate_content(self, **kwargs):  # type: ignore[override]
            return _MockGeminiResponse()

        def generate_content_stream(self, **kwargs):  # type: ignore[override]
            raise RuntimeError("stream error")
            yield  # make it a generator

    class _ErrorClientWithStream:
        def __init__(self):
            self.models = _ErrorModelsWithStream()

    client = _ErrorClientWithStream()
    agent.wrap_gemini_client(client)

    with pytest.raises(RuntimeError):
        list(client.models.generate_content_stream(model="gemini-2.5-pro", contents="Hello"))

    assert len(agent.event_buffer) == 1
    assert agent.event_buffer[0].get("error") is not None
    assert agent.event_buffer[0]["streaming"] is True


def test_agent_shutdown():
    """Test agent shutdown."""
    config = AgentConfig(
        enabled=True,
        license_key="test-key",
        account_id=123,
    )
    agent = NrAiAgent(config)
    agent.record_event({"test": "event"})
    agent.record_metric("test.metric", 100)

    agent.shutdown()

    # Buffers should be empty after shutdown
    assert len(agent.event_buffer) == 0
    assert len(agent.metric_buffer) == 0
