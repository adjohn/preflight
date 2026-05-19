import pytest

from nr_ai_agent.errors import classify_error, ErrorInfo


def test_classify_error_basic_exception():
    """Test classifying a basic exception."""
    error = ValueError("Test error message")
    error_info = classify_error(error)

    assert error_info.error_type == "ValueError"
    assert error_info.message == "Test error message"
    assert error_info.status_code is None


def test_classify_error_with_status_code_attribute():
    """Test classifying error with status_code attribute."""
    error = Exception("API Error")
    error.status_code = 429
    error_info = classify_error(error)

    assert error_info.error_type == "Exception"
    assert error_info.status_code == 429


def test_classify_error_with_http_status_attribute():
    """Test classifying error with http_status attribute."""
    error = Exception("API Error")
    error.http_status = 401
    error_info = classify_error(error)

    assert error_info.status_code == 401


def test_classify_error_extracts_status_from_message():
    """Test extracting status code from error message."""
    error = Exception("HTTP 429: Rate limited")
    error_info = classify_error(error)

    assert error_info.status_code == 429


def test_classify_error_401_from_message():
    """Test extracting 401 from message."""
    error = Exception("Unauthorized: 401")
    error_info = classify_error(error)

    assert error_info.status_code == 401


def test_classify_error_500_from_message():
    """Test extracting 500 from message."""
    error = Exception("Server error 500")
    error_info = classify_error(error)

    assert error_info.status_code == 500


def test_classify_error_truncates_long_message():
    """Test that long messages are truncated."""
    long_message = "x" * 2000
    error = Exception(long_message)
    error_info = classify_error(error)

    assert len(error_info.message) == 1024
    assert error_info.message == "x" * 1024


def test_classify_error_runtime_error():
    """Test classifying RuntimeError."""
    error = RuntimeError("Runtime error occurred")
    error_info = classify_error(error)

    assert error_info.error_type == "RuntimeError"
    assert error_info.message == "Runtime error occurred"


def test_error_info_dataclass():
    """Test ErrorInfo dataclass."""
    error_info = ErrorInfo(
        error_type="ValueError",
        message="Test error",
        status_code=400,
    )

    assert error_info.error_type == "ValueError"
    assert error_info.message == "Test error"
    assert error_info.status_code == 400
