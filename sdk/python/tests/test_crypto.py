from __future__ import annotations

import unittest

from fastchat_bot.crypto import (
    DeviceKey,
    decrypt_callback_data,
    decrypt_content,
    encrypt_callback_data,
    encrypt_content,
    encrypt_reply_markup,
    generate_key_pair,
    generate_signing_key_pair,
)

BINDING = {"chatId": "c1", "messageId": "m1", "fromId": "bot:test"}


class CryptoTests(unittest.TestCase):
    def test_message_content_round_trip(self) -> None:
        bot = generate_key_pair()
        identity = generate_signing_key_pair()
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
            [DeviceKey("user:test", user.public_key, 1)],
            sender_key=bot,
            identity_key=identity,
            binding=BINDING,
        )
        opened = decrypt_content(
            ciphertext,
            payload,
            "user:test",
            user,
            BINDING,
        )
        self.assertEqual(opened["text"], "secret")
        self.assertEqual(
            opened["replyMarkup"]["inline_keyboard"][0][0]["callback_data"],
            "yes",
        )

    def test_moved_message_fails_binding_check(self) -> None:
        bot = generate_key_pair()
        identity = generate_signing_key_pair()
        user = generate_key_pair()
        ciphertext, payload = encrypt_content(
            {"text": "secret"},
            [DeviceKey("user:test", user.public_key, 1)],
            sender_key=bot,
            identity_key=identity,
            binding=BINDING,
        )
        with self.assertRaises(ValueError):
            decrypt_content(
                ciphertext,
                payload,
                "user:test",
                user,
                {**BINDING, "chatId": "other"},
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


if __name__ == "__main__":
    unittest.main()
