import asyncio
import ipaddress
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent"))
import server
from fastapi.testclient import TestClient


def resolved(host, port, *_args, **_kwargs):
    try:
        address = str(ipaddress.ip_address(host))
    except ValueError:
        address = "8.8.8.8"
    return [(2, 1, 6, "", (address, port))]


class FakeStream:
    def __init__(self, address):
        self.address = address

    def get_extra_info(self, name):
        return (self.address, 443) if name == "server_addr" else None


class FakeResponse:
    def __init__(self, status, headers=None, address="8.8.8.8"):
        self.status_code = status
        self.headers = headers or {}
        self.extensions = {"network_stream": FakeStream(address)}
        self.request = object()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def aiter_bytes(self):
        yield b"ok"


class FakeClient:
    def __init__(self, response):
        self.response = response

    def stream(self, *_args, **_kwargs):
        return self.response


class SecurityTests(unittest.TestCase):
    @patch("server.socket.getaddrinfo", side_effect=resolved)
    def test_public_url_policy(self, _resolver):
        self.assertTrue(server.public_web_url("https://example.com/item"))
        for value in (
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.2/",
            "http://[::1]/",
            "https://user:pass@example.com/",
            "https://example.com:8443/",
            "file:///etc/passwd",
        ):
            self.assertFalse(server.public_web_url(value), value)

    def test_peer_address_must_be_global(self):
        public = type("R", (), {"extensions": {"network_stream": FakeStream("8.8.8.8")}})()
        private = type("R", (), {"extensions": {"network_stream": FakeStream("172.17.0.2")}})()
        self.assertTrue(server.response_peer_is_public(public))
        self.assertFalse(server.response_peer_is_public(private))

    def test_constant_time_bearer_authentication(self):
        original = server.AGENT_TOKEN
        original_configured = server.TOKEN_CONFIGURED
        server.AGENT_TOKEN = "t" * 32
        server.TOKEN_CONFIGURED = True
        try:
            self.assertTrue(server.authorized(f"Bearer {'t' * 32}"))
            self.assertFalse(server.authorized("Bearer wrong-token"))
            self.assertFalse(server.authorized(None))
        finally:
            server.AGENT_TOKEN = original
            server.TOKEN_CONFIGURED = original_configured

    def test_api_surface_requires_auth_and_hides_docs(self):
        original = server.AGENT_TOKEN
        original_configured = server.TOKEN_CONFIGURED
        server.AGENT_TOKEN = "t" * 32
        server.TOKEN_CONFIGURED = True
        try:
            client = TestClient(server.app, base_url="http://localhost")
            self.assertEqual(client.get("/health").status_code, 401)
            self.assertEqual(client.get("/health", headers={"authorization": f"Bearer {'t' * 32}"}).status_code, 200)
            self.assertEqual(client.get("/docs").status_code, 404)
            self.assertEqual(client.get("/openapi.json").status_code, 404)
            self.assertEqual(client.get("/health", headers={"host": "evil.example"}).status_code, 400)
        finally:
            server.AGENT_TOKEN = original
            server.TOKEN_CONFIGURED = original_configured

    @patch("server.socket.getaddrinfo", side_effect=resolved)
    def test_private_redirect_is_rejected(self, _resolver):
        response = FakeResponse(302, {"location": "http://127.0.0.1/private"})
        with self.assertRaises(ValueError):
            asyncio.run(server.safe_fetch_html(FakeClient(response), "https://example.com/start"))

    @patch("server.socket.getaddrinfo", side_effect=resolved)
    def test_oversized_response_is_rejected(self, _resolver):
        response = FakeResponse(200, {"content-length": str(server.MAX_RESPONSE_BYTES + 1)})
        with self.assertRaises(ValueError):
            asyncio.run(server.safe_fetch_html(FakeClient(response), "https://example.com/large"))


if __name__ == "__main__":
    unittest.main()
