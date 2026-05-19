"""Anthropic SDK auto-instrumentation via import hook."""

import importlib
import logging
import sys
from typing import Any, Optional

logger = logging.getLogger(__name__)

_hook_installed = False


def _patch_anthropic(module: Any) -> None:
    """Patch Anthropic.__init__ to auto-wrap every new instance."""
    cls = getattr(module, 'Anthropic', None)
    if cls is None or getattr(cls, '_nr_ai_patched', False):
        return

    original_init = cls.__init__

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        try:
            from nr_ai_agent import _agent_instance  # type: ignore[attr-defined]
            if _agent_instance is not None and _agent_instance.config.enabled:
                _agent_instance.wrap_anthropic_client(self)
                logger.debug("Auto-wrapped Anthropic client")
        except Exception as exc:
            logger.debug("Auto-wrap Anthropic client failed: %s", exc)

    cls.__init__ = _patched_init
    cls._nr_ai_patched = True
    logger.info("Anthropic SDK patched for auto-instrumentation")


class _AnthropicImportHook:
    """sys.meta_path finder that patches anthropic on first import."""

    def find_module(self, name: str, path: Optional[Any] = None) -> Optional["_AnthropicImportHook"]:
        if name == 'anthropic':
            return self
        return None

    def load_module(self, name: str) -> Any:
        # Remove ourselves before importing to prevent recursion.
        if self in sys.meta_path:
            sys.meta_path.remove(self)

        # If a concurrent import already landed the module, patch and return.
        if name in sys.modules:
            module = sys.modules[name]
            _patch_anthropic(module)
            return module

        module = importlib.import_module(name)
        sys.modules[name] = module
        _patch_anthropic(module)
        return module


def install_anthropic_hook() -> None:
    """Install auto-instrumentation for the Anthropic SDK.

    If anthropic is already imported, patches the Anthropic class immediately.
    Otherwise, registers an import hook so the patch is applied on first import.
    """
    global _hook_installed
    if _hook_installed:
        return
    _hook_installed = True

    if 'anthropic' in sys.modules:
        _patch_anthropic(sys.modules['anthropic'])
        return

    sys.meta_path.insert(0, _AnthropicImportHook())
    logger.debug("Anthropic import hook registered")
