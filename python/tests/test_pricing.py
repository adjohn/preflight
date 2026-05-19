import pytest

from nr_ai_agent.pricing import TokenUsage, calculate_cost, get_model_pricing


def test_token_usage_total_tokens():
    """Test total tokens calculation."""
    usage = TokenUsage(
        input_tokens=100,
        output_tokens=50,
        thinking_tokens=25,
        cache_read_tokens=10,
        cache_creation_tokens=5,
    )
    assert usage.total_tokens == 190


def test_calculate_cost_anthropic_sonnet():
    """Test cost calculation for Anthropic Claude Sonnet."""
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    cost = calculate_cost("anthropic", "claude-sonnet-4", usage)
    # 1M * 3.0 + 1M * 15.0 = 3.0 + 15.0 = 18.0
    assert cost == 18.0


def test_calculate_cost_with_cache():
    """Test cost calculation with cache tokens."""
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=500_000,
        cache_creation_tokens=200_000,
    )
    cost = calculate_cost("anthropic", "claude-sonnet-4", usage)
    # input: 1M * 3.0 = 3.0
    # output: 1M * 15.0 = 15.0
    # cache_read: 500k * 0.3 = 0.15
    # cache_creation: 200k * 0.75 = 0.15
    # total: 18.3
    assert abs(cost - 18.3) < 0.01


def test_calculate_cost_google_gemini():
    """Test cost calculation for Google Gemini."""
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    cost = calculate_cost("google", "gemini-2.0-flash", usage)
    # 1M * 0.075 + 1M * 0.3 = 0.075 + 0.3 = 0.375
    assert cost == 0.375


def test_calculate_cost_openai_gpt4():
    """Test cost calculation for OpenAI GPT-4."""
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    cost = calculate_cost("openai", "gpt-4o", usage)
    # 1M * 2.5 + 1M * 10.0 = 2.5 + 10.0 = 12.5
    assert cost == 12.5


def test_calculate_cost_with_thinking():
    """Test cost calculation with thinking tokens."""
    usage = TokenUsage(
        input_tokens=100_000,
        output_tokens=50_000,
        thinking_tokens=200_000,
    )
    cost = calculate_cost("anthropic", "claude-opus-4", usage)
    # input: 100k * 15.0 = 1.5
    # output: 50k * 75.0 = 3.75
    # thinking: 200k * 0.0 = 0.0
    # total: 5.25
    assert cost == 5.25


def test_calculate_cost_unknown_model():
    """Test cost calculation for unknown model returns 0."""
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    cost = calculate_cost("anthropic", "unknown-model", usage)
    assert cost == 0.0


def test_calculate_cost_unknown_provider():
    """Test cost calculation for unknown provider returns 0."""
    usage = TokenUsage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    cost = calculate_cost("unknown-provider", "some-model", usage)
    assert cost == 0.0


def test_get_model_pricing():
    """Test retrieving model pricing."""
    pricing = get_model_pricing("anthropic", "claude-sonnet-4")
    assert pricing is not None
    assert pricing["input"] == 3.0
    assert pricing["output"] == 15.0


def test_get_model_pricing_unknown():
    """Test retrieving pricing for unknown model."""
    pricing = get_model_pricing("anthropic", "unknown-model")
    assert pricing is None
