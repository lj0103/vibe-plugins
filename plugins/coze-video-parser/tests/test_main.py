from fastapi.testclient import TestClient

from app import main


client = TestClient(main.app)


def test_health_check() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_rejects_unsupported_domain() -> None:
    response = client.post(
        "/api/video/parse",
        json={"url": "https://example.com/video/1"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "暂不支持该域名"


def test_requires_configured_service_token(monkeypatch) -> None:
    monkeypatch.setenv("SERVICE_TOKEN", "local-secret")
    response = client.post(
        "/api/video/parse",
        json={"url": "https://www.bilibili.com/video/BV1xx411c7mD"},
    )
    assert response.status_code == 401


def test_returns_normalized_video_info(monkeypatch) -> None:
    monkeypatch.delenv("SERVICE_TOKEN", raising=False)

    def fake_extract(url: str) -> main.VideoInfo:
        return main.VideoInfo(
            title="测试视频",
            cover_url="https://example.com/cover.jpg",
            video_url="https://example.com/video.mp4",
            webpage_url=url,
            platform="BiliBili",
            uploader="测试作者",
            duration=12.5,
        )

    monkeypatch.setattr(main, "extract_video_info", fake_extract)
    response = client.post(
        "/api/video/parse",
        json={"url": "https://www.bilibili.com/video/BV1xx411c7mD"},
    )

    assert response.status_code == 200
    assert response.json()["title"] == "测试视频"
    assert response.json()["video_url"].endswith("video.mp4")
