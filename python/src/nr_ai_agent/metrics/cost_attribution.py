"""Cost attribution via context variable propagation and per-request metadata."""

from contextvars import ContextVar
from typing import Any, Dict, Optional

_attribution_context: ContextVar[Optional[Dict[str, str]]] = ContextVar(
    "nr_attribution_context", default=None
)


def set_attribution_context(tags: Dict[str, str]) -> None:
    """Set attribution tags for the current context (thread/async task)."""
    _attribution_context.set(tags)


def get_attribution_context() -> Optional[Dict[str, str]]:
    """Get attribution tags for the current context."""
    return _attribution_context.get()


def clear_attribution_context() -> None:
    """Clear attribution tags for the current context."""
    _attribution_context.set(None)


def resolve_attribution(
    request_metadata: Optional[Dict[str, Any]],
    context_tags: Optional[Dict[str, str]],
    global_tags: Optional[Dict[str, str]],
) -> Dict[str, str]:
    """Merge attribution tags: per-request > context > global."""
    merged: Dict[str, str] = {}

    # Apply global defaults first
    if global_tags:
        for key, value in global_tags.items():
            if value is not None:
                merged[key] = value

    # Apply context tags (override globals)
    if context_tags:
        for key, value in context_tags.items():
            if value is not None:
                merged[key] = value

    # Extract per-request tags from metadata.nr.*
    if request_metadata and isinstance(request_metadata, dict):
        nr = request_metadata.get("nr")
        if nr and isinstance(nr, dict):
            for key, value in nr.items():
                if isinstance(value, str):
                    merged[key] = value

    return merged


def attribution_tags_to_custom_attributes(tags: Dict[str, str]) -> Dict[str, Any]:
    """Convert attribution tags to flat NR custom attribute dict."""
    attrs: Dict[str, Any] = {}

    if tags.get("feature"):
        attrs["ai.attribution.feature"] = tags["feature"]
    if tags.get("team"):
        attrs["ai.attribution.team"] = tags["team"]
    if tags.get("user"):
        attrs["ai.attribution.user"] = tags["user"]
    if tags.get("environment"):
        attrs["ai.attribution.environment"] = tags["environment"]

    standard_keys = {"feature", "team", "user", "environment"}
    for key, value in tags.items():
        if key not in standard_keys and value is not None:
            attrs[f"ai.custom.{key}"] = value

    return attrs


def strip_nr_metadata(metadata: Any) -> Any:
    """Remove nr.* metadata from a request metadata dict."""
    if not metadata or not isinstance(metadata, dict):
        return metadata
    if "nr" in metadata:
        return {k: v for k, v in metadata.items() if k != "nr"}
    return metadata
