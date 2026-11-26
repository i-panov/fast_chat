from __future__ import annotations

import base64
import json
import os
import unittest

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_encrypt,
    crypto_box_easy,
)
from nacl.signing import SigningKey

from fastchat_bot.crypto import (
    DeviceKey,
    decrypt_callback_data,
    decrypt_content,
    encrypt_callback_data,
    encrypt_content,
    generate_key_pair,
    encrypt_reply_markup,
)


class CryptoTests(unittest.TestCase):
    def test_message_content_round_trip(self) -> None:
        bot = generate_key_pair()
        user = generate_key_pair()
        ciphertext, payload = encrypt_content(
            {
                "text": "secret",
                "replyMarkup": {
                    "inline_keyboard": [
                        [{"text": "Yes", "callback_data": "yes"}]
                    ]
                },
            },
            [DeviceKey("user:test", user.public_key)],
        )
        opened = decrypt_content(
            ciphertext,
            payload,
            "user:test",
            user,
        )
        self.assertEqual(opened["text"], "secret")
        self.assertEqual(
            opened["replyMarkup"]["inline_keyboard"][0][0]["callback_data"],
            "yes",
        )

    def test_callback_data_round_trip(self) -> None:
        bot = generate_key_pair()
        encrypted = encrypt_callback_data("yes", bot.public_key)
        self.assertTrue(encrypted.startswith("fcbenc:"))
        self.assertEqual(decrypt_callback_data(encrypted, bot), "yes")

    def test_reply_markup_encrypts_callback_data(self) -> None:
        bot = generate_key_pair()
        markup = encrypt_reply_markup(
            {
                "inline_keyboard": [
                    [
                        {"text": "Yes", "callback_data": "yes"},
                        {"text": "Site", "url": "https://example.com"},
                    ]
                ]
            },
            bot.public_key,
        )
        self.assertIsNotNone(markup)
        buttons = markup["inline_keyboard"][0]
        self.assertTrue(buttons[0]["callback_data"].startswith("fcbenc:"))
        self.assertEqual(buttons[1]["url"], "https://example.com")

    def test_file_round_trip(self) -> None:
        from fastchat_bot.crypto import (
            decrypt_file_bytes,
            encrypt_file_bytes,
            generate_file_key,
        )

        key = generate_file_key()
        plaintext = b"attachment bytes"
        encrypted = encrypt_file_bytes(plaintext, key)
        self.assertNotEqual(encrypted, plaintext)
        self.assertEqual(decrypt_file_bytes(encrypted, key), plaintext)

    def test_v2_message_with_identity_signature(self) -> None:
        bot = generate_key_pair()
        sender = generate_key_pair()
        identity = SigningKey.generate()

        binding = {"chatId": "c1", "messageId": "m1", "fromId": "user:test"}
        aad = "c1|m1|user:test|"
        nonce = os.urandom(24)
        msg_key = os.urandom(32)
        ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(
            json.dumps({"text": "v2 secret"}).encode(),
            aad.encode(),
            nonce,
            msg_key,
        )
        def unb64(value: str) -> bytes:
            return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

        box = crypto_box_easy(
            msg_key,
            nonce,
            unb64(bot.public_key),
            unb64(sender.private_key),
        )
        signature = identity.sign(f"{aad}|{sender.public_key}".encode()).signature
        payload = json.dumps(
            {
                "v": 2,
                "nonce": base64.b64encode(nonce).decode(),
                "senderKey": sender.public_key,
                "identityKey": base64.b64encode(bytes(identity.verify_key)).decode(),
                "identitySig": base64.b64encode(signature).decode(),
                "envelopes": [
                    {
                        "keyId": "user:test",
                        "box": base64.b64encode(box).decode(),
                        "nonce": base64.b64encode(nonce).decode(),
                    }
                ],
            }
        )

        opened = decrypt_content(
            base64.b64encode(ciphertext).decode(), payload, "user:test", bot, binding
        )
        self.assertEqual(opened["text"], "v2 secret")

        with self.assertRaises(ValueError):
            decrypt_content(
                base64.b64encode(ciphertext).decode(),
                payload,
                "user:test",
                bot,
                {**binding, "chatId": "other"},
            )


if __name__ == "__main__":
    unittest.main()
