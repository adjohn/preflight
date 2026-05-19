"""Tests for metrics/provider_comparison.py"""

import pytest
from nr_ai_agent.metrics.provider_comparison import (
    ProviderComparisonAggregator,
    comparison_metrics_to_custom_attributes,
    provider_model_stats_to_nr_event,
)


class TestProviderComparisonAggregator:
    def setup_method(self):
        self.agg = ProviderComparisonAggregator(window_size=10)

    def test_returns_none_for_unknown_key(self):
        assert self.agg.get_metrics("openai", "gpt-4o") is None

    def test_record_and_get_metrics(self):
        self.agg.record("anthropic", "claude-sonnet-4", 500.0, 100.0, 50.0, 0.001, False)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        assert m is not None
        assert m["request_count"] == 1
        assert m["avg_duration_ms"] == pytest.approx(500.0)

    def test_avg_duration_calculated(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 50.0, 0.001, False)
        self.agg.record("anthropic", "claude-sonnet-4", 400.0, None, 50.0, 0.001, False)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        assert m["avg_duration_ms"] == pytest.approx(300.0)

    def test_p95_duration(self):
        for i in range(10):
            self.agg.record("anthropic", "claude-sonnet-4", float(i * 100), None, 0.0, 0.0, False)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        # p95 of 0,100,...,900 → index ceil(10*0.95)-1 = 9 → value 900
        assert m["p95_duration_ms"] == pytest.approx(900.0)

    def test_error_rate(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, True)
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, True)
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        assert m["error_rate"] == pytest.approx(2 / 3, abs=1e-4)

    def test_avg_ttft_excludes_none(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, 50.0, 0.0, 0.0, False)
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False)
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, 150.0, 0.0, 0.0, False)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        assert m["avg_ttft_ms"] == pytest.approx(100.0)

    def test_avg_depth_index_calculated(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False, 0, 0.8)
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False, 0, 0.4)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        assert m["avg_depth_index"] == pytest.approx(0.6)

    def test_avg_depth_index_none_when_no_depth(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False)
        m = self.agg.get_metrics("anthropic", "claude-sonnet-4")
        assert m["avg_depth_index"] is None

    def test_window_eviction_corrects_error_count(self):
        agg = ProviderComparisonAggregator(window_size=3)
        agg.record("openai", "gpt-4o", 100.0, None, 0.0, 0.0, True)   # evicted
        agg.record("openai", "gpt-4o", 100.0, None, 0.0, 0.0, False)
        agg.record("openai", "gpt-4o", 100.0, None, 0.0, 0.0, False)
        agg.record("openai", "gpt-4o", 100.0, None, 0.0, 0.0, False)  # evicts first
        m = agg.get_metrics("openai", "gpt-4o")
        assert m["error_rate"] == pytest.approx(0.0)

    def test_get_all_metrics(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False)
        self.agg.record("openai", "gpt-4o", 300.0, None, 0.0, 0.0, False)
        all_m = self.agg.get_all_metrics()
        providers = {m["provider"] for m in all_m}
        assert "anthropic" in providers
        assert "openai" in providers

    def test_category_creates_separate_key(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False, 0, None, "chat")
        self.agg.record("anthropic", "claude-sonnet-4", 300.0, None, 0.0, 0.0, False, 0, None, "search")
        chat_m = self.agg.get_metrics("anthropic", "claude-sonnet-4", "chat")
        search_m = self.agg.get_metrics("anthropic", "claude-sonnet-4", "search")
        assert chat_m["avg_duration_ms"] == pytest.approx(200.0)
        assert search_m["avg_duration_ms"] == pytest.approx(300.0)

    def test_reset_clears(self):
        self.agg.record("anthropic", "claude-sonnet-4", 200.0, None, 0.0, 0.0, False)
        self.agg.reset()
        assert self.agg.get_metrics("anthropic", "claude-sonnet-4") is None


class TestProviderModelStatsToNrEvent:
    def test_event_type_and_app_name(self):
        agg = ProviderComparisonAggregator()
        agg.record("anthropic", "claude-sonnet-4", 200.0, 50.0, 20.0, 0.001, False)
        m = agg.get_metrics("anthropic", "claude-sonnet-4")
        event = provider_model_stats_to_nr_event(m, "my-app")
        assert event["eventType"] == "AiProviderComparison"
        assert event["nr.appName"] == "my-app"

    def test_depth_index_omitted_when_none(self):
        agg = ProviderComparisonAggregator()
        agg.record("openai", "gpt-4o", 200.0, None, 0.0, 0.0, False)
        m = agg.get_metrics("openai", "gpt-4o")
        event = provider_model_stats_to_nr_event(m, "app")
        assert "avgDepthIndex" not in event


class TestComparisonMetricsToCustomAttributes:
    def test_required_fields_present(self):
        agg = ProviderComparisonAggregator()
        agg.record("anthropic", "claude-sonnet-4", 200.0, 50.0, 20.0, 0.001, False, 100, 0.5)
        m = agg.get_metrics("anthropic", "claude-sonnet-4")
        attrs = comparison_metrics_to_custom_attributes(m)
        assert "ai.provider.name" in attrs
        assert "ai.provider.model" in attrs
        assert "ai.provider.avg_duration_ms" in attrs
        assert "ai.provider.avg_depth_index" in attrs
