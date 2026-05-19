"""Tests for auto-instrumentation import hooks."""

import sys
import types
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from nr_ai_agent.hooks.anthropic_hook import (
    _patch_anthropic,
    install_anthropic_hook,
)
from nr_ai_agent.hooks.gemini_hook import (
    _patch_google_genai,
    install_gemini_hook,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_anthropic_module() -> types.ModuleType:
    """Return a minimal fake anthropic module with an Anthropic class."""
    mod = types.ModuleType('anthropic')

    class Anthropic:
        def __init__(self, **kwargs: Any) -> None:
            self.api_key = kwargs.get('api_key', '')

    mod.Anthropic = Anthropic  # type: ignore[attr-defined]
    return mod


def _make_genai_module() -> types.ModuleType:
    """Return a minimal fake google.genai module with a Client class."""
    mod = types.ModuleType('google.genai')

    class Client:
        def __init__(self, **kwargs: Any) -> None:
            self.api_key = kwargs.get('api_key', '')
            self.models = MagicMock()

    mod.Client = Client  # type: ignore[attr-defined]
    return mod


# ---------------------------------------------------------------------------
# anthropic_hook tests
# ---------------------------------------------------------------------------

class TestPatchAnthropic:
    def test_patches_init(self) -> None:
        mod = _make_anthropic_module()
        original_init = mod.Anthropic.__init__
        _patch_anthropic(mod)
        assert mod.Anthropic.__init__ is not original_init
        assert getattr(mod.Anthropic, '_nr_ai_patched', False) is True

    def test_idempotent(self) -> None:
        mod = _make_anthropic_module()
        _patch_anthropic(mod)
        patched_init = mod.Anthropic.__init__
        _patch_anthropic(mod)
        # Second call must not re-wrap
        assert mod.Anthropic.__init__ is patched_init

    def test_skips_module_without_anthropic_class(self) -> None:
        mod = types.ModuleType('anthropic')
        # Should not raise
        _patch_anthropic(mod)

    def test_auto_wraps_instance_when_agent_present(self) -> None:
        mod = _make_anthropic_module()
        _patch_anthropic(mod)

        mock_agent = MagicMock()
        mock_agent.config.enabled = True

        with patch('nr_ai_agent._agent_instance', mock_agent):
            instance = mod.Anthropic(api_key='test')

        mock_agent.wrap_anthropic_client.assert_called_once_with(instance)

    def test_skips_wrap_when_agent_disabled(self) -> None:
        mod = _make_anthropic_module()
        _patch_anthropic(mod)

        mock_agent = MagicMock()
        mock_agent.config.enabled = False

        with patch('nr_ai_agent._agent_instance', mock_agent):
            mod.Anthropic(api_key='test')

        mock_agent.wrap_anthropic_client.assert_not_called()

    def test_skips_wrap_when_no_agent(self) -> None:
        mod = _make_anthropic_module()
        _patch_anthropic(mod)

        with patch('nr_ai_agent._agent_instance', None):
            # Must not raise
            mod.Anthropic(api_key='test')

    def test_wrap_failure_does_not_propagate(self) -> None:
        mod = _make_anthropic_module()
        _patch_anthropic(mod)

        mock_agent = MagicMock()
        mock_agent.config.enabled = True
        mock_agent.wrap_anthropic_client.side_effect = RuntimeError("boom")

        with patch('nr_ai_agent._agent_instance', mock_agent):
            # Should not raise despite the wrap error
            mod.Anthropic(api_key='test')


class TestInstallAnthropicHook:
    def setup_method(self) -> None:
        import nr_ai_agent.hooks.anthropic_hook as m
        m._hook_installed = False

    def test_patches_already_imported_module(self) -> None:
        mod = _make_anthropic_module()
        with patch.dict(sys.modules, {'anthropic': mod}):
            install_anthropic_hook()
        assert getattr(mod.Anthropic, '_nr_ai_patched', False) is True

    def test_registers_meta_path_hook_when_not_imported(self) -> None:
        original_meta = sys.meta_path[:]
        with patch.dict(sys.modules, {}, clear=False):
            sys.modules.pop('anthropic', None)
            install_anthropic_hook()
            new_finders = [f for f in sys.meta_path if f not in original_meta]
            assert len(new_finders) == 1
            # Clean up
            sys.meta_path[:] = original_meta

    def test_idempotent(self) -> None:
        mod = _make_anthropic_module()
        with patch.dict(sys.modules, {'anthropic': mod}):
            install_anthropic_hook()
            install_anthropic_hook()
        # _nr_ai_patched should still be True, not double-patched
        assert getattr(mod.Anthropic, '_nr_ai_patched', False) is True


# ---------------------------------------------------------------------------
# gemini_hook tests
# ---------------------------------------------------------------------------

class TestPatchGoogleGenai:
    def test_patches_init(self) -> None:
        mod = _make_genai_module()
        original_init = mod.Client.__init__
        _patch_google_genai(mod)
        assert mod.Client.__init__ is not original_init
        assert getattr(mod.Client, '_nr_ai_patched', False) is True

    def test_idempotent(self) -> None:
        mod = _make_genai_module()
        _patch_google_genai(mod)
        patched_init = mod.Client.__init__
        _patch_google_genai(mod)
        assert mod.Client.__init__ is patched_init

    def test_skips_module_without_client_class(self) -> None:
        mod = types.ModuleType('google.genai')
        _patch_google_genai(mod)

    def test_auto_wraps_instance_when_agent_present(self) -> None:
        mod = _make_genai_module()
        _patch_google_genai(mod)

        mock_agent = MagicMock()
        mock_agent.config.enabled = True

        with patch('nr_ai_agent._agent_instance', mock_agent):
            instance = mod.Client(api_key='test')

        mock_agent.wrap_gemini_client.assert_called_once_with(instance)

    def test_skips_wrap_when_agent_disabled(self) -> None:
        mod = _make_genai_module()
        _patch_google_genai(mod)

        mock_agent = MagicMock()
        mock_agent.config.enabled = False

        with patch('nr_ai_agent._agent_instance', mock_agent):
            mod.Client(api_key='test')

        mock_agent.wrap_gemini_client.assert_not_called()

    def test_wrap_failure_does_not_propagate(self) -> None:
        mod = _make_genai_module()
        _patch_google_genai(mod)

        mock_agent = MagicMock()
        mock_agent.config.enabled = True
        mock_agent.wrap_gemini_client.side_effect = RuntimeError("boom")

        with patch('nr_ai_agent._agent_instance', mock_agent):
            mod.Client(api_key='test')


class TestInstallGeminiHook:
    def setup_method(self) -> None:
        import nr_ai_agent.hooks.gemini_hook as m
        m._hook_installed = False

    def test_patches_already_imported_module(self) -> None:
        mod = _make_genai_module()
        with patch.dict(sys.modules, {'google.genai': mod}):
            install_gemini_hook()
        assert getattr(mod.Client, '_nr_ai_patched', False) is True

    def test_registers_meta_path_hook_when_not_imported(self) -> None:
        original_meta = sys.meta_path[:]
        sys.modules.pop('google.genai', None)
        install_gemini_hook()
        new_finders = [f for f in sys.meta_path if f not in original_meta]
        assert len(new_finders) == 1
        sys.meta_path[:] = original_meta

    def test_idempotent(self) -> None:
        mod = _make_genai_module()
        with patch.dict(sys.modules, {'google.genai': mod}):
            install_gemini_hook()
            install_gemini_hook()
        assert getattr(mod.Client, '_nr_ai_patched', False) is True
