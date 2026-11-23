from __future__ import annotations

import json
import logging
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

from .crypto import (
    DeviceKey,
    EncryptionKeyPair,
    decrypt_callback_data,
    decrypt_content,
    encrypt_callback_data,
    encrypt_content,
    encrypt_reply_markup,
    generate_key_pair,
)
from .types import (
    BotCallbackQuery,
    BotChat,
    BotFile,
    BotLocation,
    BotMessage,
    BotUpdate,
    BotUser,
)


logger = logging.getLogger(__name__)


class BotAPIError(RuntimeError):
    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class BotClient:
    """Fast Chat Bot API client with optional E2EE support."""

    def __init__(
        self,
        token: str,
        base_url: str = "http://localhost:8080",
        *,
        timeout: float = 30.0,
        encryption_key: EncryptionKeyPair | None = None,
    ) -> None:
        if not token:
            raise ValueError("bot token is required")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.encryption_key = encryption_key
        self._mode: str | None = None
        self._bot_id: str | None = None
        self._chat_users: dict[str, str] = {}
        self._callback_users: dict[str, str] = {}

    def get_me(self) -> BotUser:
        me = BotUser.from_api(self._request("GET", "/api/bot-api/getMe"))
        self._bot_id = me.id
        self._mode = me.encryption_mode
        return me

    def enable_e2ee(self) -> EncryptionKeyPair:
        key = generate_key_pair()
        self._request(
            "PUT",
            "/api/bot-api/encryption-key",
            {"publicKey": key.public_key},
        )
        self.encryption_key = key
        self._mode = "e2ee"
        return key

    def get_user_device_keys(self, user_id: str) -> list[DeviceKey]:
        raw = self._request(
            "POST",
            "/api/bot-api/getUserDeviceKeys",
            {"userId": user_id},
        )
        if not isinstance(raw, list):
            return []
        return [
            DeviceKey(id=str(item.get("id", "")), public_key=str(item.get("publicKey", "")))
            for item in raw
            if item.get("id") and item.get("publicKey")
        ]

    def get_updates(
        self,
        offset: int = 0,
        limit: int = 100,
        timeout: int = 25,
    ) -> list[BotUpdate]:
        raw = self._request(
            "POST",
            "/api/bot-api/getUpdates",
            {"offset": offset, "limit": limit, "timeout": timeout},
            timeout=self.timeout + timeout,
        )
        if not isinstance(raw, list):
            raise BotAPIError("invalid getUpdates response")
        return [self._to_update(item) for item in raw]

    def _require_mode(self) -> str:
        if self._mode is None:
            self.get_me()
        return self._mode or "server"

    def _reject_plaintext_e2ee(self) -> None:
        if self.encryption_key is None and self._require_mode() == "e2ee":
            raise BotAPIError("bot is in e2ee mode; an encryption key is required")

    def send_message(
        self,
        chat_id: str,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> BotMessage:
        if self.encryption_key is not None:
            user_id = self._chat_users.get(chat_id)
            if user_id is None:
                raise BotAPIError("unknown chat user for e2ee reply")
            devices = self.get_user_device_keys(user_id)
            markup = encrypt_reply_markup(
                reply_markup, self.encryption_key.public_key
            )
            content: dict[str, Any] = {"text": text}
            if markup is not None:
                content["replyMarkup"] = markup
            ciphertext, payload = encrypt_content(content, devices)
            raw = self._request(
                "POST",
                "/api/bot-api/sendMessage",
                {
                    "chat_id": chat_id,
                    "text": ciphertext,
                    "encrypted": True,
                    "encrypted_payload": payload,
                },
            )
            message = _message(raw)
            message.text = text
            message.reply_markup = reply_markup
            return message

        self._reject_plaintext_e2ee()
        body: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:
            body["reply_markup"] = reply_markup
        return _message(self._request("POST", "/api/bot-api/sendMessage", body))

    def edit_message_text(
        self,
        chat_id: str,
        message_id: str,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> BotMessage:
        if self.encryption_key is not None:
            user_id = self._chat_users.get(chat_id)
            if user_id is None:
                raise BotAPIError("unknown chat user for e2ee edit")
            devices = self.get_user_device_keys(user_id)
            markup = encrypt_reply_markup(
                reply_markup, self.encryption_key.public_key
            )
            content: dict[str, Any] = {"text": text}
            if markup is not None:
                content["replyMarkup"] = markup
            ciphertext, payload = encrypt_content(content, devices)
            raw = self._request(
                "POST",
                "/api/bot-api/editMessageText",
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": ciphertext,
                    "encrypted": True,
                    "encrypted_payload": payload,
                },
            )
            message = _message(raw)
            message.text = text
            message.reply_markup = reply_markup
            return message

        self._reject_plaintext_e2ee()
        body: dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
        }
        if reply_markup is not None:
            body["reply_markup"] = reply_markup
        return _message(self._request("POST", "/api/bot-api/editMessageText", body))

    def delete_message(self, chat_id: str, message_id: str) -> None:
        self._request(
            "POST",
            "/api/bot-api/deleteMessage",
            {"chat_id": chat_id, "message_id": message_id},
        )

    def get_chat(self, chat_id: str) -> BotChat:
        raw = self._request("POST", "/api/bot-api/getChat", {"chat_id": chat_id})
        return BotChat(
            id=str(raw.get("id", "")),
            type=str(raw.get("type", "private")),
            username=str(raw.get("username", "")),
            display_name=str(raw.get("displayName", raw.get("username", ""))),
        )

    def send_chat_action(self, chat_id: str, action: str = "typing") -> None:
        self._request(
            "POST",
            "/api/bot-api/sendChatAction",
            {"chat_id": chat_id, "action": action},
        )

    def answer_callback_query(
        self,
        callback_query_id: str,
        text: str | None = None,
        show_alert: bool = False,
    ) -> None:
        body: dict[str, Any] = {
            "callback_query_id": callback_query_id,
            "show_alert": show_alert,
        }
        if text is not None:
            body["text"] = text
        if (
            self.encryption_key is not None
            and text is not None
            and text != ""
        ):
            user_id = self._callback_users.get(callback_query_id)
            if user_id is None:
                raise BotAPIError("unknown callback user for e2ee answer")
            devices = self.get_user_device_keys(user_id)
            ciphertext, payload = encrypt_content({"text": text}, devices)
            body["text"] = ciphertext
            body["encrypted"] = True
            body["encrypted_payload"] = payload
        self._request("POST", "/api/bot-api/answerCallbackQuery", body)

    def upload_file(
        self,
        data: bytes,
        filename: str,
        mime_type: str = "application/octet-stream",
    ) -> BotFile:
        if self.encryption_key is not None or self._require_mode() == "e2ee":
            raise BotAPIError("encrypted bot files are not supported")
        boundary = f"----fastchat{uuid.uuid4().hex}"
        safe_name = filename.replace('"', "").replace("\r", "").replace("\n", "")
        mime_type = mime_type.replace("\r", "").replace("\n", "")
        if not mime_type:
            mime_type = (
                mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
            )
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
        raw = self._request(
            "POST",
            "/api/bot-api/uploadFile",
            raw_body=body,
            content_type=f"multipart/form-data; boundary={boundary}",
        )
        file_data = raw.get("file", raw)
        return BotFile(
            id=str(file_data.get("id", "")),
            original_name=str(file_data.get("originalName", filename)),
            mime_type=str(file_data.get("mimeType", mime_type)),
            size=int(file_data.get("size", len(data))),
            hash=str(file_data.get("hash", "")),
        )

    def send_file(
        self,
        chat_id: str,
        file_id: str,
        caption: str | None = None,
    ) -> BotMessage:
        if self.encryption_key is not None or self._require_mode() == "e2ee":
            raise BotAPIError("encrypted bot files are not supported")
        body: dict[str, Any] = {"chat_id": chat_id, "file_id": file_id}
        if caption:
            body["caption"] = caption
        return _message(self._request("POST", "/api/bot-api/sendFile", body))

    def send_location(
        self,
        chat_id: str,
        latitude: float,
        longitude: float,
    ) -> BotMessage:
        if self.encryption_key is not None or self._require_mode() == "e2ee":
            raise BotAPIError("encrypted bot locations are not supported")
        return _message(
            self._request(
                "POST",
                "/api/bot-api/sendLocation",
                {"chat_id": chat_id, "latitude": latitude, "longitude": longitude},
            )
        )

    def download_file(self, file_id: str) -> bytes:
        if self.encryption_key is not None or self._require_mode() == "e2ee":
            raise BotAPIError("encrypted bot files are not supported")
        return self._request(
            "GET",
            f"/api/bot-api/files/{urllib.parse.quote(file_id)}",
            raw_response=True,
        )

    def run(
        self,
        on_message: Callable[[BotMessage], None] | None = None,
        on_callback: Callable[[BotCallbackQuery], None] | None = None,
        *,
        stop: Callable[[], bool] | None = None,
        initial_offset: int = 0,
    ) -> None:
        """Blocking long-poll loop. Return False from stop() to exit.

        ``initial_offset`` lets a caller resume after a restart. The offset is
        advanced only after the handlers for an update complete successfully.
        """
        offset = initial_offset
        backoff = 1.0
        while stop is None or not stop():
            try:
                updates = self.get_updates(offset=offset, timeout=25)
                backoff = 1.0
            except Exception:
                if stop is not None and stop():
                    return
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
                continue
            for update in updates:
                try:
                    if update.message is not None and on_message is not None:
                        on_message(update.message)
                    if update.callback_query is not None and on_callback is not None:
                        on_callback(update.callback_query)
                except Exception:
                    logger.exception("Fast Chat update handler failed")
                    continue
                offset = max(offset, update.update_id + 1)

    def _to_update(self, raw: dict[str, Any]) -> BotUpdate:
        message = None
        if isinstance(raw.get("message"), dict):
            message = _message(raw["message"])
            self._chat_users[message.chat_id] = message.from_user.id
            if (
                self.encryption_key is not None
                and message.encrypted
                and message.encrypted_payload
            ):
                try:
                    content = decrypt_content(
                        message.text,
                        message.encrypted_payload,
                        self._bot_id or self.get_me().id,
                        self.encryption_key,
                    )
                    message.text = str(content.get("text", ""))
                    markup = content.get("replyMarkup")
                    message.reply_markup = (
                        markup if isinstance(markup, dict) else None
                    )
                except Exception:
                    message.undecryptable = True
                    message.text = "[encrypted message]"

        callback = None
        callback_raw = raw.get("callback_query")
        if isinstance(callback_raw, dict):
            callback = BotCallbackQuery(
                id=str(callback_raw.get("id", "")),
                from_user=_user(callback_raw.get("from")),
                message_id=str(callback_raw.get("message_id", "")),
                chat_id=str(callback_raw.get("chat_id", "")),
                data=str(callback_raw.get("data", "")),
            )
            self._callback_users[callback.id] = callback.from_user.id
            self._chat_users[callback.chat_id] = callback.from_user.id
            if self.encryption_key is not None:
                try:
                    callback.data = decrypt_callback_data(
                        callback.data, self.encryption_key
                    )
                except Exception:
                    callback.undecryptable = True
        return BotUpdate(
            update_id=int(raw.get("update_id", 0)),
            message=message,
            callback_query=callback,
        )

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        raw_body: bytes | None = None,
        content_type: str | None = None,
        timeout: float | None = None,
        raw_response: bool = False,
    ):
        data = raw_body
        headers = {"Authorization": f"Bearer {self.token}"}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        elif content_type is not None:
            headers["Content-Type"] = content_type

        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                req, timeout=timeout or self.timeout
            ) as response:
                payload = response.read()
                if raw_response:
                    return payload
                if not payload:
                    return {}
                decoded = json.loads(payload)
                if isinstance(decoded, dict) and decoded.get("ok") is False:
                    raise BotAPIError(str(decoded.get("error", "bot API error")))
                if isinstance(decoded, dict) and "result" in decoded:
                    return decoded["result"]
                return decoded
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise BotAPIError(detail or str(exc), exc.code) from exc
        except urllib.error.URLError as exc:
            raise BotAPIError(str(exc.reason)) from exc


