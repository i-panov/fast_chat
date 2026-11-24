from __future__ import annotations

import unittest
from unittest.mock import patch

from fastchat_bot import BotClient, DeviceKey, generate_key_pair
from fastchat_bot.crypto import encrypt_content


class EncryptedClientTests(unittest.TestCase):
    def test_incoming_update_is_decrypted_and_reply_is_encrypted(self) -> None:
        bot_key = generate_key_pair()
        user_key = generate_key_pair()
        client = BotClient("token", encryption_key=bot_key)
        client._mode = "e2ee"
        client._bot_id = "bot:test"
        client._chat_users["c1"] = "user:test"

        ciphertext, payload = encrypt_content(
            {"text": "secret"},
            [DeviceKey("bot:test", bot_key.public_key)],
        )
        sent: list[dict] = []

        def fake_request(method, path, body=None, **kwargs):
            if path == "/api/bot-api/getUpdates":
                return [
                    {
                        "update_id": 1,
                        "message": {
                            "message_id": "m1",
                            "chat_id": "c1",
                            "from": {
                                "id": "user:test",
                                "username": "user",
                                "display_name": "User",
                                "is_bot": False,
                            },
                            "text": ciphertext,
                            "encrypted": True,
                            "encrypted_payload": payload,
                            "date": "2026-01-01T00:00:00Z",
                        },
                    }
                ]
            if path == "/api/bot-api/getUserDeviceKeys":
                return [{"id": "user:test", "publicKey": user_key.public_key}]
            if path == "/api/bot-api/sendMessage":
                sent.append(body or {})
                return {
                    "message_id": "m2",
                    "chat_id": "c1",
                    "from": {
                        "id": "bot:test",
                        "username": "bot",
                        "display_name": "Bot",
                        "is_bot": True,
                    },
                    "text": (body or {}).get("text", ""),
                    "date": "2026-01-01T00:00:00Z",
                }
            raise AssertionError(path)

        with patch.object(client, "_request", side_effect=fake_request):
            updates = client.get_updates()
            reply = client.send_message("c1", "pong")

        self.assertEqual(updates[0].message.text, "secret")
        self.assertEqual(reply.text, "pong")
        self.assertTrue(sent)
        self.assertTrue(sent[0]["encrypted"])
        self.assertNotEqual(sent[0]["text"], "pong")
        self.assertIn("encrypted_payload", sent[0])


    def test_malformed_callback_does_not_kill_polling(self) -> None:
        bot_key = generate_key_pair()
        client = BotClient("token", encryption_key=bot_key)
        client._bot_id = "bot:test"

        def fake_request(method, path, body=None, **kwargs):
            if path == "/api/bot-api/getUpdates":
                return [
                    {
                        "update_id": 2,
                        "callback_query": {
                            "id": "q1",
                            "from": {
                                "id": "user:test",
                                "username": "user",
                                "display_name": "User",
                                "is_bot": False,
                            },
                            "message_id": "m1",
                            "chat_id": "c1",
                            "data": "fcbenc:not-a-sealed-box",
                        },
                    }
                ]
            raise AssertionError(path)

        with patch.object(client, "_request", side_effect=fake_request):
            updates = client.get_updates()
        self.assertTrue(updates[0].callback_query.undecryptable)
        self.assertEqual(client._chat_users["c1"], "user:test")

    def test_encrypted_callback_answer_and_file_rejection(self) -> None:
        bot_key = generate_key_pair()
        user_key = generate_key_pair()
        client = BotClient("token", encryption_key=bot_key)
        client._callback_users["q1"] = "user:test"
        sent: list[dict] = []

        def fake_request(method, path, body=None, **kwargs):
            if path == "/api/bot-api/getUserDeviceKeys":
                return [{"id": "user:test", "publicKey": user_key.public_key}]
            if path == "/api/bot-api/answerCallbackQuery":
                sent.append(body or {})
                return {}
            raise AssertionError(path)

        with patch.object(client, "_request", side_effect=fake_request):
            client.answer_callback_query("q1", "done")
            with self.assertRaises(Exception):
                client.send_file("c1", "f1")

        self.assertTrue(sent[0]["encrypted"])
        self.assertNotEqual(sent[0]["text"], "done")
        self.assertIn("encrypted_payload", sent[0])

    def test_edit_rejects_attachments(self) -> None:
        client = BotClient("token", encryption_key=generate_key_pair())
        with self.assertRaises(Exception):
            client.edit_message_text("c1", "m1", "x", files=["f1"])

    def test_send_encrypted_file_attaches_file(self) -> None:
        bot_key = generate_key_pair()
        user_key = generate_key_pair()
        client = BotClient("token", encryption_key=bot_key)
        client._mode = "e2ee"
        client._chat_users["c1"] = "user:test"
        sent: list[dict] = []

        def fake_request(method, path, body=None, **kwargs):
            if path == "/api/bot-api/getUserDeviceKeys":
                return [{"id": "user:test", "publicKey": user_key.public_key}]
            if path == "/api/bot-api/uploadFile":
                return {"file": {"id": "f1", "originalName": "a.txt", "mimeType": "text/plain", "size": 3, "hash": "h"}}
            if path == "/api/bot-api/sendMessage":
                sent.append(body or {})
                return {"message_id": "m1", "chat_id": "c1", "from": {"id": "bot:test", "username": "b", "display_name": "B", "is_bot": True}, "text": "x", "date": "2026-01-01"}
            raise AssertionError(path)

        with patch.object(client, "_request", side_effect=fake_request):
            client.send_encrypted_file("c1", b"abc", "a.txt", "text/plain")
        self.assertEqual(sent[0]["files"][0]["id"], "f1")
        self.assertTrue(sent[0]["encrypted"])

if __name__ == "__main__":
    unittest.main()
