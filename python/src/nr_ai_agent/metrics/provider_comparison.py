"""Provider/model comparison aggregator — latency, throughput, cost, error rate."""

import math
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

DEFAULT_WINDOW_SIZE = 100


class ProviderComparisonAggregator:
    """Rolling-window aggregator for comparing providers and models."""

    def __init__(self, window_size: int = DEFAULT_WINDOW_SIZE) -> None:
        self._window_size = window_size
        self._data: Dict[str, Dict[str, Any]] = {}

    def record(
        self,
        provider: str,
        model: str,
        duration_ms: float,
        ttft_ms: Optional[float],
        tokens_per_second: float,
        cost_usd: float,
        has_error: bool,
        thinking_tokens: int = 0,
        depth_index: Optional[float] = None,
        category: Optional[str] = None,
    ) -> None:
        key = self._make_key(provider, model, category)
        if key not in self._data:
            self._data[key] = {"data_points": deque(maxlen=self._window_size), "error_count": 0}

        entry = self._data[key]
        data_points: Deque = entry["data_points"]

        # Track error count carefully when window evicts
        if len(data_points) == self._window_size:
            removed = data_points[0]  # oldest will be evicted
            if removed["has_error"]:
                entry["error_count"] -= 1

        point = {
            "duration_ms": duration_ms,
            "ttft_ms": ttft_ms,
            "tokens_per_second": tokens_per_second,
            "cost_usd": cost_usd,
            "has_error": has_error,
            "thinking_tokens": thinking_tokens,
            "depth_index": depth_index,
        }
        data_points.append(point)
        if has_error:
            entry["error_count"] += 1

    def get_metrics(
        self, provider: str, model: str, category: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        key = self._make_key(provider, model, category)
        entry = self._data.get(key)
        if not entry or not entry["data_points"]:
            return None

        data_points = list(entry["data_points"])
        request_count = len(data_points)

        avg_duration_ms = sum(p["duration_ms"] for p in data_points) / request_count

        ttft_points = [p["ttft_ms"] for p in data_points if p["ttft_ms"] is not None]
        avg_ttft_ms = sum(ttft_points) / len(ttft_points) if ttft_points else 0.0

        avg_tokens_per_second = sum(p["tokens_per_second"] for p in data_points) / request_count
        avg_cost_per_request_usd = sum(p["cost_usd"] for p in data_points) / request_count
        error_rate = entry["error_count"] / request_count
        avg_thinking_tokens = sum(p["thinking_tokens"] for p in data_points) / request_count

        sorted_durations = sorted(p["duration_ms"] for p in data_points)
        p95_index = max(0, math.ceil(request_count * 0.95) - 1)
        p95_duration_ms = sorted_durations[p95_index]

        depth_points = [p["depth_index"] for p in data_points if p["depth_index"] is not None]
        avg_depth_index: Optional[float] = None
        if depth_points:
            avg_depth_index = sum(depth_points) / len(depth_points)

        return {
            "provider": provider,
            "model": model,
            "category": category or "all",
            "request_count": request_count,
            "avg_duration_ms": round(avg_duration_ms * 100) / 100,
            "p95_duration_ms": round(p95_duration_ms * 100) / 100,
            "avg_ttft_ms": round(avg_ttft_ms * 100) / 100,
            "avg_tokens_per_second": round(avg_tokens_per_second * 100) / 100,
            "avg_cost_per_request_usd": round(avg_cost_per_request_usd * 1_000_000) / 1_000_000,
            "error_rate": round(error_rate * 10000) / 10000,
            "avg_thinking_tokens": round(avg_thinking_tokens * 100) / 100,
            "avg_depth_index": round(avg_depth_index * 10000) / 10000 if avg_depth_index is not None else None,
        }

    def get_all_metrics(self) -> List[Dict[str, Any]]:
        result = []
        for key in self._data:
            provider, model, category = self._parse_key(key)
            metrics = self.get_metrics(provider, model, category if category != "all" else None)
            if metrics:
                result.append(metrics)
        return result

    def reset(self) -> None:
        self._data.clear()

    def _make_key(self, provider: str, model: str, category: Optional[str]) -> str:
        return f"{provider}:{model}:{category or 'all'}"

    def _parse_key(self, key: str) -> Tuple[str, str, str]:
        parts = key.split(":", 2)
        return parts[0], parts[1], parts[2]


def provider_model_stats_to_nr_event(metrics: Dict[str, Any], app_name: str) -> Dict[str, Any]:
    """Convert provider comparison metrics to AiProviderComparison NR event."""
    event: Dict[str, Any] = {
        "eventType": "AiProviderComparison",
        "nr.appName": app_name,
        "provider": metrics["provider"],
        "model": metrics["model"],
        "category": metrics["category"],
        "requestCount": metrics["request_count"],
        "avgDurationMs": metrics["avg_duration_ms"],
        "p95DurationMs": metrics["p95_duration_ms"],
        "avgTtftMs": metrics["avg_ttft_ms"],
        "avgTokensPerSecond": metrics["avg_tokens_per_second"],
        "avgCostPerRequestUsd": metrics["avg_cost_per_request_usd"],
        "errorRate": metrics["error_rate"],
        "avgThinkingTokens": metrics["avg_thinking_tokens"],
    }
    if metrics.get("avg_depth_index") is not None:
        event["avgDepthIndex"] = metrics["avg_depth_index"]
    return event


def comparison_metrics_to_custom_attributes(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """Convert provider comparison metrics to flat NR custom attribute dict."""
    attrs: Dict[str, Any] = {
        "ai.provider.name": metrics["provider"],
        "ai.provider.model": metrics["model"],
        "ai.provider.category": metrics["category"],
        "ai.provider.request_count": metrics["request_count"],
        "ai.provider.avg_duration_ms": metrics["avg_duration_ms"],
        "ai.provider.p95_duration_ms": metrics["p95_duration_ms"],
        "ai.provider.avg_ttft_ms": metrics["avg_ttft_ms"],
        "ai.provider.avg_tokens_per_second": metrics["avg_tokens_per_second"],
        "ai.provider.avg_cost_per_request_usd": metrics["avg_cost_per_request_usd"],
        "ai.provider.error_rate": metrics["error_rate"],
        "ai.provider.avg_thinking_tokens": metrics["avg_thinking_tokens"],
    }
    if metrics.get("avg_depth_index") is not None:
        attrs["ai.provider.avg_depth_index"] = metrics["avg_depth_index"]
    return attrs
