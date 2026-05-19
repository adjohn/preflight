"""NR AI Agent - Python SDK for observability of AI model usage in New Relic."""

import logging
import time
import uuid
from threading import Lock
from typing import Any, Dict, List, Optional

from .config import AgentConfig
from .metrics.cache_economics import CacheEconomicsTracker, cache_metrics_to_custom_attributes, extract_cache_metrics
from .metrics.conversation import (
    ConversationStore,
    conversation_state_to_nr_event,
    generate_conversation_id_from_messages,
)
from .metrics.cost_attribution import (
    attribution_tags_to_custom_attributes,
    get_attribution_context,
    resolve_attribution,
    set_attribution_context,
)
from .metrics.multimodal import detect_modalities, modality_metrics_to_custom_attributes
from .metrics.provider_comparison import ProviderComparisonAggregator, provider_model_stats_to_nr_event
from .metrics.quality import QualityTracker, quality_metrics_to_custom_attributes
from .metrics.reasoning import extract_reasoning_metrics, reasoning_metrics_to_custom_attributes
from .pricing import TokenUsage, calculate_cost
from .timing import RequestTimer
from .transport.base import NrEventTransport, NrMetricTransport

__version__ = "0.2.0"
__all__ = [
    "init",
    "NrAiAgent",
    "wrap_anthropic_client",
    "wrap_gemini_client",
    "set_attribution_context",
]

logger = logging.getLogger(__name__)

# Global agent instance
_agent_instance: Optional["NrAiAgent"] = None
_agent_lock = Lock()


def init(
    license_key: Optional[str] = None,
    account_id: Optional[int] = None,
    app_name: Optional[str] = None,
    **kwargs: Any,
) -> "NrAiAgent":
    """Initialize the NR AI Agent."""
    global _agent_instance

    with _agent_lock:
        if _agent_instance is not None:
            return _agent_instance

        config = AgentConfig.from_env()
        if license_key:
            config.license_key = license_key
        if account_id:
            config.account_id = account_id
        if app_name:
            config.app_name = app_name

        for key, value in kwargs.items():
            if hasattr(config, key):
                setattr(config, key, value)

        if config.enabled:
            config.validate()

        _agent_instance = NrAiAgent(config)
        logger.info(f"NR AI Agent initialized (version {__version__})")
        return _agent_instance


