"""Reasoning/thinking token metrics for extended thinking models."""

from typing import Optional


def _normalize(value: float, min_val: float = 0.0, max_val: float = 1.0) -> float:
    if value <= min_val:
        return 0.0
    if value >= max_val:
        return 1.0
    return (value - min_val) / (max_val - min_val)


def _calculate_depth_index(
    thinking_tokens: int,
    output_tokens: int,
    thinking_budget_tokens: Optional[int],
    thinking_duration_ms: Optional[float],
    total_duration_ms: float,
) -> Optional[float]:
    if thinking_tokens == 0 or output_tokens == 0:
        return None

    token_ratio = thinking_tokens / output_tokens
    time_ratio = (thinking_duration_ms / total_duration_ms) if thinking_duration_ms and total_duration_ms > 0 else 0.0
    budget_util = (thinking_tokens / thinking_budget_tokens) if thinking_budget_tokens else 0.0

    normalized_token_ratio = _normalize(token_ratio, 0.0, 5.0)
    normalized_time_ratio = _normalize(time_ratio, 0.0, 0.8)
    normalized_budget_util = min(budget_util, 1.0)

    depth_score = (
        normalized_token_ratio * 0.4
        + normalized_time_ratio * 0.3
        + normalized_budget_util * 0.3
    )
    return max(0.0, min(depth_score, 1.0))


def extract_reasoning_metrics(
    thinking_tokens: int,
    output_tokens: int,
    thinking_budget_tokens: Optional[int] = None,
    thinking_duration_ms: Optional[float] = None,
    total_duration_ms: float = 0.0,
) -> Optional[dict]:
    """Return reasoning metrics dict or None if no thinking tokens used."""
    if thinking_tokens == 0:
        return None

    budget_utilization = (
        min(thinking_tokens / thinking_budget_tokens, 1.0)
        if thinking_budget_tokens
        else None
    )
    thinking_to_output_ratio = (thinking_tokens / output_tokens) if output_tokens > 0 else None
    depth_index = _calculate_depth_index(
        thinking_tokens, output_tokens, thinking_budget_tokens, thinking_duration_ms, total_duration_ms
    )
    thinking_efficiency = (
        (thinking_tokens / thinking_duration_ms) * 1000
        if thinking_duration_ms is not None and thinking_duration_ms > 0
        else None
    )

    return {
        "thinking_tokens": thinking_tokens,
        "thinking_budget_tokens": thinking_budget_tokens,
        "budget_utilization": budget_utilization,
        "thinking_to_output_ratio": thinking_to_output_ratio,
        "depth_index": depth_index,
        "thinking_duration_ms": thinking_duration_ms,
        "thinking_efficiency": thinking_efficiency,
    }


def reasoning_metrics_to_custom_attributes(metrics: Optional[dict]) -> dict:
    """Convert reasoning metrics to flat NR custom attribute dict."""
    if not metrics:
        return {}

    attrs: dict = {"ai.reasoning.thinking_tokens": metrics["thinking_tokens"]}

    if metrics.get("thinking_budget_tokens") is not None:
        attrs["ai.reasoning.thinking_budget_tokens"] = metrics["thinking_budget_tokens"]

    if metrics.get("budget_utilization") is not None:
        attrs["ai.reasoning.budget_utilization"] = round(metrics["budget_utilization"] * 1000) / 1000

    if metrics.get("thinking_to_output_ratio") is not None:
        attrs["ai.reasoning.thinking_to_output_ratio"] = round(metrics["thinking_to_output_ratio"] * 1000) / 1000

    if metrics.get("depth_index") is not None:
        attrs["ai.reasoning.depth_index"] = round(metrics["depth_index"] * 1000) / 1000

    if metrics.get("thinking_duration_ms") is not None:
        attrs["ai.reasoning.thinking_duration_ms"] = metrics["thinking_duration_ms"]

    if metrics.get("thinking_efficiency") is not None:
        attrs["ai.reasoning.thinking_efficiency"] = round(metrics["thinking_efficiency"] * 100) / 100

    return attrs
