from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class BotUser:
    id: str
    username: str
    display_name: str
    is_bot: bool
    encryption_mode: str = "server"

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> "BotUser":
        return cls(
            id=str(data.get("id", "")),
            username=str(data.get("username", "")),
            display_name=str(data.get("display_name", data.get("username", ""))),
            is_bot=bool(data.get("is_bot", False)),
            encryption_mode=str(data.get("encryption_mode", "server")),
        )


@dataclass(slots=True)
class BotFile:
    id: str
    original_name: str
    mime_type: str
    size: int
    hash: str = ""


@dataclass(slots=True)
class BotLocation:
    lat: float
    lng: float


@dataclass(slots=True)
class BotMessage:
    message_id: str
    chat_id: str
    from_user: BotUser
    text: str
    date: str
    files: list[BotFile] = field(default_factory=list)
    location: BotLocation | None = None
    encrypted: bool = False
    reply_markup: dict[str, Any] | None = None
    encrypted_payload: str = ""
    undecryptable: bool = False


@dataclass(slots=True)
class BotCallbackQuery:
    id: str
    from_user: BotUser
    message_id: str
    chat_id: str
    data: str
    undecryptable: bool = False


@dataclass(slots=True)
class BotUpdate:
    update_id: int
    message: BotMessage | None = None
    callback_query: BotCallbackQuery | None = None


@dataclass(slots=True)
class BotChat:
    id: str
    type: str
    username: str
    display_name: str
