"""Fast Chat platform adapter for Hermes Agent.

Hermes plugins are Python, so this adapter uses the Fast Chat Python Bot SDK
directly. It implements long polling and maps Fast Chat bot updates to
Hermes MessageEvent objects.
"""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import ipaddress
import json
import logging
import mimetypes
import os
import socket
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, build_opener

from fastchat_bot import BotClient, BotMessage
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://localhost:8080"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIRECT_OPENER = build_opener(_NoRedirect)


def _env_or_extra(
    config: PlatformConfig, env: str, key: str, default: str = ""
) -> str:
    extra = getattr(config, "extra", {}) or {}
    return os.getenv(env) or str(extra.get(key, default) or default)


class FastChatAdapter(BasePlatformAdapter):
    """Hermes gateway adapter backed by the Fast Chat Python Bot SDK."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("fastchat"))
        self._token = _env_or_extra(config, "FASTCHAT_BOT_TOKEN", "token")
        self._base_url = _env_or_extra(
            config, "FASTCHAT_BOT_BASE_URL", "base_url", DEFAULT_BASE_URL
        ).rstrip("/")
        self._client: Optional[BotClient] = None
        self._poll_task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._temp_files: list[str] = []
        self._offset = 0
        self._bot_id = ""
        self._offset_file: Optional[Path] = None

    @property
    def name(self) -> str:
        return "Fast Chat"

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self._token:
            self._set_fatal_error(
                "config_missing",
                "FASTCHAT_BOT_TOKEN is not configured",
                retryable=False,
            )
            return False
        try:
            client = BotClient(self._token, self._base_url)
            me = await asyncio.to_thread(client.get_me)
            self._bot_id = me.id
            if me.encryption_mode == "e2ee":
                self._set_fatal_error(
                    "e2ee_unsupported",
                    "Fast Chat bot is in E2EE mode, but this adapter has no bot key",
                    retryable=False,
                )
                return False
        except Exception as exc:  # noqa: BLE001 - remote API
            self._set_fatal_error(
                "connection_failed", str(exc), retryable=True
            )
            return False

        self._offset = self._load_offset()

        self._client = client
        self._stop.clear()
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._mark_connected()
        logger.info("Fast Chat connected to %s", self._base_url)
        return True

    async def disconnect(self) -> None:
        self._stop.set()
        if self._poll_task is not None:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._poll_task = None
        self._client = None
        for path in self._temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass
        self._temp_files.clear()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="Fast Chat is not connected")
        try:
            message = await asyncio.to_thread(
                self._client.send_message, chat_id, str(content)
            )
        except Exception as exc:  # noqa: BLE001 - transport failure
            return SendResult(success=False, error=str(exc))
        return SendResult(
            success=True,
            message_id=message.message_id or uuid.uuid4().hex,
        )

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs,
    ) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="Fast Chat is not connected")
        path = Path(file_path)
        try:
            if path.stat().st_size > 50 * 1024 * 1024:
                return SendResult(success=False, error="file is too large")
            data = await asyncio.to_thread(path.read_bytes)
            uploaded = await asyncio.to_thread(
                self._client.upload_file,
                data,
                file_name or path.name,
                mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            )
            message = await asyncio.to_thread(
                self._client.send_file, chat_id, uploaded.id, caption
            )
        except Exception as exc:  # noqa: BLE001 - local/remote media failure
            return SendResult(success=False, error=str(exc))
        return SendResult(success=True, message_id=message.message_id)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs,
    ) -> SendResult:
        return await self.send_document(
            chat_id, image_path, caption=caption, reply_to=reply_to, **kwargs
        )

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        parsed = urlparse(image_url)
        if parsed.scheme not in {"http", "https"}:
            return SendResult(success=False, error="only http(s) images are supported")
        if self._client is None:
            return SendResult(success=False, error="Fast Chat is not connected")
        try:
            if not await asyncio.to_thread(_is_safe_public_url, image_url):
                return SendResult(success=False, error="image URL is not publicly routable")

            def _fetch() -> bytes:
                with _NO_REDIRECT_OPENER.open(image_url, timeout=30) as response:  # noqa: S310
                    data = response.read(50 * 1024 * 1024 + 1)
                    if len(data) > 50 * 1024 * 1024:
                        raise ValueError("image is too large")
                    return data

            data = await asyncio.to_thread(_fetch)
            name = Path(parsed.path).name or "image"
            uploaded = await asyncio.to_thread(
                self._client.upload_file,
                data,
                name,
                mimetypes.guess_type(name)[0] or "application/octet-stream",
            )
            message = await asyncio.to_thread(
                self._client.send_file, chat_id, uploaded.id, caption
            )
        except Exception as exc:  # noqa: BLE001 - remote image failure
            return SendResult(success=False, error=str(exc))
        return SendResult(success=True, message_id=message.message_id)

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs,
    ) -> SendResult:
        return await self.send_document(
            chat_id, audio_path, caption=caption, reply_to=reply_to, **kwargs
        )

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs,
    ) -> SendResult:
        return await self.send_document(
            chat_id, video_path, caption=caption, reply_to=reply_to, **kwargs
        )

    async def send_location(
        self, chat_id: str, latitude: float, longitude: float
    ) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="Fast Chat is not connected")
        try:
            message = await asyncio.to_thread(
                self._client.send_location, chat_id, latitude, longitude
            )
        except Exception as exc:  # noqa: BLE001 - remote API
            return SendResult(success=False, error=str(exc))
        return SendResult(success=True, message_id=message.message_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        if self._client is None:
            return
        try:
            await asyncio.to_thread(self._client.send_chat_action, chat_id)
        except Exception:  # noqa: BLE001 - typing is best-effort
            return

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        if self._client is None:
            return {"name": chat_id, "type": "dm"}
        try:
            chat = await asyncio.to_thread(self._client.get_chat, chat_id)
        except Exception:  # noqa: BLE001 - chat info is optional
            return {"name": chat_id, "type": "dm"}
        return {
            "name": chat.display_name or chat.username or chat_id,
            "type": "dm",
        }

    def _offset_path(self) -> Path:
        home = Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))
        digest = hashlib.sha256(
            f"{self._base_url}\0{self._bot_id}".encode()
        ).hexdigest()[:20]
        return home / "fastchat" / f"offset-{digest}"

    def _load_offset(self) -> int:
        if self._offset_file is None:
            self._offset_file = self._offset_path()
        try:
            return int(self._offset_file.read_text().strip())
        except (OSError, ValueError):
            return 0

    def _save_offset(self) -> None:
        if self._offset_file is None:
            return
        try:
            self._offset_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._offset_file.with_suffix(".tmp")
            tmp.write_text(str(self._offset))
            tmp.replace(self._offset_file)
        except OSError:
            return

    async def _poll_loop(self) -> None:
        client = self._client
        if client is None:
            return
        while not self._stop.is_set():
            try:
                updates = await asyncio.to_thread(
                    client.get_updates, self._offset, 100, 25
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - polling must survive transient failures
                logger.warning("Fast Chat polling failed: %s", exc)
                await asyncio.sleep(5)
                continue
            for update in updates:
                if update.message is not None:
                    try:
                        await self._dispatch_message(update.message)
                    except Exception as exc:  # noqa: BLE001 - keep polling
                        logger.warning("Fast Chat dispatch failed: %s", exc)
                        continue
                self._offset = max(self._offset, update.update_id + 1)
                await asyncio.to_thread(self._save_offset)

    async def _dispatch_message(self, message: BotMessage) -> None:
        if self._message_handler is None:
            return
        if message.undecryptable:
            logger.warning("Fast Chat message could not be decrypted; dropping it")
            return
        parts = [message.text]
        media_urls: list[str] = []
        media_types: list[str] = []
        for file in message.files:
            parts.append(f"[file: {file.original_name or file.id}]")
            try:
                data = await asyncio.to_thread(
                    self._client.download_file, file.id
                )
                suffix = Path(file.original_name or "").suffix or ".bin"
                fd, path = tempfile.mkstemp(prefix="fastchat-", suffix=suffix)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                self._temp_files.append(path)
                media_urls.append(path)
                media_types.append(file.mime_type or "application/octet-stream")
            except Exception as exc:  # noqa: BLE001 - attachment is best-effort
                logger.warning("Fast Chat attachment download failed: %s", exc)
        if message.location is not None:
            parts.append(
                f"[location: {message.location.lat},{message.location.lng}]"
            )
        text = "\n".join(part for part in parts if part)
        source = self.build_source(
            chat_id=message.chat_id,
            chat_name=message.chat_id,
            chat_type="dm",
            user_id=message.from_user.id,
            user_name=message.from_user.display_name
            or message.from_user.username
            or message.from_user.id,
        )
        if media_types:
            first = media_types[0]
            if first.startswith("image/"):
                message_type = MessageType.PHOTO
            elif first.startswith("video/"):
                message_type = MessageType.VIDEO
            elif first.startswith("audio/"):
                message_type = MessageType.AUDIO
            else:
                message_type = MessageType.DOCUMENT
        elif message.location is not None:
            message_type = MessageType.LOCATION
        else:
            message_type = MessageType.TEXT
        await self.handle_message(
            MessageEvent(
                text=text,
                message_type=message_type,
                user_id=message.from_user.id,
                user_name=message.from_user.display_name
                or message.from_user.username
                or message.from_user.id,
                source=source,
                raw_message=message,
                message_id=message.message_id or uuid.uuid4().hex,
                media_urls=media_urls,
                media_types=media_types,
                media_text_inlined=[False] * len(media_urls),
                timestamp=datetime.datetime.now(datetime.timezone.utc),
            )
        )

def _is_safe_public_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port)
    except (OSError, ValueError):
        return False
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address[4][0])
        except ValueError:
            return False
        if not ip.is_global or ip.is_multicast:
            return False
    return True


def check_requirements() -> bool:
    # Hermes calls this before it has the configured PlatformConfig. The
    # config-only path is checked by validate_config instead.
    return True


def validate_config(config: PlatformConfig) -> bool:
    return bool(_env_or_extra(config, "FASTCHAT_BOT_TOKEN", "token"))


def _env_enablement() -> Optional[dict[str, Any]]:
    token = os.getenv("FASTCHAT_BOT_TOKEN", "").strip()
    if not token:
        return None
    extra: dict[str, Any] = {"token": token}
    base_url = os.getenv("FASTCHAT_BOT_BASE_URL", "").strip()
    if base_url:
        extra["base_url"] = base_url.rstrip("/")
    return extra


def _send_location_tool(args: dict[str, Any], **kwargs) -> str:
    token = str(args.get("token") or os.getenv("FASTCHAT_BOT_TOKEN", ""))
    base_url = str(
        args.get("base_url")
        or os.getenv("FASTCHAT_BOT_BASE_URL", DEFAULT_BASE_URL)
    )
    try:
        client = BotClient(token, base_url)
        message = client.send_location(
            str(args["chat_id"]),
            float(args["latitude"]),
            float(args["longitude"]),
        )
        return json.dumps({"ok": True, "message_id": message.message_id})
    except Exception as exc:  # noqa: BLE001 - tool contract returns errors
        return json.dumps({"ok": False, "error": str(exc)})


def register(ctx) -> None:
    ctx.register_tool(
        name="fastchat_send_location",
        toolset="fastchat",
        schema={
            "name": "fastchat_send_location",
            "description": (
                "Send a geographic location to the current Fast Chat chat. "
                "Use chat_id from the message source."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chat_id": {"type": "string"},
                    "latitude": {"type": "number"},
                    "longitude": {"type": "number"},
                    "token": {"type": "string"},
                    "base_url": {"type": "string"},
                },
                "required": ["chat_id", "latitude", "longitude"],
            },
        },
        handler=_send_location_tool,
    )
    ctx.register_platform(
        name="fastchat",
        label="Fast Chat",
        adapter_factory=FastChatAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["FASTCHAT_BOT_TOKEN"],
        env_enablement_fn=_env_enablement,
        allowed_users_env="FASTCHAT_ALLOWED_USERS",
        allow_all_env="FASTCHAT_ALLOW_ALL_USERS",
        max_message_length=4096,
        emoji="💬",
        allow_update_command=True,
        platform_hint=(
            "You are chatting through Fast Chat. Messages are plain text; "
            "the platform does not render Markdown tables or HTML. "
            "Files and locations are shown as text annotations."
        ),
    )
