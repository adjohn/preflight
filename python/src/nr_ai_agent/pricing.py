from dataclasses import dataclass
from typing import Dict, Optional

# Pricing table (USD per 1M tokens) — updated May 2026
PRICING_DATA = {
    "anthropic": {
        "claude-opus-4": {
            "input": 15.0,
            "output": 75.0,
            "thinking": 0.0,
            "cache_read": 1.5,
            "cache_creation": 3.75,
        },
        "claude-sonnet-4": {
            "input": 3.0,
            "output": 15.0,
            "thinking": 0.0,
            "cache_read": 0.3,
            "cache_creation": 0.75,
        },
        "claude-sonnet-4-20250514": {
            "input": 3.0,
            "output": 15.0,
            "thinking": 0.0,
            "cache_read": 0.3,
            "cache_creation": 0.75,
        },
        "claude-haiku-4": {
            "input": 0.8,
            "output": 4.0,
            "thinking": 0.0,
            "cache_read": 0.08,
            "cache_creation": 0.2,
        },
        "claude-haiku-4-20251001": {
            "input": 0.8,
            "output": 4.0,
            "thinking": 0.0,
            "cache_read": 0.08,
            "cache_creation": 0.2,
        },
    },
    "google": {
        "gemini-2.0-flash": {
            "input": 0.075,
            "output": 0.3,
            "thinking": 0.0,
            "cache_read": 0.007,
            "cache_creation": 0.022,
        },
        "gemini-1.5-pro": {
            "input": 1.25,
            "output": 5.0,
            "thinking": 0.0,
            "cache_read": 0.125,
            "cache_creation": 0.375,
        },
        "gemini-1.5-flash": {
            "input": 0.075,
            "output": 0.3,
            "thinking": 0.0,
            "cache_read": 0.007,
            "cache_creation": 0.022,
        },
    },
    "openai": {
        "gpt-4o": {
            "input": 2.5,
            "output": 10.0,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
        "gpt-4-turbo": {
            "input": 10.0,
            "output": 30.0,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
        "gpt-4": {
            "input": 30.0,
            "output": 60.0,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
    },
    "mistral": {
        "mistral-large": {
            "input": 2.0,
            "output": 6.0,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
        "mistral-medium": {
            "input": 0.81,
            "output": 2.43,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
    },
    "cohere": {
        "command-r-plus": {
            "input": 3.0,
            "output": 15.0,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
        "command-r": {
            "input": 0.5,
            "output": 1.5,
            "thinking": 0.0,
            "cache_read": 0.0,
            "cache_creation": 0.0,
        },
    },
}


@dataclass
class TokenUsage:
    """Token usage for a single request."""
    input_tokens: int
    output_tokens: int
    thinking_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        """Total tokens used."""
        return (
            self.input_tokens
            + self.output_tokens
            + self.thinking_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )


def calculate_cost(
    provider: str,
    model: str,
    token_usage: TokenUsage,
) -> float:
    """Calculate cost in USD for a request."""
    pricing = PRICING_DATA.get(provider, {}).get(model)
    if not pricing:
        return 0.0

    cost_usd = (
        (token_usage.input_tokens * pricing["input"])
        + (token_usage.output_tokens * pricing["output"])
        + (token_usage.thinking_tokens * pricing["thinking"])
        + (token_usage.cache_read_tokens * pricing["cache_read"])
        + (token_usage.cache_creation_tokens * pricing["cache_creation"])
    ) / 1_000_000

    return round(cost_usd, 6)


def get_model_pricing(provider: str, model: str) -> Optional[Dict[str, float]]:
    """Get pricing for a specific model."""
    return PRICING_DATA.get(provider, {}).get(model)
