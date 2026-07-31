"""媒体生成与安全下载代理接口。"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from collections.abc import AsyncIterator
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from backend.schemas.media import MediaGenerateBody
from backend.services.media.dashscope import generate_media

router = APIRouter(tags=["media"])

MAX_REDIRECTS = 5
MAX_MEDIA_BYTES = 512 * 1024 * 1024
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}


def _qwen_key(request: Request) -> str:
    """读取当前媒体请求可用的百炼 API Key。

    优先使用前端通过请求头传来的临时 Key；请求头没有提供时，再读取后端环境变量。
    函数只返回值，不把密钥写入日志。
    """

    return (
        request.headers.get("x-llm-key-qwen", "").strip()
        or os.getenv("DASHSCOPE_API_KEY", "").strip()
    )


def _is_forbidden_ip(address: str) -> bool:
    """判断一个 IP 是否属于不应被下载代理访问的本机或内部网络。

    这项检查用于防止恶意 URL 借助媒体下载接口访问 ``localhost``、局域网、
    云平台元数据地址等内部资源，也就是常见的 SSRF 风险。
    """

    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return True
    return any(
        (
            parsed.is_private,
            parsed.is_loopback,
            parsed.is_link_local,
            parsed.is_multicast,
            parsed.is_reserved,
            parsed.is_unspecified,
        )
    )


def _resolve_host_addresses(hostname: str, port: int) -> set[str]:
    """同步解析域名对应的全部 IP 地址。

    ``socket.getaddrinfo`` 是阻塞操作，因此调用方会使用 ``asyncio.to_thread``
    把它放到工作线程执行，避免阻塞 FastAPI 的事件循环。
    """

    records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    return {str(record[4][0]) for record in records}


async def _validate_public_http_url(url: str) -> None:
    """校验下载 URL，并确认其域名不会解析到内部网络地址。

    每次发生重定向后都会重新执行本函数，防止公开域名先通过检查、再跳转到
    ``127.0.0.1`` 或私有网段。
    """

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=400, detail="只允许下载有效的 http/https 地址")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="下载地址不允许包含用户名或密码")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise HTTPException(status_code=400, detail="不允许访问本机地址")

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="下载地址端口格式不正确") from exc
    try:
        addresses = await asyncio.to_thread(_resolve_host_addresses, hostname, port)
    except (OSError, socket.gaierror) as exc:
        raise HTTPException(status_code=400, detail="下载地址的域名无法解析") from exc
    if not addresses or any(_is_forbidden_ip(address) for address in addresses):
        raise HTTPException(status_code=400, detail="不允许访问本机或内部网络地址")


async def _open_remote_media(
    client: httpx.AsyncClient,
    initial_url: str,
) -> httpx.Response:
    """安全地打开远程媒体，并逐次检查可能出现的重定向地址。

    返回值保持流式打开状态，调用方必须在发送结束后关闭 Response 和 Client。
    """

    current_url = initial_url
    for redirect_index in range(MAX_REDIRECTS + 1):
        await _validate_public_http_url(current_url)
        request = client.build_request("GET", current_url)
        try:
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="连接远程媒体地址失败") from exc

        if response.status_code not in REDIRECT_STATUS_CODES:
            return response

        location = response.headers.get("location", "").strip()
        await response.aclose()
        if not location:
            raise HTTPException(status_code=502, detail="远程媒体返回了无效重定向")
        if redirect_index >= MAX_REDIRECTS:
            raise HTTPException(status_code=502, detail="远程媒体重定向次数过多")
        current_url = urljoin(current_url, location)

    raise HTTPException(status_code=502, detail="远程媒体重定向次数过多")


async def _proxy_stream(
    response: httpx.Response,
    client: httpx.AsyncClient,
) -> AsyncIterator[bytes]:
    """把远程媒体分块转发给前端，并在结束或异常时释放网络连接。"""

    try:
        async for chunk in response.aiter_bytes():
            yield chunk
    finally:
        await response.aclose()
        await client.aclose()


@router.post("/api/media/generate")
async def post_media_generate(
    body: MediaGenerateBody,
    request: Request,
) -> dict[str, object]:
    """调用百炼生成图片或视频，并返回前端统一的附件数据结构。"""

    api_key = _qwen_key(request)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置百炼 API Key")
    try:
        return await generate_media(body, api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/media/download")
async def get_media_download(url: str = Query(...)) -> StreamingResponse:
    """安全代理公开网络上的媒体下载，避免 Electron 页面遇到跨域限制。"""

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=20.0),
        follow_redirects=False,
        trust_env=False,
    )
    try:
        response = await _open_remote_media(client, url)
        if response.status_code >= 400:
            status_code = response.status_code
            await response.aclose()
            await client.aclose()
            raise HTTPException(status_code=status_code, detail="远程媒体下载失败")

        content_length = response.headers.get("content-length", "").strip()
        if content_length.isdigit() and int(content_length) > MAX_MEDIA_BYTES:
            await response.aclose()
            await client.aclose()
            raise HTTPException(status_code=413, detail="远程媒体文件超过 512 MB 限制")

        media_type = response.headers.get("content-type", "application/octet-stream")
        return StreamingResponse(
            _proxy_stream(response, client),
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=300"},
        )
    except Exception:
        if not client.is_closed:
            await client.aclose()
        raise
