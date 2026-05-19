"""Tests for metrics/multimodal.py"""

import pytest
from nr_ai_agent.metrics.multimodal import detect_modalities, modality_metrics_to_custom_attributes


class TestDetectModalities:
    def test_empty_list_returns_text(self):
        m = detect_modalities([])
        assert "text" in m["input_modalities"]

    def test_non_list_returns_text(self):
        m = detect_modalities("not a list")  # type: ignore
        assert "text" in m["input_modalities"]

    def test_anthropic_text_message(self):
        msgs = [{"role": "user", "content": [{"type": "text", "text": "hello world"}]}]
        m = detect_modalities(msgs)
        assert "text" in m["input_modalities"]
        assert m["text_tokens"] > 0

    def test_anthropic_image_message(self):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "fake"}},
                ],
            }
        ]
        m = detect_modalities(msgs)
        assert "image" in m["input_modalities"]
        assert m["image_count"] == 1
        assert m["image_token_estimate"] > 0

    def test_anthropic_document_message(self):
        msgs = [
            {
                "role": "user",
                "content": [{"type": "document", "metadata": {"pages": 5}}],
            }
        ]
        m = detect_modalities(msgs)
        assert "pdf" in m["input_modalities"]
        assert m["pdf_count"] == 1
        assert m["pdf_page_count"] == 5

    def test_gemini_text_part(self):
        msgs = [{"role": "user", "parts": [{"text": "gemini message"}]}]
        m = detect_modalities(msgs)
        assert "text" in m["input_modalities"]

    def test_gemini_image_inline_data(self):
        msgs = [
            {
                "role": "user",
                "parts": [{"inlineData": {"mimeType": "image/png", "data": "iVBORw0KGgoAAAANSUhEUg=="}}],
            }
        ]
        m = detect_modalities(msgs)
        assert "image" in m["input_modalities"]
        assert m["image_count"] == 1

    def test_gemini_audio_inline_data(self):
        msgs = [
            {
                "role": "user",
                "parts": [{"inlineData": {"mimeType": "audio/wav", "duration_seconds": 30.5}}],
            }
        ]
        m = detect_modalities(msgs)
        assert "audio" in m["input_modalities"]
        assert m["audio_seconds"] == pytest.approx(30.5)

    def test_gemini_video_inline_data(self):
        msgs = [
            {
                "role": "user",
                "parts": [{"inlineData": {"mimeType": "video/mp4", "duration": 120.0}}],
            }
        ]
        m = detect_modalities(msgs)
        assert "video" in m["input_modalities"]
        assert m["video_seconds"] == pytest.approx(120.0)

    def test_gemini_file_data_pdf(self):
        msgs = [
            {
                "role": "user",
                "parts": [{"fileData": {"mimeType": "application/pdf", "pages": 3}}],
            }
        ]
        m = detect_modalities(msgs)
        assert "pdf" in m["input_modalities"]
        assert m["pdf_count"] == 1
        assert m["pdf_page_count"] == 3

    def test_multiple_images_counted(self):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "image"},
                ],
            }
        ]
        m = detect_modalities(msgs)
        assert m["image_count"] == 2

    def test_modalities_sorted(self):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": "hi"},
                ],
            }
        ]
        m = detect_modalities(msgs)
        assert m["input_modalities"] == sorted(m["input_modalities"])

    def test_text_tokens_estimated_from_length(self):
        text = "a" * 400
        msgs = [{"role": "user", "content": [{"type": "text", "text": text}]}]
        m = detect_modalities(msgs)
        assert m["text_tokens"] == 100  # 400 chars / 4


class TestModalityMetricsToCustomAttributes:
    def test_all_fields_present(self):
        m = detect_modalities([])
        attrs = modality_metrics_to_custom_attributes(m)
        assert "ai.input.modalities" in attrs
        assert "ai.input.image_count" in attrs
        assert "ai.input.image_token_estimate" in attrs
        assert "ai.input.pdf_count" in attrs
        assert "ai.input.pdf_page_count" in attrs
        assert "ai.input.audio_seconds" in attrs
        assert "ai.input.video_seconds" in attrs
        assert "ai.input.text_tokens" in attrs

    def test_modalities_comma_joined(self):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "hi"},
                    {"type": "image"},
                ],
            }
        ]
        m = detect_modalities(msgs)
        attrs = modality_metrics_to_custom_attributes(m)
        val = attrs["ai.input.modalities"]
        assert isinstance(val, str)
        assert "," in val or len(m["input_modalities"]) == 1
