from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from fastchat_bot import BotAPIError, BotClient


class _Response:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self) -> bytes:
        return self.payload


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = BotClient("token", "http://fastchat.test")
        self.client._mode = "server"

    def test_get_me(self) -> None:
        payload = {
            "ok": True,
            "result": {
                "id": "weather_bot:test",
                "username": "weather_bot",
                "display_name": "Weather",
                "is_bot": True,
            },
        }
        with patch(
            "fastchat_bot.client.urllib.request.urlopen",
            return_value=_Response(json.dumps(payload).encode()),
        ):
            me = self.client.get_me()
        self.assertEqual(me.id, "weather_bot:test")
        self.assertEqual(me.username, "weather_bot")
        self.assertEqual(me.display_name, "Weather")

    def test_get_updates_maps_message_and_callback(self) -> None:
        payload = {
            "ok": True,
            "result": [
                {
                    "update_id": 7,
                    "message": {
                        "message_id": "m1",
                        "chat_id": "c1",
                        "from": {
                            "id": "alice:test",
                            "username": "alice",
                            "display_name": "Alice",
                            "is_bot": False,
                        },
                        "text": "hi",
                        "files": None,
                        "date": "2026-01-01T00:00:00Z",
                    },
                },
                {
                    "update_id": 8,
                    "callback_query": {
                        "id": "q1",
                        "from": {
                            "id": "alice:test",
                            "username": "alice",
                            "display_name": "Alice",
                        },
                        "message_id": "m1",
                        "chat_id": "c1",
                        "data": "yes",
                    },
                },
            ],
        }
        with patch(
            "fastchat_bot.client.urllib.request.urlopen",
            return_value=_Response(json.dumps(payload).encode()),
        ):
            updates = self.client.get_updates(offset=0, timeout=1)
        self.assertEqual(len(updates), 2)
        self.assertEqual(updates[0].message.text, "hi")
        self.assertEqual(updates[0].message.from_user.username, "alice")
        self.assertEqual(updates[1].callback_query.data, "yes")

    def test_send_message(self) -> None:
        payload = {
            "ok": True,
            "result": {
                "message_id": "m2",
                "chat_id": "c1",
                "from": {"id": "bot", "username": "bot", "is_bot": True},
                "text": "pong",
                "date": "2026-01-01T00:00:00Z",
            },
        }
        with patch(
            "fastchat_bot.client.urllib.request.urlopen",
            return_value=_Response(json.dumps(payload).encode()),
        ):
            message = self.client.send_message("c1", "pong")
        self.assertEqual(message.message_id, "m2")
        self.assertEqual(message.text, "pong")

    def test_upload_file_sends_multipart(self) -> None:
        payload = {
            "ok": True,
            "file": {
                "id": "f1",
                "originalName": "hello.txt",
                "mimeType": "text/plain",
                "size": 5,
            },
        }
        with patch(
            "fastchat_bot.client.urllib.request.urlopen",
            return_value=_Response(json.dumps(payload).encode()),
        ) as urlopen:
            file = self.client.upload_file(b"hello", "hello.txt", "text/plain")
        self.assertEqual(file.id, "f1")
        request = urlopen.call_args.args[0]
        self.assertIn(b'name="file"', request.data)
        self.assertIn(b"hello", request.data)

    def test_http_error_becomes_bot_api_error(self) -> None:
        error = urllib.error.HTTPError(
            "http://fastchat.test/api/bot-api/getMe",
            401,
            "Unauthorized",
            {},
            io.BytesIO(b'{"error":"bad token"}'),
        )
        with patch(
            "fastchat_bot.client.urllib.request.urlopen", side_effect=error
        ):
            with self.assertRaises(BotAPIError) as raised:
                self.client.get_me()
        self.assertEqual(raised.exception.status, 401)


if __name__ == "__main__":
    unittest.main()
