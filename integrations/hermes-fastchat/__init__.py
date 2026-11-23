"""Hermes plugin entry point for the Fast Chat platform adapter."""

from .adapter import (
    FastChatAdapter,
    check_requirements,
    register,
    validate_config,
)

__all__ = [
    "FastChatAdapter",
    "check_requirements",
    "register",
    "validate_config",
]
