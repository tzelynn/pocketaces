"""PDF text extraction."""

from __future__ import annotations

import io

import pdfplumber


def pdf_text(data: bytes) -> str:
    """Plain text of every page, pages separated by form feeds."""
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return "\f".join((p.extract_text() or "") for p in pdf.pages)
