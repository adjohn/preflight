"""Google GenAI SDK auto-instrumentation via import hook."""

import importlib
import logging
import sys
from typing import Any, Optional

logger = logging.getLogger(__name__)

_hook_installed = False


def _patch_google_genai(module: Any) -> None:
    """Patch google.genai.Client.__init__ to auto-wrap every new instance."""
    cls = getattr(module, 'Client', None)
    if cls is None or getattr(cls, '_nr_ai_patched', False):
        return

    original_init = cls.__init__

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        try:
            from nr_ai_agent import _agent_instance  # type: ignore[attr-defined]
            if _agent_instance is not None and _agent_instance.config.enabled:
                _agent_instance.wrap_gemini_client(self)
                logger.debug("Auto-wrapped Google GenAI client")
        except Exception as exc:
            logger.debug("Auto-wrap Google GenAI client failed: %s", exc)

    cls.__init__ = _patched_init
    cls._nr_ai_patched = True
    logger.info("Google GenAI SDK patched for auto-instrumentation")


class _GeminiImportHook:
    """sys.meta_path finder that patches google.genai on first import."""

    def find_module(self, name: str, path: Optional[Any] = None) -> Optional["_GeminiImportHook"]:
        if name == 'google.genai':
            return self
        return None

    def load_module(self, name: str) -> Any:
        # Remove ourselves before importing to prevent recursion.
        if self in sys.meta_path:
            sys.meta_path.remove(self)

        # If a concurrent import already landed the module, patch and return.
        if name in sys.modules:
            module = sys.modules[name]
            _patch_google_genai(module)
            return module

        module = importlib.import_module(name)
        sys.modules[name] = module
        _patch_google_genai(module)
        return module


def install_gemini_hook() -> None:
    """Install auto-instrumentation for the Google GenAI SDK.

    If google.genai is already imported, patches the Client class immediately.
    Otherwise, registers an import hook so the patch is applied on first import.
    """
    global _hook_installed
    if _hook_installed:
        return
    _hook_installed = True

    if 'google.genai' in sys.modules:
        _patch_google_genai(sys.modules['google.genai'])
        return

    sys.meta_path.insert(0, _GeminiImportHook())
    logger.debug("Google GenAI import hook registered")
