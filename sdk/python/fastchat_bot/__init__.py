"""Python client for the Fast Chat Bot API.

The client uses the standard library for HTTP and PyNaCl for E2EE. It supports
long polling, messages, files, locations, inline keyboards and encrypted bot
chats.
"""

from .client import BotAPIError, BotClient
from .crypto import DeviceKey, EncryptionKeyPair, generate_key_pair
from .types import (
    BotCallbackQuery,
    BotChat,
    BotFile,
    BotLocation,
    BotMessage,
    BotUpdate,
    BotUser,
)

__all__ = [
    "BotAPIError",
    "BotChat",
    "BotClient",
    "BotFile",
    "BotLocation",
    "BotMessage",
    "BotUpdate",
    "BotUser",
    "BotCallbackQuery",
    "DeviceKey",
    "EncryptionKeyPair",
    "generate_key_pair",
]
