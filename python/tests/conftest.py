"""Pytest configuration for nr-ai-agent tests."""

import sys
from pathlib import Path

# Add src directory to path so tests can import nr_ai_agent
src_path = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(src_path))
