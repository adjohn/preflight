import gzip
import json
import logging
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)


class NrEventTransport:
    """Transport for sending events to New Relic Events API."""

    def __init__(self, account_id: int, license_key: str, collector_host: str = "collector.newrelic.com"):
        """Initialize the transport."""
        self.account_id = account_id
        self.license_key = license_key
        self.collector_host = collector_host
        self.url = f"https://{collector_host}/v1/accounts/{account_id}/events"
        self.headers = {
            "Api-Key": license_key,
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
        }

    def send_events(self, events: List[Dict[str, Any]]) -> bool:
        """Send events to New Relic."""
        if not events:
            return True

        try:
            payload = json.dumps(events).encode("utf-8")
            compressed = gzip.compress(payload)

            response = requests.post(
                self.url,
                data=compressed,
                headers=self.headers,
                timeout=10,
            )

            if response.status_code in (200, 202):
                logger.debug(f"Sent {len(events)} events to New Relic")
                return True
            else:
                logger.warning(
                    f"Failed to send events: {response.status_code} {response.text}"
                )
                return False
        except Exception as e:
            logger.error(f"Error sending events: {e}")
            return False


class NrMetricTransport:
    """Transport for sending metrics to New Relic Metric API."""

    def __init__(self, account_id: int, license_key: str, collector_host: str = "collector.newrelic.com"):
        """Initialize the transport."""
        self.account_id = account_id
        self.license_key = license_key
        self.collector_host = collector_host
        self.url = f"https://{collector_host}/metric/v1"
        self.headers = {
            "Api-Key": license_key,
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
        }

    def send_metrics(self, metrics: List[Dict[str, Any]]) -> bool:
        """Send metrics to New Relic."""
        if not metrics:
            return True

        try:
            payload = json.dumps({"metrics": metrics}).encode("utf-8")
            compressed = gzip.compress(payload)

            response = requests.post(
                self.url,
                data=compressed,
                headers=self.headers,
                timeout=10,
            )

            if response.status_code in (200, 202):
                logger.debug(f"Sent {len(metrics)} metrics to New Relic")
                return True
            else:
                logger.warning(
                    f"Failed to send metrics: {response.status_code} {response.text}"
                )
                return False
        except Exception as e:
            logger.error(f"Error sending metrics: {e}")
            return False
