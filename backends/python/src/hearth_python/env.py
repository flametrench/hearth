from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Env:
    port: int
    database_url: str
    smtp_host: str
    smtp_port: int
    smtp_from: str
    hearth_public_base_url: str


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def load_env() -> Env:
    return Env(
        port=int(os.environ.get("PORT", "5003")),
        database_url=_required("DATABASE_URL"),
        smtp_host=os.environ.get("SMTP_HOST", "localhost"),
        smtp_port=int(os.environ.get("SMTP_PORT", "1025")),
        smtp_from=os.environ.get("SMTP_FROM", "hearth@localhost"),
        hearth_public_base_url=os.environ.get(
            "HEARTH_PUBLIC_BASE_URL", "http://localhost:3000"
        ),
    )