class NrAiAgent:
    """Main agent class for nr-ai-agent."""

    def __init__(self, config: AgentConfig):
        self.config = config
        self.event_transport: Optional[NrEventTransport] = None
        self.metric_transport: Optional[NrMetricTransport] = None
        self.event_buffer: List[Dict[str, Any]] = []
        self.metric_buffer: List[Dict[str, Any]] = []
        self.buffer_lock = Lock()

        # Metric trackers
        self._quality_tracker = QualityTracker()
        self._cache_tracker = CacheEconomicsTracker()
        self._provider_agg = ProviderComparisonAggregator()
        self._conversation_store = ConversationStore(
            on_conversation_end=self._on_conversation_end
        )

        if config.enabled:
            self.event_transport = NrEventTransport(
                config.account_id,
                config.license_key,
                config.collector_host,
            )
            self.metric_transport = NrMetricTransport(
                config.account_id,
                config.license_key,
                config.collector_host,
            )

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    def set_conversation_id(self, conversation_id: str) -> None:
        """Associate subsequent requests with an explicit conversation ID."""
        self._current_conversation_id = conversation_id

    def end_conversation(self, conversation_id: str) -> None:
        """Close a conversation and flush its summary event."""
        self._conversation_store.end(conversation_id)

    def get_conversation_stats(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Return current conversation state or None if not found."""
        return self._conversation_store.get_state(conversation_id)

    def record_feedback(self, request_id: str, score: float, metadata: Optional[Dict[str, str]] = None) -> None:
        """Record user quality feedback for a completed request (score 0-1)."""
        self._quality_tracker.record_feedback(request_id, score, metadata)
        event: Dict[str, Any] = {
            "eventType": "AiQualityFeedback",
            "nr.appName": self.config.app_name,
            "requestId": request_id,
            "score": score,
        }
        if metadata:
            for key, value in metadata.items():
                event[key] = value
        self.record_event(event)

    def record_regeneration(self, request_id: str) -> None:
        """Record that the user asked to regenerate a response."""
        self._quality_tracker.record_regeneration(request_id)

    def record_edit_distance(self, request_id: str, edit_distance: float) -> None:
        """Record normalized edit distance (0-1) for a generated response."""
        self._quality_tracker.record_edit_distance(request_id, edit_distance)

    # ------------------------------------------------------------------
    # SDK client wrappers
    # ------------------------------------------------------------------

    def wrap_anthropic_client(self, client: Any) -> Any:
        """Wrap an Anthropic client."""
        if not self.config.enabled:
            return client

        messages = getattr(client, "messages", None)
        original_create = getattr(messages, "create", None)
        if original_create is None:
            logger.warning("Anthropic client does not have messages.create — skipping instrumentation")
            return client

        agent = self

        def wrapped_create(*args: Any, **kwargs: Any) -> Any:
            timer = RequestTimer()
            request_id = str(uuid.uuid4())
            try:
                response = original_create(*args, **kwargs)
                timer.end()
                usage = getattr(response, "usage", None)
                input_tokens = getattr(usage, "input_tokens", 0) if usage else 0
                output_tokens = getattr(usage, "output_tokens", 0) if usage else 0
                cache_read = getattr(usage, "cache_read_input_tokens", 0) if usage else 0
                cache_creation = getattr(usage, "cache_creation_input_tokens", 0) if usage else 0
                thinking_tokens = getattr(usage, "thinking_tokens", 0) if usage else 0
                model = getattr(response, "model", kwargs.get("model", ""))
                stop_reason = getattr(response, "stop_reason", None)
                duration_ms = round(timer.duration_ms)

                event = agent._build_response_event(
                    request_id=request_id,
                    provider="anthropic",
                    model=model,
                    duration_ms=duration_ms,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    thinking_tokens=thinking_tokens,
                    cache_read_tokens=cache_read,
                    cache_creation_tokens=cache_creation,
                    stop_reason=stop_reason,
                    streaming=False,
                    time_to_first_token_ms=None,
                    messages=list(kwargs.get("messages", [])),
                )
                agent.record_event(event)
                return response
            except Exception as e:
                timer.end()
                agent.record_event({
                    "eventType": "AiResponse",
                    "nr.appName": agent.config.app_name,
                    "provider": "anthropic",
                    "model": kwargs.get("model", ""),
                    "durationMs": round(timer.duration_ms),
                    "error": str(e),
                    "id": request_id,
                })
                raise

        client.messages.create = wrapped_create

        original_stream = getattr(messages, "stream", None)
        if original_stream is not None:
            def wrapped_stream(*args: Any, **kwargs: Any) -> Any:
                timer = RequestTimer()
                request_id_s = str(uuid.uuid4())
                original_cm = original_stream(*args, **kwargs)

                class _WrappedStreamContext:
                    def __enter__(self_inner: Any) -> Any:
                        raw = original_cm.__enter__()
                        self_inner._raw = raw

                        class _StreamProxy:
                            def __getattr__(self_p: Any, name: str) -> Any:
                                return getattr(raw, name)

                            @property
                            def text_stream(self_p: Any) -> Any:
                                for text in raw.text_stream:
                                    timer.mark_first_token()
                                    yield text

                        return _StreamProxy()

                    def __exit__(self_inner: Any, exc_type: Any, exc_val: Any, exc_tb: Any) -> Any:
                        result = original_cm.__exit__(exc_type, exc_val, exc_tb)
                        timer.end()
                        if exc_type is None:
                            final_msg = getattr(self_inner._raw, "get_final_message", lambda: None)()
                            usage = getattr(final_msg, "usage", None) if final_msg else None
                            input_tokens = getattr(usage, "input_tokens", 0) if usage else 0
                            output_tokens = getattr(usage, "output_tokens", 0) if usage else 0
                            cache_read = getattr(usage, "cache_read_input_tokens", 0) if usage else 0
                            cache_creation = getattr(usage, "cache_creation_input_tokens", 0) if usage else 0
                            thinking_tokens = getattr(usage, "thinking_tokens", 0) if usage else 0
                            model = (
                                getattr(final_msg, "model", kwargs.get("model", ""))
                                if final_msg else kwargs.get("model", "")
                            )
                            stop_reason = getattr(final_msg, "stop_reason", None) if final_msg else None
                            duration_ms = round(timer.duration_ms)
                            event = agent._build_response_event(
                                request_id=request_id_s,
                                provider="anthropic",
                                model=model,
                                duration_ms=duration_ms,
                                input_tokens=input_tokens,
                                output_tokens=output_tokens,
                                thinking_tokens=thinking_tokens,
                                cache_read_tokens=cache_read,
                                cache_creation_tokens=cache_creation,
                                stop_reason=stop_reason,
                                streaming=True,
                                time_to_first_token_ms=timer.time_to_first_token_ms,
                                messages=list(kwargs.get("messages", [])),
                            )
                            agent.record_event(event)
                        else:
                            agent.record_event({
                                "eventType": "AiResponse",
                                "nr.appName": agent.config.app_name,
                                "provider": "anthropic",
                                "model": kwargs.get("model", ""),
                                "durationMs": round(timer.duration_ms),
                                "error": str(exc_val) if exc_val else "unknown",
                                "streaming": True,
                                "id": request_id_s,
                            })
                        return result

                return _WrappedStreamContext()

            client.messages.stream = wrapped_stream

        logger.info("Wrapped Anthropic client")
        return client

    def wrap_gemini_client(self, client: Any) -> Any:
        """Wrap a Google Genai client."""
        if not self.config.enabled:
            return client

        models = getattr(client, "models", None)
        original_generate = getattr(models, "generate_content", None)
        if original_generate is None:
            logger.warning("Gemini client does not have models.generate_content — skipping instrumentation")
            return client

        agent = self

        def wrapped_generate_content(*args: Any, **kwargs: Any) -> Any:
            timer = RequestTimer()
            request_id = str(uuid.uuid4())
            try:
                response = original_generate(*args, **kwargs)
                timer.end()
                usage = getattr(response, "usage_metadata", None)
                input_tokens = getattr(usage, "prompt_token_count", 0) if usage else 0
                output_tokens = getattr(usage, "candidates_token_count", 0) if usage else 0
                model = kwargs.get("model", "")
                stop_reason = None
                duration_ms = round(timer.duration_ms)

                contents = list(kwargs.get("contents", []))
                event = agent._build_response_event(
                    request_id=request_id,
                    provider="google",
                    model=model,
                    duration_ms=duration_ms,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    thinking_tokens=0,
                    cache_read_tokens=0,
                    cache_creation_tokens=0,
                    stop_reason=stop_reason,
                    streaming=False,
                    time_to_first_token_ms=None,
                    messages=contents,
                )
                agent.record_event(event)
                return response
            except Exception as e:
                timer.end()
                agent.record_event({
                    "eventType": "AiResponse",
                    "nr.appName": agent.config.app_name,
                    "provider": "google",
                    "model": kwargs.get("model", ""),
                    "durationMs": round(timer.duration_ms),
                    "error": str(e),
                    "id": request_id,
                })
                raise

        client.models.generate_content = wrapped_generate_content

        original_generate_stream = getattr(models, "generate_content_stream", None)
        if original_generate_stream is not None:
            def wrapped_generate_content_stream(*args: Any, **kwargs: Any) -> Any:
                timer = RequestTimer()
                request_id_s = str(uuid.uuid4())
                model = kwargs.get("model", "")
                input_tokens = 0
                output_tokens = 0
                try:
                    for chunk in original_generate_stream(*args, **kwargs):
                        if getattr(chunk, "text", None):
                            timer.mark_first_token()
                        usage = getattr(chunk, "usage_metadata", None)
                        if usage:
                            input_tokens = getattr(usage, "prompt_token_count", 0) or 0
                            output_tokens = getattr(usage, "candidates_token_count", 0) or 0
                        yield chunk
                    timer.end()
                    contents = list(kwargs.get("contents", []))
                    event = agent._build_response_event(
                        request_id=request_id_s,
                        provider="google",
                        model=model,
                        duration_ms=round(timer.duration_ms),
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        thinking_tokens=0,
                        cache_read_tokens=0,
                        cache_creation_tokens=0,
                        stop_reason=None,
                        streaming=True,
                        time_to_first_token_ms=timer.time_to_first_token_ms,
                        messages=contents,
                    )
                    agent.record_event(event)
                except Exception as e:
                    timer.end()
                    agent.record_event({
                        "eventType": "AiResponse",
                        "nr.appName": agent.config.app_name,
                        "provider": "google",
                        "model": model,
                        "durationMs": round(timer.duration_ms),
                        "error": str(e),
                        "streaming": True,
                        "id": request_id_s,
                    })
                    raise

            client.models.generate_content_stream = wrapped_generate_content_stream

        logger.info("Wrapped Gemini client")
        return client

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_response_event(
        self,
        request_id: str,
        provider: str,
        model: str,
        duration_ms: float,
        input_tokens: int,
        output_tokens: int,
        thinking_tokens: int,
        cache_read_tokens: int,
        cache_creation_tokens: int,
        stop_reason: Optional[str],
        streaming: bool,
        time_to_first_token_ms: Optional[float],
        messages: List[Any],
    ) -> Dict[str, Any]:
        """Build an enriched AiResponse event with Phase 2 metrics."""
        event: Dict[str, Any] = {
            "eventType": "AiResponse",
            "nr.appName": self.config.app_name,
            "id": request_id,
            "provider": provider,
            "model": model,
            "durationMs": duration_ms,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "streaming": streaming,
        }

        if time_to_first_token_ms is not None:
            event["timeToFirstTokenMs"] = round(time_to_first_token_ms)

        if stop_reason:
            event["stopReason"] = stop_reason

        if thinking_tokens:
            event["thinkingTokens"] = thinking_tokens

        if cache_read_tokens or cache_creation_tokens:
            event["cacheReadTokens"] = cache_read_tokens
            event["cacheCreationTokens"] = cache_creation_tokens

        # Cost
        token_usage = TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            thinking_tokens=thinking_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
        )
        cost_usd = calculate_cost(provider, model, token_usage)
        if cost_usd:
            event["costUsd"] = cost_usd

        # Reasoning metrics
        reasoning = extract_reasoning_metrics(
            thinking_tokens=thinking_tokens,
            output_tokens=output_tokens,
            total_duration_ms=float(duration_ms),
        )
        event.update(reasoning_metrics_to_custom_attributes(reasoning))

        # Cache economics
        cache_metrics = extract_cache_metrics(provider, model, cache_read_tokens, cache_creation_tokens)
        event.update(cache_metrics_to_custom_attributes(cache_metrics))
        self._cache_tracker.record(provider, model, cache_read_tokens, cache_creation_tokens)

        # Multi-modal
        if messages:
            modalities = detect_modalities(messages)
            event.update(modality_metrics_to_custom_attributes(modalities))

        # Conversation tracking
        conv_id = generate_conversation_id_from_messages(messages) if messages else None
        if conv_id:
            event["conversationId"] = conv_id
            state = self._conversation_store.record_turn(
                conversation_id=conv_id,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                thinking_tokens=thinking_tokens,
                cost_usd=cost_usd,
                duration_ms=float(duration_ms),
                system_prompt_tokens=None,
            )
            from .metrics.conversation import conversation_state_to_custom_attributes
            event.update(conversation_state_to_custom_attributes(state))

        # Quality signals
        quality_flags = self._quality_tracker.record_structural_signals(
            duration_ms=float(duration_ms),
            output_tokens=output_tokens,
            stop_reason=stop_reason,
            has_error=False,
            time_to_first_token_ms=time_to_first_token_ms,
        )
        event.update(quality_flags)

        # Provider comparison
        tokens_per_second = (output_tokens / (duration_ms / 1000)) if duration_ms > 0 else 0.0
        self._provider_agg.record(
            provider=provider,
            model=model,
            duration_ms=float(duration_ms),
            ttft_ms=time_to_first_token_ms,
            tokens_per_second=tokens_per_second,
            cost_usd=cost_usd,
            has_error=False,
        )

        # Attribution context
        ctx_tags = get_attribution_context()
        attribution = resolve_attribution(None, ctx_tags, None)
        event.update(attribution_tags_to_custom_attributes(attribution))

        return event

    def _on_conversation_end(self, state: Dict[str, Any]) -> None:
        """Flush conversation summary event when a conversation ends or expires."""
        event = conversation_state_to_nr_event(state, self.config.app_name)
        self.record_event(event)

    def record_event(self, event: Dict[str, Any]) -> None:
        """Record an event to be sent to New Relic."""
        if not self.config.enabled or self.event_transport is None:
            return

        with self.buffer_lock:
            self.event_buffer.append(event)
            if len(self.event_buffer) >= 100:
                self._flush_events()

    def record_metric(
        self,
        metric_name: str,
        value: float,
        attributes: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Record a metric to be sent to New Relic."""
        if not self.config.enabled or self.metric_transport is None:
            return

        metric: Dict[str, Any] = {
            "name": metric_name,
            "type": "gauge",
            "value": value,
            "timestamp": int(time.time() * 1000),
        }

        if attributes:
            metric["attributes"] = attributes

        with self.buffer_lock:
            self.metric_buffer.append(metric)
            if len(self.metric_buffer) >= 100:
                self._flush_metrics()

    def _flush_events(self) -> None:
        if not self.event_buffer or self.event_transport is None:
            return
        events = self.event_buffer[:]
        self.event_buffer.clear()
        self.event_transport.send_events(events)

    def _flush_metrics(self) -> None:
        if not self.metric_buffer or self.metric_transport is None:
            return
        metrics = self.metric_buffer[:]
        self.metric_buffer.clear()
        self.metric_transport.send_metrics(metrics)

    def shutdown(self) -> None:
        """Shutdown the agent and flush any pending data."""
        self._conversation_store.shutdown()
        with self.buffer_lock:
            self._flush_events()
            self._flush_metrics()
        logger.info("NR AI Agent shut down")


def wrap_anthropic_client(client: Any) -> Any:
    """Wrap an Anthropic client for observability."""
    agent = init()
    return agent.wrap_anthropic_client(client)


def wrap_gemini_client(client: Any) -> Any:
    """Wrap a Google Genai client for observability."""
    agent = init()
    return agent.wrap_gemini_client(client)
