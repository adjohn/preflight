"""Conversation lifecycle tracking — turn counts, context pressure, cost accumulation."""

import hashlib
import json
import logging
import math
import threading
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_TTL_S = 3600  # 1 hour
DEFAULT_CONTEXT_LIMIT = 200_000

_MODEL_CONTEXT_LIMITS: Dict[str, int] = {
    "claude-opus-4": 200_000,
    "claude-opus-4-20250805": 200_000,
    "claude-opus-4-7": 200_000,
    "claude-sonnet-4": 200_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-sonnet-4-6": 200_000,
    "claude-haiku-4": 100_000,
    "claude-haiku-4-5-20251001": 100_000,
    "gpt-4": 128_000,
    "gpt-4-turbo": 128_000,
    "gpt-4o": 128_000,
    "gemini-pro": 32_000,
    "gemini-1.5-pro": 1_000_000,
    "gemini-2-flash": 1_000_000,
}


def generate_conversation_id_from_messages(messages: List[Any]) -> str:
    """SHA-256 of all messages except the last, truncated to 16 hex chars."""
    prior = messages[:-1] if isinstance(messages, list) and len(messages) > 0 else messages
    h = hashlib.sha256(json.dumps(prior, default=str).encode())
    return h.hexdigest()[:16]


def _get_model_context_limit(model: str) -> int:
    if model in _MODEL_CONTEXT_LIMITS:
        return _MODEL_CONTEXT_LIMITS[model]
    for key, limit in _MODEL_CONTEXT_LIMITS.items():
        if model.startswith(key):
            return limit
    return DEFAULT_CONTEXT_LIMIT


