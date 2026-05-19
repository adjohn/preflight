"""Cache economics — hit rates, savings, ROI tracking."""

from typing import Any, Dict, Optional

from ..pricing import PRICING_DATA


def _get_pricing(provider: str, model: str) -> Optional[Dict[str, float]]:
    """Find pricing row for a model, with prefix-match fallback."""
    provider_data = PRICING_DATA.get(provider, {})

    # Exact match
    if model in provider_data:
        return provider_data[model]

    # Prefix match
    for model_key, pricing in provider_data.items():
        if model.startswith(model_key):
            return pricing

    # Cross-provider: try all providers
    for pdata in PRICING_DATA.values():
        if model in pdata:
            return pdata[model]
        for model_key, pricing in pdata.items():
            if model.startswith(model_key):
                return pricing

    return None


def extract_cache_metrics(
    provider: str,
    model: str,
    cache_read_tokens: int,
    cache_creation_tokens: int,
    cost_tracking_enabled: bool = True,
) -> Dict[str, Any]:
    """Compute per-request cache economics."""
    cache_hit = cache_read_tokens > 0
    cache_savings_usd = 0.0
    cache_creation_cost_usd = 0.0

    if cost_tracking_enabled:
        pricing = _get_pricing(provider, model)
        if pricing:
            input_price_per_token = pricing["input"] / 1_000_000
            cache_read_price_per_token = pricing["cache_read"] / 1_000_000
            cache_creation_price_per_token = pricing["cache_creation"] / 1_000_000

            # Savings = what we would have paid at full input price vs what we actually paid
            cache_savings_usd = cache_read_tokens * (input_price_per_token - cache_read_price_per_token)
            cache_creation_cost_usd = max(0.0, cache_creation_tokens * cache_creation_price_per_token)

    cache_net_savings_usd = cache_savings_usd - cache_creation_cost_usd

    return {
        "cache_hit": cache_hit,
        "cache_read_tokens": cache_read_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "cache_savings_usd": cache_savings_usd,
        "cache_creation_cost_usd": cache_creation_cost_usd,
        "cache_net_savings_usd": cache_net_savings_usd,
    }


class CacheEconomicsTracker:
    """Aggregates cache economics across multiple requests."""

    def __init__(self, cost_tracking_enabled: bool = True) -> None:
        self._cost_tracking_enabled = cost_tracking_enabled
        self._total_requests = 0
        self._cache_hit_count = 0
        self._cumulative_savings_usd = 0.0
        self._cumulative_creation_cost_usd = 0.0

    def record(self, provider: str, model: str, cache_read_tokens: int, cache_creation_tokens: int) -> None:
        metrics = extract_cache_metrics(
            provider, model, cache_read_tokens, cache_creation_tokens, self._cost_tracking_enabled
        )
        self._total_requests += 1
        if metrics["cache_hit"]:
            self._cache_hit_count += 1
        if self._cost_tracking_enabled:
            self._cumulative_savings_usd += metrics["cache_savings_usd"]
            self._cumulative_creation_cost_usd += metrics["cache_creation_cost_usd"]

    def get_aggregates(self) -> Dict[str, Any]:
        cache_hit_rate = (self._cache_hit_count / self._total_requests) if self._total_requests > 0 else 0.0
        cache_roi: Optional[float] = None
        cache_efficiency_score: Optional[float] = None

        if self._cost_tracking_enabled:
            if self._cumulative_creation_cost_usd > 0:
                cache_roi = self._cumulative_savings_usd / self._cumulative_creation_cost_usd
            elif self._cumulative_savings_usd > 0:
                cache_roi = float("inf")

            total_cache_activity = self._cumulative_savings_usd + self._cumulative_creation_cost_usd
            if total_cache_activity > 0:
                cache_efficiency_score = self._cumulative_savings_usd / total_cache_activity
            elif self._total_requests > 0:
                cache_efficiency_score = 0.0

        return {
            "total_requests": self._total_requests,
            "cache_hit_count": self._cache_hit_count,
            "cache_hit_rate": cache_hit_rate,
            "cumulative_savings_usd": self._cumulative_savings_usd,
            "cumulative_creation_cost_usd": self._cumulative_creation_cost_usd,
            "cache_roi": cache_roi,
            "cache_efficiency_score": cache_efficiency_score,
        }

    def reset(self) -> None:
        self._total_requests = 0
        self._cache_hit_count = 0
        self._cumulative_savings_usd = 0.0
        self._cumulative_creation_cost_usd = 0.0


def cache_metrics_to_custom_attributes(metrics: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Convert per-request cache metrics to flat NR custom attribute dict."""
    if not metrics:
        return {}

    attrs: Dict[str, Any] = {
        "ai.cache.hit": 1 if metrics["cache_hit"] else 0,
        "ai.cache.read_tokens": metrics["cache_read_tokens"],
        "ai.cache.creation_tokens": metrics["cache_creation_tokens"],
    }

    if metrics["cache_savings_usd"] != 0:
        attrs["ai.cache.savings_usd"] = round(metrics["cache_savings_usd"] * 1_000_000) / 1_000_000
    if metrics["cache_creation_cost_usd"] != 0:
        attrs["ai.cache.creation_cost_usd"] = round(metrics["cache_creation_cost_usd"] * 1_000_000) / 1_000_000
    if metrics["cache_net_savings_usd"] != 0:
        attrs["ai.cache.net_savings_usd"] = round(metrics["cache_net_savings_usd"] * 1_000_000) / 1_000_000

    return attrs
