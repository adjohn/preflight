"""Tests for metrics/quality.py"""

import pytest
from nr_ai_agent.metrics.quality import QualityTracker, quality_metrics_to_custom_attributes


class TestQualityTracker:
    def setup_method(self):
        self.tracker = QualityTracker(window_size=50)

    def test_initial_metrics_defaults(self):
        m = self.tracker.get_metrics()
        assert m["quality_score"] == 1.0
        assert m["max_tokens_hit_rate"] == 0.0
        assert m["error_rate"] == 0.0
        assert m["has_latency_anomaly"] is False
        assert m["has_length_anomaly"] is False
        assert m["avg_feedback_score"] is None
        assert m["avg_edit_distance"] is None

    def test_record_structural_signals_no_error(self):
        flags = self.tracker.record_structural_signals(
            duration_ms=500, output_tokens=100, stop_reason="end_turn", has_error=False
        )
        assert isinstance(flags, dict)

    def test_max_tokens_hit_rate(self):
        for _ in range(4):
            self.tracker.record_structural_signals(200, 100, "max_tokens", False)
        for _ in range(6):
            self.tracker.record_structural_signals(200, 100, "end_turn", False)
        m = self.tracker.get_metrics()
        assert m["max_tokens_hit_rate"] == pytest.approx(0.4)

    def test_error_rate(self):
        for _ in range(3):
            self.tracker.record_structural_signals(200, 0, None, True)
        for _ in range(7):
            self.tracker.record_structural_signals(200, 100, "end_turn", False)
        m = self.tracker.get_metrics()
        assert m["error_rate"] == pytest.approx(0.3)

    def test_quality_score_decreases_with_errors(self):
        for _ in range(10):
            self.tracker.record_structural_signals(200, 100, "end_turn", True)
        m = self.tracker.get_metrics()
        assert m["quality_score"] < 1.0

    def test_quality_score_clamped_0_to_1(self):
        for _ in range(20):
            self.tracker.record_structural_signals(200, 0, "max_tokens", True)
        m = self.tracker.get_metrics()
        assert 0.0 <= m["quality_score"] <= 1.0

    def test_feedback_recorded(self):
        self.tracker.record_feedback("req-1", 0.8)
        self.tracker.record_feedback("req-2", 0.6)
        m = self.tracker.get_metrics()
        assert m["feedback_count"] == 2
        assert m["avg_feedback_score"] == pytest.approx(0.7)

    def test_invalid_feedback_ignored(self):
        self.tracker.record_feedback("req-x", 1.5)
        m = self.tracker.get_metrics()
        assert m["feedback_count"] == 0

    def test_regeneration_counted(self):
        self.tracker.record_structural_signals(200, 100, "end_turn", False)
        self.tracker.record_regeneration("req-1")
        m = self.tracker.get_metrics()
        assert m["regeneration_rate"] > 0

    def test_edit_distance_average(self):
        self.tracker.record_edit_distance("r1", 0.2)
        self.tracker.record_edit_distance("r2", 0.4)
        m = self.tracker.get_metrics()
        assert m["avg_edit_distance"] == pytest.approx(0.3)

    def test_invalid_edit_distance_ignored(self):
        self.tracker.record_edit_distance("r1", -0.1)
        m = self.tracker.get_metrics()
        assert m["avg_edit_distance"] is None

    def test_anomaly_detection_with_enough_data(self):
        # First 19 points: consistent latency
        for _ in range(19):
            self.tracker.record_structural_signals(200, 100, "end_turn", False)
        # 20th point: huge spike — should trigger anomaly
        flags = self.tracker.record_structural_signals(200000, 100, "end_turn", False)
        assert flags.get("ai.quality.latency_anomaly") == 1

    def test_no_anomaly_flags_before_10_data_points(self):
        for _ in range(5):
            flags = self.tracker.record_structural_signals(200, 100, "end_turn", False)
        assert "ai.quality.latency_anomaly" not in flags

    def test_reset_clears_all(self):
        self.tracker.record_structural_signals(500, 200, "end_turn", False)
        self.tracker.record_feedback("r1", 0.9)
        self.tracker.reset()
        m = self.tracker.get_metrics()
        assert m["quality_score"] == 1.0
        assert m["feedback_count"] == 0

    def test_window_size_respected(self):
        tracker = QualityTracker(window_size=5)
        for i in range(10):
            tracker.record_structural_signals(200, 100, "end_turn", False)
        # Only 5 data points should be kept
        m = tracker.get_metrics()
        assert m["max_tokens_hit_rate"] == 0.0


class TestQualityMetricsToCustomAttributes:
    def test_required_fields_present(self):
        tracker = QualityTracker()
        m = tracker.get_metrics()
        attrs = quality_metrics_to_custom_attributes(m)
        assert "ai.quality.score" in attrs
        assert "ai.quality.max_tokens_hit_rate" in attrs
        assert "ai.quality.error_rate" in attrs
        assert "ai.quality.has_latency_anomaly" in attrs
        assert "ai.quality.has_length_anomaly" in attrs

    def test_optional_fields_omitted_when_none(self):
        tracker = QualityTracker()
        m = tracker.get_metrics()
        attrs = quality_metrics_to_custom_attributes(m)
        assert "ai.quality.avg_feedback_score" not in attrs
        assert "ai.quality.avg_edit_distance" not in attrs

    def test_anomaly_flags_are_0_or_1(self):
        tracker = QualityTracker()
        m = tracker.get_metrics()
        attrs = quality_metrics_to_custom_attributes(m)
        assert attrs["ai.quality.has_latency_anomaly"] in (0, 1)
        assert attrs["ai.quality.has_length_anomaly"] in (0, 1)
