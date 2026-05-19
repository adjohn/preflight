"""Tests for metrics/reasoning.py"""

import pytest
from nr_ai_agent.metrics.reasoning import extract_reasoning_metrics, reasoning_metrics_to_custom_attributes


class TestExtractReasoningMetrics:
    def test_returns_none_when_no_thinking_tokens(self):
        result = extract_reasoning_metrics(thinking_tokens=0, output_tokens=100)
        assert result is None

    def test_returns_metrics_with_thinking_tokens(self):
        result = extract_reasoning_metrics(thinking_tokens=500, output_tokens=200, total_duration_ms=1000.0)
        assert result is not None
        assert result["thinking_tokens"] == 500

    def test_budget_utilization_clamped_at_1(self):
        result = extract_reasoning_metrics(
            thinking_tokens=1200,
            output_tokens=200,
            thinking_budget_tokens=1000,
            total_duration_ms=1000.0,
        )
        assert result is not None
        assert result["budget_utilization"] == 1.0

    def test_budget_utilization_partial(self):
        result = extract_reasoning_metrics(
            thinking_tokens=500,
            output_tokens=200,
            thinking_budget_tokens=1000,
            total_duration_ms=1000.0,
        )
        assert result is not None
        assert result["budget_utilization"] == pytest.approx(0.5)

    def test_budget_utilization_none_when_no_budget(self):
        result = extract_reasoning_metrics(thinking_tokens=500, output_tokens=200, total_duration_ms=500.0)
        assert result is not None
        assert result["budget_utilization"] is None

    def test_thinking_to_output_ratio(self):
        result = extract_reasoning_metrics(thinking_tokens=400, output_tokens=200, total_duration_ms=500.0)
        assert result is not None
        assert result["thinking_to_output_ratio"] == pytest.approx(2.0)

    def test_thinking_to_output_ratio_none_when_no_output(self):
        result = extract_reasoning_metrics(thinking_tokens=500, output_tokens=0, total_duration_ms=500.0)
        assert result is not None
        assert result["thinking_to_output_ratio"] is None

    def test_depth_index_none_when_no_output(self):
        result = extract_reasoning_metrics(thinking_tokens=500, output_tokens=0, total_duration_ms=500.0)
        assert result is not None
        assert result["depth_index"] is None

    def test_depth_index_between_0_and_1(self):
        result = extract_reasoning_metrics(
            thinking_tokens=500,
            output_tokens=200,
            thinking_budget_tokens=1000,
            thinking_duration_ms=300.0,
            total_duration_ms=500.0,
        )
        assert result is not None
        assert 0.0 <= result["depth_index"] <= 1.0

    def test_thinking_efficiency_calculated(self):
        result = extract_reasoning_metrics(
            thinking_tokens=1000,
            output_tokens=200,
            thinking_duration_ms=500.0,
            total_duration_ms=1000.0,
        )
        assert result is not None
        assert result["thinking_efficiency"] == pytest.approx(2000.0)  # 1000/500ms * 1000

    def test_thinking_efficiency_none_without_duration(self):
        result = extract_reasoning_metrics(thinking_tokens=500, output_tokens=200, total_duration_ms=500.0)
        assert result is not None
        assert result["thinking_efficiency"] is None


class TestReasoningMetricsToCustomAttributes:
    def test_returns_empty_for_none(self):
        assert reasoning_metrics_to_custom_attributes(None) == {}

    def test_always_includes_thinking_tokens(self):
        metrics = extract_reasoning_metrics(thinking_tokens=500, output_tokens=200, total_duration_ms=500.0)
        attrs = reasoning_metrics_to_custom_attributes(metrics)
        assert attrs["ai.reasoning.thinking_tokens"] == 500

    def test_includes_budget_attrs_when_present(self):
        metrics = extract_reasoning_metrics(
            thinking_tokens=500, output_tokens=200, thinking_budget_tokens=1000, total_duration_ms=500.0
        )
        attrs = reasoning_metrics_to_custom_attributes(metrics)
        assert "ai.reasoning.thinking_budget_tokens" in attrs
        assert "ai.reasoning.budget_utilization" in attrs

    def test_excludes_none_fields(self):
        metrics = extract_reasoning_metrics(thinking_tokens=500, output_tokens=200, total_duration_ms=500.0)
        attrs = reasoning_metrics_to_custom_attributes(metrics)
        assert "ai.reasoning.thinking_budget_tokens" not in attrs
        assert "ai.reasoning.thinking_duration_ms" not in attrs
        assert "ai.reasoning.thinking_efficiency" not in attrs

    def test_rounds_floats(self):
        metrics = extract_reasoning_metrics(
            thinking_tokens=1, output_tokens=3, thinking_budget_tokens=10, total_duration_ms=1000.0
        )
        attrs = reasoning_metrics_to_custom_attributes(metrics)
        # Values should be rounded to 3 decimal places
        if "ai.reasoning.thinking_to_output_ratio" in attrs:
            val = attrs["ai.reasoning.thinking_to_output_ratio"]
            assert val == round(val * 1000) / 1000
