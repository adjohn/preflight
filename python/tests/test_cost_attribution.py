"""Tests for metrics/cost_attribution.py"""

import pytest
from nr_ai_agent.metrics.cost_attribution import (
    attribution_tags_to_custom_attributes,
    clear_attribution_context,
    get_attribution_context,
    resolve_attribution,
    set_attribution_context,
    strip_nr_metadata,
)


class TestResolveAttribution:
    def test_empty_inputs_return_empty(self):
        result = resolve_attribution(None, None, None)
        assert result == {}

    def test_global_tags_applied(self):
        result = resolve_attribution(None, None, {"team": "backend", "environment": "prod"})
        assert result["team"] == "backend"
        assert result["environment"] == "prod"

    def test_context_overrides_global(self):
        result = resolve_attribution(None, {"team": "frontend"}, {"team": "backend"})
        assert result["team"] == "frontend"

    def test_request_metadata_overrides_context(self):
        result = resolve_attribution(
            {"nr": {"team": "data"}},
            {"team": "frontend"},
            {"team": "backend"},
        )
        assert result["team"] == "data"

    def test_non_string_metadata_nr_values_ignored(self):
        result = resolve_attribution({"nr": {"team": 42}}, None, None)
        assert "team" not in result

    def test_none_values_excluded(self):
        result = resolve_attribution(None, None, {"team": None})
        assert "team" not in result

    def test_custom_keys_passed_through(self):
        result = resolve_attribution(None, {"custom_key": "custom_val"}, None)
        assert result["custom_key"] == "custom_val"

    def test_metadata_without_nr_key_ignored(self):
        result = resolve_attribution({"other": "data"}, None, {"team": "ops"})
        assert result["team"] == "ops"
        assert "other" not in result


class TestAttributionTagsToCustomAttributes:
    def test_standard_keys_mapped(self):
        tags = {"feature": "search", "team": "platform", "user": "alice", "environment": "staging"}
        attrs = attribution_tags_to_custom_attributes(tags)
        assert attrs["ai.attribution.feature"] == "search"
        assert attrs["ai.attribution.team"] == "platform"
        assert attrs["ai.attribution.user"] == "alice"
        assert attrs["ai.attribution.environment"] == "staging"

    def test_custom_keys_prefixed(self):
        tags = {"project": "apollo"}
        attrs = attribution_tags_to_custom_attributes(tags)
        assert attrs["ai.custom.project"] == "apollo"

    def test_standard_keys_not_duplicated(self):
        tags = {"feature": "x", "custom": "y"}
        attrs = attribution_tags_to_custom_attributes(tags)
        assert "ai.custom.feature" not in attrs

    def test_empty_tags_returns_empty(self):
        assert attribution_tags_to_custom_attributes({}) == {}


class TestContextVar:
    def teardown_method(self):
        clear_attribution_context()

    def test_get_returns_none_by_default(self):
        clear_attribution_context()
        assert get_attribution_context() is None

    def test_set_and_get(self):
        set_attribution_context({"team": "alpha"})
        ctx = get_attribution_context()
        assert ctx == {"team": "alpha"}

    def test_clear_resets_to_none(self):
        set_attribution_context({"team": "alpha"})
        clear_attribution_context()
        assert get_attribution_context() is None

    def test_context_used_in_resolve(self):
        set_attribution_context({"feature": "checkout"})
        ctx = get_attribution_context()
        result = resolve_attribution(None, ctx, None)
        assert result["feature"] == "checkout"


class TestStripNrMetadata:
    def test_removes_nr_key(self):
        meta = {"nr": {"team": "ops"}, "other": "value"}
        result = strip_nr_metadata(meta)
        assert "nr" not in result
        assert result["other"] == "value"  # type: ignore

    def test_no_nr_key_returns_unchanged(self):
        meta = {"foo": "bar"}
        result = strip_nr_metadata(meta)
        assert result == {"foo": "bar"}

    def test_none_returns_none(self):
        assert strip_nr_metadata(None) is None

    def test_non_dict_returned_unchanged(self):
        assert strip_nr_metadata("string") == "string"
