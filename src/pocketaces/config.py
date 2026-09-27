"""Loading of YAML config files in config/."""

from __future__ import annotations

from functools import cache
from typing import Any

import yaml

from . import paths


@cache
def load(name: str) -> dict[str, Any]:
    path = paths.CONFIG / f"{name}.yaml"
    with path.open() as f:
        return yaml.safe_load(f) or {}


def sources() -> dict[str, Any]:
    return load("sources")


def cards() -> list[dict[str, Any]]:
    return load("cards").get("cards", [])


def active_cards() -> list[dict[str, Any]]:
    """Registry cards still offered (entries with `status: discontinued` are kept for history)."""
    return [c for c in cards() if c.get("status", "active") != "discontinued"]


def categories() -> dict[str, Any]:
    return load("categories").get("categories", {})
