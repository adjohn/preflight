"""Rolling-window quality signal tracking — anomaly detection, feedback, regen rate."""

import logging
import math
from collections import deque
from typing import Any, Deque, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_WINDOW_SIZE = 100
DEFAULT_ERROR_RATE_THRESHOLD = 0.05
ANOMALY_THRESHOLD_STDDEV = 2.0


class QualityTracker:
    """Rolling-window quality signal tracker."""

    def __init__(
        self,
        window_size: int = DEFAULT_WINDOW_SIZE,
        error_rate_threshold: float = DEFAULT_ERROR_RATE_THRESHOLD,
    ) -> None:
        self._window_size = window_size
        self._error_rate_threshold = error_rate_threshold
        self._data_window: Deque[Dict[str, Any]] = deque(maxlen=window_size)
        self._feedback: Dict[str, Dict[str, Any]] = {}
        self._regeneration_count = 0
        self._edit_distance_values: Deque[float] = deque(maxlen=window_size)

    def record_structural_signals(
        self,
        duration_ms: float,
        output_tokens: int,
        stop_reason: Optional[str],
        has_error: bool,
        time_to_first_token_ms: Optional[float] = None,
        depth_index: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Record a response and return per-response anomaly flags."""
        point: Dict[str, Any] = {
            "duration_ms": duration_ms,
            "time_to_first_token_ms": time_to_first_token_ms,
            "output_tokens": output_tokens,
            "stop_reason": stop_reason,
            "has_error": has_error,
            "depth_index": depth_index,
        }
        self._data_window.append(point)

        flags: Dict[str, Any] = {}

        if len(self._data_window) >= 10:
            is_len_anomaly, len_mean, len_stddev = self._detect_length_anomaly()
            flags["ai.quality.length_anomaly"] = 1 if is_len_anomaly else 0
            flags["ai.quality.avg_response_length"] = round(len_mean * 100) / 100
            if len_stddev is not None:
                flags["ai.quality.response_length_stddev"] = round(len_stddev * 100) / 100

            is_lat_anomaly, lat_mean, lat_stddev = self._detect_latency_anomaly()
            flags["ai.quality.latency_anomaly"] = 1 if is_lat_anomaly else 0
            flags["ai.quality.avg_latency_ms"] = round(lat_mean * 100) / 100
            if lat_stddev is not None:
                flags["ai.quality.latency_stddev"] = round(lat_stddev * 100) / 100

        flags["ai.quality.max_tokens_hit_rate"] = round(self._calculate_max_tokens_hit_rate() * 10000) / 10000
        flags["ai.quality.error_rate"] = round(self._calculate_error_rate() * 10000) / 10000

        return flags

    def record_feedback(self, request_id: str, score: float, metadata: Optional[Dict[str, str]] = None) -> None:
        if score < 0 or score > 1:
            logger.warning("Invalid feedback score (must be 0-1)", extra={"request_id": request_id, "score": score})
            return
        self._feedback[request_id] = {"score": score, "metadata": metadata}

    def record_regeneration(self, _request_id: str) -> None:
        self._regeneration_count += 1

    def record_edit_distance(self, request_id: str, edit_distance: float) -> None:
        if edit_distance < 0 or edit_distance > 1:
            logger.warning("Invalid edit distance (must be 0-1)", extra={"request_id": request_id})
            return
        self._edit_distance_values.append(edit_distance)

    def get_metrics(self) -> Dict[str, Any]:
        max_tokens_hit_rate = self._calculate_max_tokens_hit_rate()
        error_rate = self._calculate_error_rate()
        has_latency_anomaly, _, _ = self._detect_latency_anomaly()
        has_length_anomaly, avg_response_length, _ = self._detect_length_anomaly()

        avg_feedback_score: Optional[float] = None
        if self._feedback:
            total = sum(v["score"] for v in self._feedback.values())
            avg_feedback_score = total / len(self._feedback)

        avg_edit_distance: Optional[float] = None
        if self._edit_distance_values:
            avg_edit_distance = sum(self._edit_distance_values) / len(self._edit_distance_values)

        regeneration_rate = (
            self._regeneration_count / len(self._data_window)
            if self._data_window
            else 0.0
        )

        quality_score = 1.0
        quality_score -= max_tokens_hit_rate * 0.3
        quality_score -= error_rate * 0.3
        if has_latency_anomaly:
            quality_score -= 0.2
        if has_length_anomaly:
            quality_score -= 0.2
        if avg_feedback_score is not None:
            quality_score += (avg_feedback_score - 0.5) * 0.2
        if regeneration_rate > 0:
            quality_score -= regeneration_rate * 0.1
        quality_score = max(0.0, min(1.0, quality_score))

        avg_latency_ms = (
            sum(p["duration_ms"] for p in self._data_window) / len(self._data_window)
            if self._data_window
            else 0.0
        )

        return {
            "quality_score": round(quality_score * 10000) / 10000,
            "max_tokens_hit_rate": round(max_tokens_hit_rate * 10000) / 10000,
            "error_rate": round(error_rate * 10000) / 10000,
            "has_latency_anomaly": has_latency_anomaly,
            "has_length_anomaly": has_length_anomaly,
            "avg_response_length": round(avg_response_length * 100) / 100,
            "avg_latency_ms": round(avg_latency_ms * 100) / 100,
            "feedback_count": len(self._feedback),
            "avg_feedback_score": round(avg_feedback_score * 10000) / 10000 if avg_feedback_score is not None else None,
            "regeneration_rate": round(regeneration_rate * 10000) / 10000,
            "avg_edit_distance": round(avg_edit_distance * 10000) / 10000 if avg_edit_distance is not None else None,
        }

    def reset(self) -> None:
        self._data_window.clear()
        self._feedback.clear()
        self._regeneration_count = 0
        self._edit_distance_values.clear()

    def _calculate_max_tokens_hit_rate(self) -> float:
        if not self._data_window:
            return 0.0
        count = sum(1 for p in self._data_window if p["stop_reason"] == "max_tokens")
        return count / len(self._data_window)

    def _calculate_error_rate(self) -> float:
        if not self._data_window:
            return 0.0
        count = sum(1 for p in self._data_window if p["has_error"])
        return count / len(self._data_window)

    def _detect_length_anomaly(self):
        if len(self._data_window) < 2:
            return False, 0.0, None
        lengths = [p["output_tokens"] for p in self._data_window]
        mean = sum(lengths) / len(lengths)
        variance = sum((v - mean) ** 2 for v in lengths) / len(lengths)
        std_dev = math.sqrt(variance)
        last = lengths[-1]
        is_anomaly = std_dev > 0 and abs(last - mean) > ANOMALY_THRESHOLD_STDDEV * std_dev
        return is_anomaly, mean, std_dev

    def _detect_latency_anomaly(self):
        if len(self._data_window) < 2:
            return False, 0.0, None
        latencies = [p["duration_ms"] for p in self._data_window]
        mean = sum(latencies) / len(latencies)
        variance = sum((v - mean) ** 2 for v in latencies) / len(latencies)
        std_dev = math.sqrt(variance)
        last = latencies[-1]
        is_anomaly = std_dev > 0 and abs(last - mean) > ANOMALY_THRESHOLD_STDDEV * std_dev
        return is_anomaly, mean, std_dev


def quality_metrics_to_custom_attributes(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """Convert quality metrics to flat NR custom attribute dict."""
    attrs: Dict[str, Any] = {
        "ai.quality.score": metrics["quality_score"],
        "ai.quality.max_tokens_hit_rate": metrics["max_tokens_hit_rate"],
        "ai.quality.error_rate": metrics["error_rate"],
        "ai.quality.has_latency_anomaly": 1 if metrics["has_latency_anomaly"] else 0,
        "ai.quality.has_length_anomaly": 1 if metrics["has_length_anomaly"] else 0,
        "ai.quality.avg_response_length": metrics["avg_response_length"],
        "ai.quality.avg_latency_ms": metrics["avg_latency_ms"],
        "ai.quality.feedback_count": metrics["feedback_count"],
        "ai.quality.regeneration_rate": metrics["regeneration_rate"],
    }

    if metrics.get("avg_feedback_score") is not None:
        attrs["ai.quality.avg_feedback_score"] = metrics["avg_feedback_score"]
    if metrics.get("avg_edit_distance") is not None:
        attrs["ai.quality.avg_edit_distance"] = metrics["avg_edit_distance"]

    return attrs
