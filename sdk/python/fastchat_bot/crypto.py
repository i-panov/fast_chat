"""E2EE primitives shared with the Fast Chat TypeScript SDK.

The wire format is the same as the browser client:

* message content is a JSON object encrypted with XChaCha20-Poly1305;
* the random message key is sealed to every recipient X25519 key;
* the payload is JSON ``{"v":1,"nonce":..., "envelopes":[...]}``;
* callback data sent to a bot is ``"fcbenc:" + base64(sealed data)``.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from typing import Any

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    crypto_aead_xchacha20poly1305_ietf_decrypt,
    crypto_aead_xchacha20poly1305_ietf_encrypt,
    crypto_box_keypair,
    crypto_box_seal,
    crypto_box_seal_open,
)


@dataclass(frozen=True, slots=True)
class EncryptionKeyPair:
    public_key: str
    private_key: str


@dataclass(frozen=True, slots=True)
class DeviceKey:
    id: str
    public_key: str


def generate_key_pair() -> EncryptionKeyPair:
    public, private = crypto_box_keypair()
    return EncryptionKeyPair(_b64(public), _b64(private))


def encrypt_content(
    content: dict[str, Any],
    devices: list[DeviceKey],
) -> tuple[str, str]:
    """Return (base64 ciphertext, encryptedPayload JSON)."""
    if not devices:
        raise ValueError("no recipient device keys")
    message_key = os.urandom(
        crypto_aead_xchacha20poly1305_ietf_KEYBYTES
    )
    nonce = os.urandom(crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
    plaintext = json.dumps(content, separators=(",", ":")).encode()
    ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext, None, nonce, message_key
    )
    envelopes = []
    for device in devices:
        envelopes.append(
            {
                "keyId": device.id,
                "box": _b64(
                    crypto_box_seal(message_key, _unb64(device.public_key))
                ),
            }
        )
    payload = {
        "v": 1,
        "nonce": _b64(nonce),
        "envelopes": envelopes,
    }
    return _b64(ciphertext), json.dumps(payload, separators=(",", ":"))


def decrypt_content(
    text: str,
    encrypted_payload: str,
    key_id: str,
    key: EncryptionKeyPair,
) -> dict[str, Any]:
    """Open the envelope addressed to key_id and decrypt message content."""
    payload = json.loads(encrypted_payload)
    for envelope in payload.get("envelopes", []):
        if str(envelope.get("keyId", "")) != key_id:
            continue
        try:
            message_key = crypto_box_seal_open(
                _unb64(str(envelope["box"])),
                _unb64(key.public_key),
                _unb64(key.private_key),
            )
            plaintext = crypto_aead_xchacha20poly1305_ietf_decrypt(
                _unb64(text),
                None,
                _unb64(str(payload["nonce"])),
                message_key,
            )
            return json.loads(plaintext.decode())
        except Exception:
            continue
    raise ValueError("no matching bot envelope")


def encrypt_callback_data(data: str, bot_public_key: str) -> str:
    encrypted = "fcbenc:" + _b64(
        crypto_box_seal(data.encode(), _unb64(bot_public_key))
    )
    if len(encrypted) > 256:
        raise ValueError("encrypted callback data is too long (max 256 chars)")
    return encrypted


def decrypt_callback_data(data: str, key: EncryptionKeyPair) -> str:
    if not data.startswith("fcbenc:"):
        return data
    plaintext = crypto_box_seal_open(
        _unb64(data[len("fcbenc:") :]),
        _unb64(key.public_key),
        _unb64(key.private_key),
    )
    return plaintext.decode()


def encrypt_reply_markup(
    markup: dict[str, Any] | None,
    bot_public_key: str,
) -> dict[str, Any] | None:
    if markup is None:
        return None
    rows = []
    for row in markup.get("inline_keyboard", []):
        buttons = []
        for button in row:
            item: dict[str, Any] = {"text": str(button.get("text", ""))}
            if "callback_data" in button:
                item["callback_data"] = encrypt_callback_data(
                    str(button["callback_data"]), bot_public_key
                )
            if "url" in button:
                url = str(button["url"])
                if not url.startswith(("http://", "https://")):
                    raise ValueError("inline keyboard URL must be http(s)")
                item["url"] = url
            buttons.append(item)
        rows.append(buttons)
    return {"inline_keyboard": rows}


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)
