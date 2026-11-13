import json

import pytest
from starlette.testclient import TestClient

from cicd_agent.clients import InfrastructureError, ScriptedChatClient, is_infrastructure_error
from cicd_agent.server import MAX_FILES, RequestError, create_app, parse_request, validate_path, write_workspace

KEY = "k" * 32
AUTH = {"Authorization": f"Bearer {KEY}"}


@pytest.mark.parametrize("raw,clean", [
    (".github/workflows/ci.yml", ".github/workflows/ci.yml"),
    ("a//b.txt", "a/b.txt"),
    ("./a", "a"),
    ("package.json", "package.json"),
])
def test_validate_path_accepts_plain_relative_paths(raw, clean):
    assert validate_path(raw) == clean


@pytest.mark.parametrize("raw", [
    "", None, 7, "x" * 201, "/etc/passwd", "..\\x", "c:/x", "a\x00b", "../x", "a/../b",
    "nul", "con.txt", "COM1.yml", "a/lpt9", "-flag", "/".join(["d"] * 13),
])
def test_validate_path_rejects_unsafe_paths(raw):
    with pytest.raises(RequestError) as error:
        validate_path(raw)
    assert error.value.status == 400


def body(**data) -> bytes:
    return json.dumps(data).encode()


@pytest.mark.parametrize("raw,status", [
    (b"x" * (512 * 1024 + 1), 413),
    (b"not json", 400),
    (b"[]", 400),
    (body(message="hi", extra=1), 400),
    (body(message="   "), 400),
    (body(message="x" * 16_001), 400),
    (body(message="hi", files={"a": "b"}), 400),
    (body(message="hi", files=[{"path": "a"}] * (MAX_FILES + 1)), 400),
    (body(message="hi", files=[{"path": "a", "text": 1}]), 400),
    (body(message="hi", files=[{"path": "A.yml", "text": ""}, {"path": "a.yml", "text": ""}]), 400),
    (body(message="hi", files=[{"path": f"f{i}", "text": "x" * 20_000} for i in range(14)]), 413),
])
def test_parse_request_status_codes(raw, status):
    with pytest.raises(RequestError) as error:
        parse_request(raw)
    assert error.value.status == status


def test_parse_request_and_write_workspace(tmp_path):
    message, files = parse_request(body(message="lint", files=[{"path": ".github/workflows/ci.yml", "text": "on: push"}]))
    assert message == "lint" and files == {".github/workflows/ci.yml": "on: push"}
    write_workspace(tmp_path, files)
    assert (tmp_path / ".github" / "workflows" / "ci.yml").read_text() == "on: push"


def test_short_api_key_fails_closed():
    with pytest.raises(RuntimeError):
        create_app(api_key="short", client_factory=lambda: None)


def app(factory, monkeypatch, **kwargs):
    monkeypatch.delenv("AGL_SERVER_URL", raising=False)
    return TestClient(create_app(api_key=KEY, client_factory=factory, model_name="test", **kwargs))


def test_chat_requires_bearer_and_valid_body(monkeypatch):
    with app(lambda: ScriptedChatClient([("text", "unused")]), monkeypatch) as client:
        health = client.get("/healthz")
        assert health.status_code in (200, 503) and health.json()["model"] == "test"
        denied = client.post("/chat", json={"message": "hi"}, headers={"Authorization": "Bearer wrong"})
        assert denied.status_code == 401 and denied.headers["www-authenticate"] == "Bearer"
        assert client.post("/chat", json={"message": "hi"}).status_code == 401
        assert client.post("/chat", content=b"nope", headers=AUTH).status_code == 400


def test_chat_answers_without_files(monkeypatch):
    with app(lambda: ScriptedChatClient([("text", "hello there")]), monkeypatch) as client:
        reply = client.post("/chat", json={"message": "hi"}, headers=AUTH)
    assert reply.status_code == 200
    data = reply.json()
    assert data["mode"] == "chat" and data["text"] == "hello there" and data["toolCalls"] == []


def test_infrastructure_errors_become_502_without_details(monkeypatch):
    def factory():
        raise InfrastructureError("https://secret.example/internal returned text/plain")

    with app(factory, monkeypatch) as client:
        reply = client.post("/chat", json={"message": "hi"}, headers=AUTH)
    assert reply.status_code == 502
    assert "secret" not in reply.text


def test_is_infrastructure_error_walks_the_cause_chain():
    try:
        try:
            raise InfrastructureError("route")
        except InfrastructureError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as outer:
        assert is_infrastructure_error(outer)
    assert not is_infrastructure_error(ValueError("model answer"))