def _user(raw: dict[str, Any] | None) -> BotUser:
    return BotUser.from_api(raw or {})


def _file(raw: dict[str, Any]) -> BotFile:
    return BotFile(
        id=str(raw.get("id", "")),
        original_name=str(raw.get("originalName", raw.get("original_name", ""))),
        mime_type=str(raw.get("mimeType", raw.get("mime_type", ""))),
        size=int(raw.get("size", 0)),
        hash=str(raw.get("hash", "")),
    )


def _message(raw: dict[str, Any]) -> BotMessage:
    location = raw.get("location")
    return BotMessage(
        message_id=str(raw.get("message_id", raw.get("messageId", ""))),
        chat_id=str(raw.get("chat_id", raw.get("chatId", ""))),
        from_user=_user(raw.get("from")),
        text=str(raw.get("text", "")),
        date=str(raw.get("date", "")),
        files=[_file(item) for item in (raw.get("files") or [])],
        location=(
            BotLocation(float(location["lat"]), float(location["lng"]))
            if isinstance(location, dict)
            else None
        ),
        encrypted=bool(raw.get("encrypted", False)),
        reply_markup=raw.get("reply_markup")
        if isinstance(raw.get("reply_markup"), dict)
        else None,
        encrypted_payload=str(raw.get("encrypted_payload", "")),
    )
