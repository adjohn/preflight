"""Tests for metrics/cache_economics.py"""

import pytest
from nr_ai_agent.metrics.cache_economics import (
    CacheEconomicsTracker,
    cache_metrics_to_custom_attributes,
    extract_cache_metrics,
)


class TestExtractCacheMetrics:
    def test_no_cache_activity(self):
        result = extract_cache_metrics("anthropic", "claude-sonnet-4", 0, 0)
        assert result["cache_hit"] is False
        assert result["cache_read_tokens"] == 0
        assert result["cache_creation_tokens"] == 0
        assert result["cache_savings_usd"] == 0.0
        assert result["cache_creation_cost_usd"] == 0.0
        assert result["cache_net_savings_usd"] == 0.0

    def test_cache_hit_detected(self):
        result = extract_cache_metrics("anthropic", "claude-sonnet-4", 1000, 0)
        assert result["cache_hit"] is True

    def test_savings_positive_for_known_model(self):
        result = extract_cache_metrics("anthropic", "claude-sonnet-4", 1000, 0)
        assert result["cache_savings_usd"] > 0

    def test_creation_cost_positive(self):
        result = extract_cache_metrics("anthropic", "claude-sonnet-4", 0, 1000)
        assert result["cache_creation_cost_usd"] > 0

    def test_cost_tracking_disabled(self):
        result = extract_cache_metrics("anthropic", "claude-sonnet-4", 1000, 1000, cost_tracking_enabled=False)
        assert result["cache_savings_usd"] == 0.0
        assert result["cache_creation_cost_usd"] == 0.0

    def test_unknown_model_no_crash(self):
        result = extract_cache_metrics("unknown_provider", "unknown_model", 1000, 0)
        assert result["cache_savings_usd"] == 0.0

    def test_net_savings_is_savings_minus_creation(self):
        result = extract_cache_metrics("anthropic", "claude-sonnet-4", 1000, 500)
        expected = result["cache_savings_usd"] - result["cache_creation_cost_usd"]
        assert result["cache_net_savings_usd"] == pytest.approx(expected)


class TestCacheEconomicsTracker:
    def test_initial_state(self):
        tracker = CacheEconomicsTracker()
        agg = tracker.get_aggregates()
        assert agg["total_requests"] == 0
        assert agg["cache_hit_count"] == 0
        assert agg["cache_hit_rate"] == 0.0
        assert agg["cache_roi"] is None

    def test_records_increments(self):
        tracker = CacheEconomicsTracker()
        tracker.record("anthropic", "claude-sonnet-4", 1000, 0)
        agg = tracker.get_aggregates()
        assert agg["total_requests"] == 1
        assert agg["cache_hit_count"] == 1

    def test_hit_rate_calculation(self):
        tracker = CacheEconomicsTracker()
        tracker.record("anthropic", "claude-sonnet-4", 1000, 0)  # hit
        tracker.record("anthropic", "claude-sonnet-4", 0, 0)     # miss
        agg = tracker.get_aggregates()
        assert agg["cache_hit_rate"] == pytest.approx(0.5)

    def test_roi_infinite_when_savings_no_creation(self):
        tracker = CacheEconomicsTracker()
        tracker.record("anthropic", "claude-sonnet-4", 10000, 0)
        agg = tracker.get_aggregates()
        assert agg["cache_roi"] == float("inf")

    def test_roi_calculated_when_both_present(self):
        tracker = CacheEconomicsTracker()
        tracker.record("anthropic", "claude-sonnet-4", 10000, 5000)
        agg = tracker.get_aggregates()
        assert agg["cache_roi"] is not None
        assert agg["cache_roi"] > 0

    def test_reset_clears_state(self):
        tracker = CacheEconomicsTracker()
        tracker.record("anthropic", "claude-sonnet-4", 1000, 500)
        tracker.reset()
        agg = tracker.get_aggregates()
        assert agg["total_requests"] == 0

    def test_efficiency_score_zero_when_no_activity(self):
        tracker = CacheEconomicsTracker()
        tracker.record("anthropic", "claude-sonnet-4", 0, 0)
        agg = tracker.get_aggregates()
        assert agg["cache_efficiency_score"] == 0.0


class TestCacheMetricsToCustomAttributes:
    def test_returns_empty_for_none(self):
        assert cache_metrics_to_custom_attributes(None) == {}

    def test_always_includes_base_fields(self):
        metrics = extract_cache_metrics("anthropic", "claude-sonnet-4", 1000, 0)
        attrs = cache_metrics_to_custom_attributes(metrics)
        assert "ai.cache.hit" in attrs
        assert "ai.cache.read_tokens" in attrs
        assert "ai.cache.creation_tokens" in attrs

    def test_hit_flag_is_1_for_hit(self):
        metrics = extract_cache_metrics("anthropic", "claude-sonnet-4", 500, 0)
        attrs = cache_metrics_to_custom_attributes(metrics)
        assert attrs["ai.cache.hit"] == 1

    def test_hit_flag_is_0_for_miss(self):
        metrics = extract_cache_metrics("anthropic", "claude-sonnet-4", 0, 0)
        attrs = cache_metrics_to_custom_attributes(metrics)
        assert attrs["ai.cache.hit"] == 0

    def test_omits_zero_usd_fields(self):
        metrics = extract_cache_metrics("anthropic", "claude-sonnet-4", 0, 0)
        attrs = cache_metrics_to_custom_attributes(metrics)
        assert "ai.cache.savings_usd" not in attrs
        assert "ai.cache.creation_cost_usd" not in attrs
