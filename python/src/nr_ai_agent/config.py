import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AgentConfig:
    """Configuration for the NR AI Agent."""
    enabled: bool = True
    license_key: str = ""
    account_id: int = 0
    app_name: str = "unknown"
    collector_host: str = "collector.newrelic.com"
    record_content: bool = False
    high_security: bool = False
    content_max_length: int = 1024
    custom_pricing_file: Optional[str] = None
    cost_tracking_enabled: bool = True

    @classmethod
    def from_env(cls) -> "AgentConfig":
        """Load configuration from environment variables."""
        return cls(
            enabled=os.getenv("NEW_RELIC_AI_AGENT_ENABLED", "true").lower() == "true",
            license_key=os.getenv("NEW_RELIC_LICENSE_KEY", ""),
            account_id=int(os.getenv("NEW_RELIC_ACCOUNT_ID", "0")),
            app_name=os.getenv("NEW_RELIC_APP_NAME", "unknown"),
            collector_host=os.getenv("NEW_RELIC_COLLECTOR_HOST", "collector.newrelic.com"),
            record_content=os.getenv("NEW_RELIC_RECORD_CONTENT", "false").lower() == "true",
            high_security=os.getenv("NEW_RELIC_HIGH_SECURITY", "false").lower() == "true",
            content_max_length=int(os.getenv("NEW_RELIC_CONTENT_MAX_LENGTH", "1024")),
            custom_pricing_file=os.getenv("NEW_RELIC_CUSTOM_PRICING_FILE"),
            cost_tracking_enabled=os.getenv("NEW_RELIC_COST_TRACKING_ENABLED", "true").lower() == "true",
        )

    def validate(self) -> None:
        """Validate configuration."""
        if self.enabled and not self.license_key:
            raise ValueError(
                "Missing required configuration: NEW_RELIC_LICENSE_KEY. "
                "Set the NEW_RELIC_LICENSE_KEY environment variable."
            )
        if self.enabled and self.account_id == 0:
            raise ValueError(
                "Missing required configuration: NEW_RELIC_ACCOUNT_ID. "
                "Set the NEW_RELIC_ACCOUNT_ID environment variable."
            )
        if self.account_id < 0 or self.account_id > 999999999999:
            raise ValueError(
                "Invalid NEW_RELIC_ACCOUNT_ID: must be between 0 and 999999999999."
            )