class ConversationStore:
    """In-memory store for active conversation states with TTL eviction."""

    def __init__(
        self,
        ttl_s: float = DEFAULT_TTL_S,
        cleanup_interval_s: float = 60.0,
        on_conversation_end: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self._ttl_s = ttl_s
        self._on_end = on_conversation_end
        self._store: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        self._cleanup_interval_s = cleanup_interval_s
        self._schedule_cleanup()

    def _schedule_cleanup(self) -> None:
        self._timer = threading.Timer(self._cleanup_interval_s, self._evict_stale)
        self._timer.daemon = True
        self._timer.start()

    def _evict_stale(self) -> None:
        now = time.time()
        to_evict = []
        with self._lock:
            for conv_id, record in list(self._store.items()):
                if now - record["last_activity"] > self._ttl_s:
                    to_evict.append(conv_id)
            for conv_id in to_evict:
                record = self._store.pop(conv_id, None)
                if record and self._on_end:
                    try:
                        self._on_end(record["state"])
                    except Exception:
                        pass
        self._schedule_cleanup()

    def get_or_create(self, conversation_id: str, _model: str) -> Dict[str, Any]:
        now = time.time()
        with self._lock:
            if conversation_id in self._store:
                return self._store[conversation_id]["state"]
            state: Dict[str, Any] = {
                "conversation_id": conversation_id,
                "turn_count": 0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_thinking_tokens": 0,
                "total_tokens": 0,
                "total_cost_usd": 0.0,
                "context_growth_rate": 0.0,
                "estimated_turns_remaining": None,
                "system_prompt_token_share": None,
                "context_pressure": 0.0,
                "duration_ms": 0,
                "user_wait_time_ms": 0,
                "first_turn_timestamp": now,
                "last_turn_timestamp": now,
            }
            self._store[conversation_id] = {"state": state, "last_activity": now}
            return state

    def record_turn(
        self,
        conversation_id: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        thinking_tokens: int,
        cost_usd: float,
        duration_ms: float,
        system_prompt_tokens: Optional[int],
    ) -> Dict[str, Any]:
        with self._lock:
            if conversation_id not in self._store:
                # Create without holding a nested lock
                pass

        state = self.get_or_create(conversation_id, model)
        now = time.time()
        context_limit = _get_model_context_limit(model)

        turn_count = state["turn_count"] + 1
        total_input = state["total_input_tokens"] + input_tokens
        total_output = state["total_output_tokens"] + output_tokens
        total_thinking = state["total_thinking_tokens"] + thinking_tokens
        total_tokens = total_input + total_output + total_thinking
        total_cost = state["total_cost_usd"] + cost_usd
        user_wait_time = state["user_wait_time_ms"] + duration_ms
        duration_from_first = (now - state["first_turn_timestamp"]) * 1000

        context_growth_rate = total_input / turn_count if turn_count > 0 else 0.0

        estimated_turns_remaining: Optional[int] = None
        if context_growth_rate > 0:
            remaining = max(0, context_limit - total_input)
            estimated_turns_remaining = int(math.ceil(remaining / context_growth_rate))

        system_prompt_token_share: Optional[float] = None
        if system_prompt_tokens is not None and total_input > 0:
            system_prompt_token_share = system_prompt_tokens / total_input

        context_pressure = min(total_input / context_limit, 1.0)

        new_state: Dict[str, Any] = {
            "conversation_id": conversation_id,
            "turn_count": turn_count,
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_thinking_tokens": total_thinking,
            "total_tokens": total_tokens,
            "total_cost_usd": total_cost,
            "context_growth_rate": context_growth_rate,
            "estimated_turns_remaining": estimated_turns_remaining,
            "system_prompt_token_share": system_prompt_token_share,
            "context_pressure": context_pressure,
            "duration_ms": duration_from_first,
            "user_wait_time_ms": user_wait_time,
            "first_turn_timestamp": state["first_turn_timestamp"],
            "last_turn_timestamp": now,
        }

        with self._lock:
            self._store[conversation_id] = {"state": new_state, "last_activity": now}

        return new_state

    def get_state(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            record = self._store.get(conversation_id)
            return record["state"] if record else None

    def end(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            record = self._store.pop(conversation_id, None)
        if record:
            if self._on_end:
                try:
                    self._on_end(record["state"])
                except Exception:
                    pass
            return record["state"]
        return None

    def shutdown(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None
        with self._lock:
            self._store.clear()


def conversation_state_to_custom_attributes(state: Dict[str, Any]) -> Dict[str, Any]:
    """Convert conversation state to flat NR custom attribute dict."""
    attrs: Dict[str, Any] = {
        "ai.conversation.id": state["conversation_id"],
        "ai.conversation.turn_count": state["turn_count"],
        "ai.conversation.total_tokens": state["total_tokens"],
        "ai.conversation.total_input_tokens": state["total_input_tokens"],
        "ai.conversation.total_output_tokens": state["total_output_tokens"],
        "ai.conversation.context_pressure": round(state["context_pressure"] * 1000) / 1000,
        "ai.conversation.context_growth_rate": round(state["context_growth_rate"] * 100) / 100,
        "ai.conversation.duration_ms": state["duration_ms"],
        "ai.conversation.user_wait_time_ms": state["user_wait_time_ms"],
    }

    if state["total_cost_usd"] != 0:
        attrs["ai.conversation.total_cost_usd"] = round(state["total_cost_usd"] * 1_000_000) / 1_000_000

    if state.get("estimated_turns_remaining") is not None:
        attrs["ai.conversation.estimated_turns_remaining"] = state["estimated_turns_remaining"]

    if state.get("system_prompt_token_share") is not None:
        attrs["ai.conversation.system_prompt_token_share"] = round(state["system_prompt_token_share"] * 1000) / 1000

    return attrs


def conversation_state_to_nr_event(state: Dict[str, Any], app_name: str) -> Dict[str, Any]:
    """Convert conversation state to AiConversationSummary NR event."""
    event: Dict[str, Any] = {
        "eventType": "AiConversationSummary",
        "nr.appName": app_name,
        "conversationId": state["conversation_id"],
        "turnCount": state["turn_count"],
        "totalInputTokens": state["total_input_tokens"],
        "totalOutputTokens": state["total_output_tokens"],
        "totalThinkingTokens": state["total_thinking_tokens"],
        "totalTokens": state["total_tokens"],
        "totalCostUsd": round(state["total_cost_usd"] * 1_000_000) / 1_000_000,
        "durationMs": state["duration_ms"],
        "userWaitTimeMs": state["user_wait_time_ms"],
        "contextPressure": round(state["context_pressure"] * 10000) / 10000,
        "contextGrowthRate": round(state["context_growth_rate"] * 100) / 100,
    }

    if state.get("estimated_turns_remaining") is not None:
        event["estimatedTurnsRemaining"] = state["estimated_turns_remaining"]
    if state.get("system_prompt_token_share") is not None:
        event["systemPromptTokenShare"] = round(state["system_prompt_token_share"] * 10000) / 10000

    return event
