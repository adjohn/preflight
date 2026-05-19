from dataclasses import dataclass
from typing import Optional


@dataclass
class ErrorInfo:
    """Error information for a request."""
    error_type: str
    message: str
    status_code: Optional[int] = None


def classify_error(error: Exception) -> ErrorInfo:
    """Classify an error and extract relevant information."""
    error_message = str(error)
    error_type = type(error).__name__

    # Extract status code if available
    status_code = None
    if hasattr(error, "status_code"):
        status_code = error.status_code
    elif hasattr(error, "http_status"):
        status_code = error.http_status
    elif "429" in error_message:
        status_code = 429
    elif "401" in error_message or "403" in error_message:
        status_code = 401
    elif "404" in error_message:
        status_code = 404
    elif "500" in error_message:
        status_code = 500

    return ErrorInfo(
        error_type=error_type,
        message=error_message[:1024],  # Truncate to 1024 chars
        status_code=status_code,
    )
