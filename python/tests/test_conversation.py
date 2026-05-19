"""Tests for metrics/conversation.py"""

import time

import pytest
from nr_ai_agent.metrics.conversation import (
    ConversationStore,
    conversation_state_to_custom_attributes,
    conversation_state_to_nr_event,
    generate_conversation_id_from_messages,
)


class TestGenerateConversationId:
    def test_returns_16_char_hex(self):
        msgs = [{"role": "user", "content": "hello"}]
        cid = generate_conversation_id_from_messages(msgs)
        assert len(cid) == 16
        int(cid, 16)  # must be valid hex

    def test_same_messages_same_id(self):
        msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        assert generate_conversation_id_from_messages(msgs) == generate_conversation_id_from_messages(msgs)

    def test_different_prior_different_id(self):
        msgs1 = [{"role": "user", "content": "x"}, {"role": "user", "content": "last"}]
        msgs2 = [{"role": "user", "content": "y"}, {"role": "user", "content": "last"}]
        assert generate_conversation_id_from_messages(msgs1) != generate_conversation_id_from_messages(msgs2)

    def test_same_last_message_different_prior_different_id(self):
        msgs_a = [{"role": "user", "content": "first"}, {"role": "assistant", "content": "same"}]
        msgs_b = [{"role": "user", "content": "other"}, {"role": "assistant", "content": "same"}]
        assert generate_conversation_id_from_messages(msgs_a) != generate_conversation_id_from_messages(msgs_b)

    def test_single_message_uses_empty_prior(self):
        msgs = [{"role": "user", "content": "only"}]
        cid = generate_conversation_id_from_messages(msgs)
        assert len(cid) == 16

    def test_empty_list(self):
        cid = generate_conversation_id_from_messages([])
        assert len(cid) == 16


class TestConversationStore:
    def setup_method(self):
        # Long TTL, long cleanup interval — tests control eviction manually
        self.store = ConversationStore(ttl_s=3600, cleanup_interval_s=3600)

    def teardown_method(self):
        self.store.shutdown()

    def test_get_or_create_returns_initial_state(self):
        state = self.store.get_or_create("conv-1", "claude-sonnet-4")
        assert state["conversation_id"] == "conv-1"
        assert state["turn_count"] == 0
        assert state["total_input_tokens"] == 0

    def test_get_or_create_idempotent(self):
        s1 = self.store.get_or_create("conv-1", "claude-sonnet-4")
        s2 = self.store.get_or_create("conv-1", "claude-sonnet-4")
        assert s1 == s2

    def test_record_turn_increments_counts(self):
        self.store.get_or_create("conv-1", "claude-sonnet-4")
        state = self.store.record_turn("conv-1", "claude-sonnet-4", 100, 50, 0, 0.01, 500, None)
        assert state["turn_count"] == 1
        assert state["total_input_tokens"] == 100
        assert state["total_output_tokens"] == 50

    def test_record_turn_accumulates(self):
        self.store.get_or_create("conv-2", "claude-sonnet-4")
        self.store.record_turn("conv-2", "claude-sonnet-4", 100, 50, 0, 0.01, 500, None)
        state = self.store.record_turn("conv-2", "claude-sonnet-4", 200, 100, 0, 0.02, 400, None)
        assert state["turn_count"] == 2
        assert state["total_input_tokens"] == 300

    def test_context_pressure_increases(self):
        self.store.get_or_create("conv-3", "claude-sonnet-4")
        state = self.store.record_turn("conv-3", "claude-sonnet-4", 100_000, 50, 0, 0.0, 500, None)
        assert state["context_pressure"] > 0

    def test_context_pressure_capped_at_1(self):
        self.store.get_or_create("conv-4", "claude-sonnet-4")
        state = self.store.record_turn("conv-4", "claude-sonnet-4", 300_000, 0, 0, 0.0, 100, None)
        assert state["context_pressure"] == pytest.approx(1.0)

    def test_get_state_returns_latest(self):
        self.store.get_or_create("conv-5", "claude-sonnet-4")
        self.store.record_turn("conv-5", "claude-sonnet-4", 100, 50, 0, 0.0, 500, None)
        state = self.store.get_state("conv-5")
        assert state is not None
        assert state["turn_count"] == 1

    def test_get_state_returns_none_for_unknown(self):
        assert self.store.get_state("no-such-conv") is None

    def test_end_removes_conversation(self):
        self.store.get_or_create("conv-6", "claude-sonnet-4")
        final = self.store.end("conv-6")
        assert final is not None
        assert self.store.get_state("conv-6") is None

    def test_end_calls_callback(self):
        ended = []
        store = ConversationStore(ttl_s=3600, cleanup_interval_s=3600, on_conversation_end=lambda s: ended.append(s["conversation_id"]))
        store.get_or_create("cb-conv", "claude-sonnet-4")
        store.end("cb-conv")
        assert "cb-conv" in ended
        store.shutdown()

    def test_system_prompt_token_share(self):
        self.store.get_or_create("conv-7", "claude-sonnet-4")
        state = self.store.record_turn("conv-7", "claude-sonnet-4", 1000, 100, 0, 0.0, 500, 100)
        assert state["system_prompt_token_share"] == pytest.approx(0.1)

    def test_ttl_eviction(self):
        evicted = []
        store = ConversationStore(
            ttl_s=0.01, cleanup_interval_s=0.05, on_conversation_end=lambda s: evicted.append(s["conversation_id"])
        )
        store.get_or_create("stale-conv", "claude-sonnet-4")
        time.sleep(0.2)
        assert "stale-conv" in evicted
        assert store.get_state("stale-conv") is None
        store.shutdown()


class TestConversationStateToCustomAttributes:
    def test_includes_required_fields(self):
        store = ConversationStore(ttl_s=3600, cleanup_interval_s=3600)
        store.get_or_create("x", "claude-sonnet-4")
        state = store.record_turn("x", "claude-sonnet-4", 500, 100, 0, 0.01, 300, None)
        attrs = conversation_state_to_custom_attributes(state)
        assert "ai.conversation.id" in attrs
        assert "ai.conversation.turn_count" in attrs
        assert "ai.conversation.context_pressure" in attrs
        store.shutdown()


class TestConversationStateToNrEvent:
    def test_event_type(self):
        store = ConversationStore(ttl_s=3600, cleanup_interval_s=3600)
        store.get_or_create("ev-1", "claude-sonnet-4")
        state = store.record_turn("ev-1", "claude-sonnet-4", 100, 50, 0, 0.0, 200, None)
        event = conversation_state_to_nr_event(state, "my-app")
        assert event["eventType"] == "AiConversationSummary"
        assert event["nr.appName"] == "my-app"
        store.shutdown()
