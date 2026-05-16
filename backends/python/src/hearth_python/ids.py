"""Hearth-specific ID prefixes (`inst_`, `ticket_`, `comment_`).

App-defined prefixes are spec#8-supported in v0.2+.
"""

from __future__ import annotations

import uuid
from typing import Literal

HearthPrefix = Literal["inst", "ticket", "comment"]


def generate_hearth_id(prefix: HearthPrefix) -> str:
    """Return a wire-format `<prefix>_<32hex>` ID."""
    u = uuid.uuid7() if hasattr(uuid, "uuid7") else _uuid7_fallback()
    return f"{prefix}_{u.hex}"


def uuid_from_hearth_id(id_: str) -> str:
    sep = id_.find("_")
    if sep == -1:
        raise ValueError(f"Malformed Hearth id: {id_}")
    hex_ = id_[sep + 1 :]
    if len(hex_) != 32 or not all(c in "0123456789abcdef" for c in hex_):
        raise ValueError(f"Malformed Hearth id payload: {id_}")
    return f"{hex_[0:8]}-{hex_[8:12]}-{hex_[12:16]}-{hex_[16:20]}-{hex_[20:]}"


def uuid_to_wire(prefix: str, uuid_str: str) -> str:
    return f"{prefix}_{uuid_str.replace('-', '')}"


def normalize_object_id_to_uuid(object_id: str) -> str:
    """Accept either dashed UUID or `<prefix>_<32hex>` wire format.

    Mirrors customer.ts normalizeObjectIdToUuid — the PostgresShareStore SDK
    returns objectId as a raw UUID (no prefix, dashed). The customer routes
    received this in either shape historically; this helper normalises.
    """
    import re

    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", object_id):
        return object_id
    return uuid_from_hearth_id(object_id)


def _uuid7_fallback():  # pragma: no cover - Python <3.14
    try:
        from uuid_extensions import uuid7  # type: ignore[import-not-found]

        return uuid.UUID(str(uuid7()))
    except ImportError as exc:
        raise RuntimeError(
            "uuid.uuid7() unavailable; install uuid7 or run on Python 3.14+"
        ) from exc
