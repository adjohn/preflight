import time

from nr_ai_agent.timing import RequestTiming, RequestTimer


def test_request_timing_duration_with_end_time():
    """Test duration calculation with end time."""
    timing = RequestTiming(
        start_time_ms=1000.0,
        end_time_ms=1500.0,
    )
    assert timing.duration_ms == 500.0


def test_request_timing_duration_without_end_time():
    """Test duration calculation without end time (uses current time)."""
    timing = RequestTiming(
        start_time_ms=time.perf_counter() * 1000 - 100,
    )
    duration = timing.duration_ms
    assert duration >= 100
    assert duration < 1000  # Should be less than 1 second


def test_request_timing_ttft():
    """Test time to first token calculation."""
    timing = RequestTiming(
        start_time_ms=1000.0,
        first_token_time_ms=1050.0,
    )
    assert timing.time_to_first_token_ms == 50.0


def test_request_timing_ttft_none():
    """Test time to first token is None when not set."""
    timing = RequestTiming(
        start_time_ms=1000.0,
    )
    assert timing.time_to_first_token_ms is None


def test_request_timer_initialization():
    """Test RequestTimer initialization."""
    timer = RequestTimer()
    assert timer.start_time_ms > 0
    assert timer.first_token_time_ms is None
    assert timer.end_time_ms is None


def test_request_timer_duration():
    """Test RequestTimer duration measurement."""
    timer = RequestTimer()
    time.sleep(0.1)  # Sleep for 100ms
    duration = timer.duration_ms
    assert duration >= 100
    assert duration < 500  # Should be less than 500ms


def test_request_timer_mark_first_token():
    """Test marking first token time."""
    timer = RequestTimer()
    time.sleep(0.05)  # Sleep for 50ms
    timer.mark_first_token()
    ttft = timer.time_to_first_token_ms
    assert ttft >= 50
    assert ttft < 200


def test_request_timer_mark_first_token_only_once():
    """Test that first token time is only set once."""
    timer = RequestTimer()
    timer.mark_first_token()
    first_time = timer.first_token_time_ms
    time.sleep(0.05)
    timer.mark_first_token()  # Call again
    # Should be the same
    assert timer.first_token_time_ms == first_time


def test_request_timer_end():
    """Test ending the timer."""
    timer = RequestTimer()
    time.sleep(0.05)
    timer.end()
    assert timer.end_time_ms is not None
    duration = timer.duration_ms
    assert duration >= 50
    assert duration < 200


def test_request_timer_get_timing():
    """Test getting timing information."""
    timer = RequestTimer()
    time.sleep(0.05)
    timer.mark_first_token()
    time.sleep(0.05)
    timer.end()

    timing = timer.get_timing()
    assert timing.start_time_ms > 0
    assert timing.first_token_time_ms is not None
    assert timing.end_time_ms is not None
    assert timing.duration_ms >= 100
