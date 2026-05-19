import time
from dataclasses import dataclass
from typing import Optional


@dataclass
class RequestTiming:
    """Timing information for a request."""
    start_time_ms: float
    first_token_time_ms: Optional[float] = None
    end_time_ms: Optional[float] = None

    @property
    def duration_ms(self) -> float:
        """Total duration in milliseconds."""
        if self.end_time_ms is None:
            return (time.perf_counter() * 1000) - self.start_time_ms
        return self.end_time_ms - self.start_time_ms

    @property
    def time_to_first_token_ms(self) -> Optional[float]:
        """Time to first token in milliseconds."""
        if self.first_token_time_ms is None:
            return None
        return self.first_token_time_ms - self.start_time_ms


class RequestTimer:
    """Timer for measuring request latency."""

    def __init__(self):
        """Initialize the timer."""
        self.start_time_ms = time.perf_counter() * 1000
        self.first_token_time_ms: Optional[float] = None
        self.end_time_ms: Optional[float] = None

    def mark_first_token(self) -> None:
        """Mark the time when first token was received."""
        if self.first_token_time_ms is None:
            self.first_token_time_ms = time.perf_counter() * 1000

    def end(self) -> None:
        """Mark the end of the request."""
        self.end_time_ms = time.perf_counter() * 1000

    @property
    def duration_ms(self) -> float:
        """Total duration in milliseconds."""
        if self.end_time_ms is None:
            return (time.perf_counter() * 1000) - self.start_time_ms
        return self.end_time_ms - self.start_time_ms

    @property
    def time_to_first_token_ms(self) -> Optional[float]:
        """Time to first token in milliseconds."""
        if self.first_token_time_ms is None:
            return None
        return self.first_token_time_ms - self.start_time_ms

    def get_timing(self) -> RequestTiming:
        """Get the timing information."""
        return RequestTiming(
            start_time_ms=self.start_time_ms,
            first_token_time_ms=self.first_token_time_ms,
            end_time_ms=self.end_time_ms,
        )
