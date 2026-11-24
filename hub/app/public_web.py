"""Bounded HTTPS reads of public music pages and audio; pin the checked DNS address."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from contextlib import asynccontextmanager

import httpx


async def public_address(url: str) -> tuple[httpx.URL, str]:
    target = httpx.URL(url)
    if target.scheme != "https" or not target.host or target.port not in (None, 443) or target.userinfo:
        raise ValueError("Нужна публичная HTTPS-ссылка без пароля и нестандартного порта")
    addresses = await asyncio.to_thread(socket.getaddrinfo, target.host, 443, type=socket.SOCK_STREAM)
    ips = list(dict.fromkeys(row[4][0] for row in addresses))
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise ValueError("Ссылки на локальные и служебные адреса запрещены")
    # IPv4 is available on more home servers. TLS still verifies the original hostname.
    return target, next((ip for ip in ips if ":" not in ip), ips[0])


@asynccontextmanager
async def public_stream(url: str):
    async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=15), trust_env=False) as client:
        for _ in range(5):
            target, address = await public_address(url)
            async with client.stream("GET", target.copy_with(host=address),
                                     headers={"Host": target.host, "User-Agent": "HomeMusic/1.0 (music research)"},
                                     extensions={"sni_hostname": target.host}) as response:
                if response.is_redirect:
                    url = str(target.join(response.headers["location"]))
                    continue
                response.raise_for_status()
                yield response
                return
        raise ValueError("Слишком много перенаправлений")


async def public_read(url: str, limit: int = 2 * 1024 * 1024) -> bytes:
    data = bytearray()
    async with public_stream(url) as response:
        async for chunk in response.aiter_bytes():
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError("Страница слишком большая")
    return bytes(data)
