from __future__ import annotations

import asyncio
import os
from typing import Any
from urllib.parse import urlparse

import yt_dlp
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field, HttpUrl


ALLOWED_DOMAINS = {
    "b23.tv",
    "bilibili.com",
    "douyin.com",
    "iesdouyin.com",
    "ixigua.com",
    "tiktok.com",
    "v.douyin.com",
    "weibo.com",
    "xiaohongshu.com",
    "xhslink.com",
}


class ParseRequest(BaseModel):
    url: HttpUrl = Field(description="你有权处理的公开视频分享链接")


class VideoInfo(BaseModel):
    title: str
    cover_url: str | None = None
    video_url: str
    webpage_url: str
    platform: str | None = None
    uploader: str | None = None
    duration: float | None = None
    note: str = "媒体地址可能会过期，请在解析后及时使用。"


class HealthResponse(BaseModel):
    status: str


def _host_is_allowed(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.lower().rstrip(".")
    return any(
        normalized == domain or normalized.endswith(f".{domain}")
        for domain in ALLOWED_DOMAINS
    )


def _verify_service_token(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> None:
    expected = os.getenv("SERVICE_TOKEN", "").strip()
    if not expected:
        return

    bearer = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()

    if x_api_key != expected and bearer != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效或缺失的服务访问口令",
        )


def _select_video_url(info: dict[str, Any]) -> str | None:
    direct_url = info.get("url")
    if direct_url and info.get("vcodec") != "none":
        return str(direct_url)

    formats = info.get("formats") or []
    candidates = [
        item
        for item in formats
        if item.get("url")
        and item.get("vcodec") not in (None, "none")
        and item.get("acodec") not in (None, "none")
    ]
    candidates.sort(
        key=lambda item: (
            item.get("ext") == "mp4",
            item.get("height") or 0,
            item.get("tbr") or 0,
        ),
        reverse=True,
    )
    return str(candidates[0]["url"]) if candidates else None


def extract_video_info(url: str) -> VideoInfo:
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "playlist_items": "1",
        "format": "best[ext=mp4]/best",
        "socket_timeout": 20,
        "retries": 1,
        "extractor_retries": 1,
        "cachedir": False,
    }

    with yt_dlp.YoutubeDL(options) as downloader:
        raw_info = downloader.extract_info(url, download=False)

    if raw_info.get("_type") in {"playlist", "multi_video"}:
        entries = [entry for entry in raw_info.get("entries") or [] if entry]
        if not entries:
            raise ValueError("链接中没有可解析的视频")
        raw_info = entries[0]

    video_url = _select_video_url(raw_info)
    if not video_url:
        raise ValueError("没有找到可直接使用的视频媒体地址")

    return VideoInfo(
        title=str(raw_info.get("title") or "未命名视频"),
        cover_url=raw_info.get("thumbnail"),
        video_url=video_url,
        webpage_url=str(raw_info.get("webpage_url") or url),
        platform=raw_info.get("extractor_key") or raw_info.get("extractor"),
        uploader=raw_info.get("uploader") or raw_info.get("channel"),
        duration=raw_info.get("duration"),
    )


app = FastAPI(
    title="公开视频信息解析服务",
    version="1.0.0",
    description=(
        "解析用户有权处理的公开视频链接，返回标题、封面和可用媒体地址。"
        "不绕过登录、付费、DRM 或其他访问控制。"
    ),
)


@app.get("/health", response_model=HealthResponse, operation_id="healthCheck")
def health_check() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post(
    "/api/video/parse",
    response_model=VideoInfo,
    operation_id="parseVideoLink",
    summary="解析公开视频链接",
    dependencies=[Depends(_verify_service_token)],
)
async def parse_video_link(payload: ParseRequest) -> VideoInfo:
    url = str(payload.url)
    if not _host_is_allowed(urlparse(url).hostname):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="暂不支持该域名",
        )

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(extract_video_info, url),
            timeout=35,
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="视频平台响应超时，请稍后重试",
        ) from exc
    except yt_dlp.utils.DownloadError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"视频链接解析失败：{exc}",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
