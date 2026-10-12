"""Outbound HTTP client construction.

TLS is always verified. By default the operating system's trust store is used (via
``truststore``), so machines whose network re-signs HTTPS with a locally trusted root CA
(corporate proxy / antivirus) still verify correctly. Set USE_SYSTEM_TRUST_STORE=false to use
certifi's bundle instead. Verification is never disabled.
"""

from __future__ import annotations

import os
import ssl
from typing import Union

import httpx


def tls_verify() -> Union[ssl.SSLContext, bool]:
    if os.environ.get("USE_SYSTEM_TRUST_STORE", "true").strip().lower() in ("0", "false", "no", "off"):
        return True
    try:
        import truststore
    except ImportError:
        return True
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


def async_client(timeout: float, *, connect: float = 10.0, follow_redirects: bool = False) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=connect), verify=tls_verify(),
                             follow_redirects=follow_redirects)
