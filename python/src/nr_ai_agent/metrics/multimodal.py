"""Multi-modal input detection — images, PDFs, audio, video in messages."""

import base64
import logging
import math
import struct
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _get_image_dimensions_from_base64(b64_data: str) -> Optional[tuple]:
    """Return (width, height) from base64 image data, or None if unknown."""
    try:
        raw = base64.b64decode(b64_data, validate=False)

        # PNG: magic bytes + IHDR chunk at offset 8 — width/height at bytes 16-24
        if b64_data.startswith("iVBORw0KGgo") and len(raw) >= 24:
            (width,) = struct.unpack_from(">I", raw, 16)
            (height,) = struct.unpack_from(">I", raw, 20)
            return (width, height)

        # JPEG / WebP: rough estimate from file size
        if b64_data.startswith("/9j/") or b64_data.startswith("UklGR"):
            estimated_pixels = math.sqrt((len(raw) * 8) / 24)
            side = round(estimated_pixels)
            return (side, side)

        return None
    except Exception:
        return None


def _estimate_image_tokens(width: int, height: int) -> int:
    return math.ceil((width * height) / 750)


def _get_image_token_estimate(image_data: Dict[str, Any]) -> int:
    width = image_data.get("width")
    height = image_data.get("height")
    if isinstance(width, (int, float)) and isinstance(height, (int, float)):
        return _estimate_image_tokens(int(width), int(height))

    b64_data: Optional[str] = image_data.get("base64")
    source = image_data.get("source")
    if not b64_data and isinstance(source, dict) and source.get("type") == "base64":
        b64_data = source.get("data")

    if b64_data and isinstance(b64_data, str):
        dims = _get_image_dimensions_from_base64(b64_data)
        if dims:
            return _estimate_image_tokens(dims[0], dims[1])
        binary_size = (len(b64_data) * 3) / 4
        estimated_pixels = binary_size / 4
        estimated_dim = math.sqrt(estimated_pixels)
        return _estimate_image_tokens(round(estimated_dim), round(estimated_dim))

    logger.warning("Unable to determine image dimensions, using default estimate")
    return 512


def _parse_pdf_page_count(metadata: Optional[Dict[str, Any]]) -> int:
    if metadata and isinstance(metadata.get("pages"), (int, float)):
        return int(metadata["pages"])
    return 1


def _parse_audio_seconds(metadata: Optional[Dict[str, Any]]) -> float:
    if metadata:
        if isinstance(metadata.get("duration_seconds"), (int, float)):
            return float(metadata["duration_seconds"])
        if isinstance(metadata.get("duration"), (int, float)):
            return float(metadata["duration"])
    return 0.0


def detect_modalities(messages: List[Any]) -> Dict[str, Any]:
    """Detect input modalities from a message list (Anthropic or Gemini format)."""
    modalities: set = set()
    image_count = 0
    image_token_estimate = 0
    pdf_count = 0
    pdf_page_count = 0
    audio_seconds = 0.0
    video_seconds = 0.0
    text_tokens = 0

    if not isinstance(messages, list):
        modalities.add("text")
        return _build_result(modalities, image_count, image_token_estimate, pdf_count,
                              pdf_page_count, audio_seconds, video_seconds, text_tokens)

    for message in messages:
        if not message or not isinstance(message, dict):
            continue

        # Anthropic-style: content is a list of blocks
        if isinstance(message.get("content"), list):
            for block in message["content"]:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    modalities.add("text")
                    text_tokens += math.ceil(len(block["text"]) / 4)
                elif block.get("type") == "image":
                    modalities.add("image")
                    image_count += 1
                    image_token_estimate += _get_image_token_estimate(block)
                elif block.get("type") == "document":
                    modalities.add("pdf")
                    pdf_count += 1
                    pdf_page_count += _parse_pdf_page_count(block.get("metadata"))

        # Gemini-style: parts array
        if isinstance(message.get("parts"), list):
            for part in message["parts"]:
                if not isinstance(part, dict):
                    continue
                if isinstance(part.get("text"), str):
                    modalities.add("text")
                    text_tokens += math.ceil(len(part["text"]) / 4)

                inline_data = part.get("inlineData")
                if isinstance(inline_data, dict):
                    mime_type = inline_data.get("mimeType", "")
                    if mime_type.startswith("image/"):
                        modalities.add("image")
                        image_count += 1
                        data = inline_data.get("data")
                        if isinstance(data, str):
                            image_token_estimate += _get_image_token_estimate({"base64": data})
                        else:
                            image_token_estimate += 512
                    elif mime_type.startswith("audio/"):
                        modalities.add("audio")
                        audio_seconds += _parse_audio_seconds(inline_data)
                    elif mime_type.startswith("video/"):
                        modalities.add("video")
                        video_seconds += _parse_audio_seconds(inline_data)

                file_data = part.get("fileData")
                if isinstance(file_data, dict):
                    mime_type = file_data.get("mimeType", "")
                    if mime_type.startswith("image/"):
                        modalities.add("image")
                        image_count += 1
                        image_token_estimate += 512
                    elif mime_type.startswith("application/pdf"):
                        modalities.add("pdf")
                        pdf_count += 1
                        pdf_page_count += _parse_pdf_page_count(file_data)
                    elif mime_type.startswith("audio/"):
                        modalities.add("audio")
                        audio_seconds += _parse_audio_seconds(file_data)
                    elif mime_type.startswith("video/"):
                        modalities.add("video")
                        video_seconds += _parse_audio_seconds(file_data)

    if not modalities:
        modalities.add("text")

    return _build_result(modalities, image_count, image_token_estimate, pdf_count,
                          pdf_page_count, audio_seconds, video_seconds, text_tokens)


def _build_result(
    modalities: set,
    image_count: int,
    image_token_estimate: int,
    pdf_count: int,
    pdf_page_count: int,
    audio_seconds: float,
    video_seconds: float,
    text_tokens: int,
) -> Dict[str, Any]:
    return {
        "input_modalities": sorted(modalities),
        "image_count": image_count,
        "image_token_estimate": image_token_estimate,
        "pdf_count": pdf_count,
        "pdf_page_count": pdf_page_count,
        "audio_seconds": audio_seconds,
        "video_seconds": video_seconds,
        "text_tokens": text_tokens,
    }


def modality_metrics_to_custom_attributes(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """Convert modality metrics to flat NR custom attribute dict."""
    return {
        "ai.input.modalities": ",".join(metrics["input_modalities"]),
        "ai.input.image_count": metrics["image_count"],
        "ai.input.image_token_estimate": metrics["image_token_estimate"],
        "ai.input.pdf_count": metrics["pdf_count"],
        "ai.input.pdf_page_count": metrics["pdf_page_count"],
        "ai.input.audio_seconds": round(metrics["audio_seconds"] * 100) / 100,
        "ai.input.video_seconds": round(metrics["video_seconds"] * 100) / 100,
        "ai.input.text_tokens": metrics["text_tokens"],
    }
