import os
import pytest

from nr_ai_agent.config import AgentConfig


def test_config_from_env_defaults():
    """Test loading default configuration."""
    # Save original env vars
    env_backup = os.environ.copy()

    try:
        # Clear all relevant env vars
        for key in ["NEW_RELIC_AI_AGENT_ENABLED", "NEW_RELIC_LICENSE_KEY",
                    "NEW_RELIC_ACCOUNT_ID", "NEW_RELIC_APP_NAME"]:
            os.environ.pop(key, None)

        config = AgentConfig.from_env()

        assert config.enabled is True
        assert config.license_key == ""
        assert config.account_id == 0
        assert config.app_name == "unknown"
        assert config.collector_host == "collector.newrelic.com"
        assert config.record_content is False
        assert config.high_security is False
        assert config.content_max_length == 1024
        assert config.cost_tracking_enabled is True
    finally:
        os.environ.clear()
        os.environ.update(env_backup)


def test_config_from_env_custom_values():
    """Test loading custom configuration from environment."""
    env_backup = os.environ.copy()

    try:
        os.environ["NEW_RELIC_AI_AGENT_ENABLED"] = "false"
        os.environ["NEW_RELIC_LICENSE_KEY"] = "test-key"
        os.environ["NEW_RELIC_ACCOUNT_ID"] = "123456"
        os.environ["NEW_RELIC_APP_NAME"] = "my-app"
        os.environ["NEW_RELIC_RECORD_CONTENT"] = "true"
        os.environ["NEW_RELIC_HIGH_SECURITY"] = "true"

        config = AgentConfig.from_env()

        assert config.enabled is False
        assert config.license_key == "test-key"
        assert config.account_id == 123456
        assert config.app_name == "my-app"
        assert config.record_content is True
        assert config.high_security is True
    finally:
        os.environ.clear()
        os.environ.update(env_backup)


def test_config_validate_success():
    """Test successful validation."""
    config = AgentConfig(
        enabled=False,
        license_key="test",
        account_id=123,
    )
    # Should not raise
    config.validate()


def test_config_validate_missing_license_key():
    """Test validation fails with missing license key."""
    config = AgentConfig(
        enabled=True,
        account_id=123,
    )
    with pytest.raises(ValueError, match="NEW_RELIC_LICENSE_KEY"):
        config.validate()


def test_config_validate_missing_account_id():
    """Test validation fails with missing account ID."""
    config = AgentConfig(
        enabled=True,
        license_key="test",
    )
    with pytest.raises(ValueError, match="NEW_RELIC_ACCOUNT_ID"):
        config.validate()


def test_config_validate_invalid_account_id():
    """Test validation fails with invalid account ID."""
    config = AgentConfig(
        enabled=True,
        license_key="test",
        account_id=10000000000000,  # Too large
    )
    with pytest.raises(ValueError, match="between 0 and 999999999999"):
        config.validate()
