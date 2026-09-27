"""Filesystem layout. Everything is relative to the repo root (override with POCKETACES_ROOT)."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("POCKETACES_ROOT", Path(__file__).resolve().parents[2]))

CONFIG = ROOT / "config"
DATA = ROOT / "data"
RAW = DATA / "raw"
STAGING = DATA / "staging"
CURATED_CARDS = DATA / "curated" / "cards"
REFERENCE = DATA / "reference"
BUILD = DATA / "build"
