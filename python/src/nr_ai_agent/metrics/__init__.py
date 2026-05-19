"""Metric modules for nr-ai-agent Python SDK."""

from .cache_economics import (
    CacheEconomicsTracker,
    cache_metrics_to_custom_attributes,
    extract_cache_metrics,
)
from .conversation import (
    ConversationStore,
    conversation_state_to_custom_attributes,
    conversation_state_to_nr_event,
    generate_conversation_id_from_messages,
)
from .cost_attribution import (
    attribution_tags_to_custom_attributes,
    clear_attribution_context,
    get_attribution_context,
    resolve_attribution,
    set_attribution_context,
    strip_nr_metadata,
)
from .multimodal import (
    detect_modalities,
    modality_metrics_to_custom_attributes,
)
from .provider_comparison import (
    ProviderComparisonAggregator,
    comparison_metrics_to_custom_attributes,
    provider_model_stats_to_nr_event,
)
from .quality import (
    QualityTracker,
    quality_metrics_to_custom_attributes,
)
from .reasoning import (
    extract_reasoning_metrics,
    reasoning_metrics_to_custom_attributes,
)

__all__ = [
    # reasoning
    "extract_reasoning_metrics",
    "reasoning_metrics_to_custom_attributes",
    # cache_economics
    "extract_cache_metrics",
    "CacheEconomicsTracker",
    "cache_metrics_to_custom_attributes",
    # conversation
    "generate_conversation_id_from_messages",
    "ConversationStore",
    "conversation_state_to_custom_attributes",
    "conversation_state_to_nr_event",
    # quality
    "QualityTracker",
    "quality_metrics_to_custom_attributes",
    # multimodal
    "detect_modalities",
    "modality_metrics_to_custom_attributes",
    # cost_attribution
    "resolve_attribution",
    "set_attribution_context",
    "get_attribution_context",
    "clear_attribution_context",
    "attribution_tags_to_custom_attributes",
    "strip_nr_metadata",
    # provider_comparison
    "ProviderComparisonAggregator",
    "provider_model_stats_to_nr_event",
    "comparison_metrics_to_custom_attributes",
]
