"""Decoders for data embedded in server-rendered JS framework pages.

Parsing these payloads instead of the rendered DOM keeps scrapers working across visual redesigns.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

# -- Next.js App Router (React Server Components "flight" data) ----------------------------------

_FLIGHT_RE = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', re.S)


def next_flight_text(html: str) -> str:
    """Concatenate and unescape all `self.__next_f.push([1, "..."])` chunks."""
    return "".join(json.loads(f'"{c}"') for c in _FLIGHT_RE.findall(html))


def iter_json_objects(text: str, marker: str) -> Iterator[dict[str, Any]]:
    """Yield every JSON object in `text` that directly contains `marker` (e.g. '"product_name":').

    Walks outwards from each marker to the enclosing `{`, then parses a balanced object. Objects are
    de-duplicated by span, so nested matches are yielded once each.
    """
    seen: set[int] = set()
    for m in re.finditer(re.escape(marker), text):
        start = _enclosing_brace(text, m.start())
        if start is None or start in seen:
            continue
        end = _matching_brace(text, start)
        if end is None:
            continue
        seen.add(start)
        try:
            yield json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            continue


def _enclosing_brace(text: str, pos: int) -> int | None:
    depth = 0
    in_str = False
    i = pos - 1
    while i >= 0:
        c = text[i]
        if c == '"' and not _escaped(text, i):
            in_str = not in_str
        elif not in_str:
            if c == "}":
                depth += 1
            elif c == "{":
                if depth == 0:
                    return i
                depth -= 1
        i -= 1
    return None


def _escaped(text: str, i: int) -> bool:
    n = 0
    i -= 1
    while i >= 0 and text[i] == "\\":
        n += 1
        i -= 1
    return n % 2 == 1


def _matching_brace(text: str, start: int) -> int | None:
    depth = 0
    in_str = False
    i = start
    while i < len(text):
        c = text[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


# -- Nuxt 3 (`__NUXT_DATA__`, devalue-serialised) ------------------------------------------------

_NUXT_RE = re.compile(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', re.S)
_WRAPPERS = {"Reactive", "ShallowReactive", "Ref", "ShallowRef", "NuxtError"}


def nuxt_payload(html: str) -> Any:
    m = _NUXT_RE.search(html)
    if not m:
        raise ValueError("no __NUXT_DATA__ script in page")
    return devalue_unflatten(json.loads(m.group(1)))


def devalue_unflatten(arr: list) -> Any:
    """Rebuild a value serialised with devalue's `stringify` (used by Nuxt payloads)."""
    cache: dict[int, Any] = {}

    def hydrate(i: int) -> Any:
        if i < 0:  # devalue special values: -1 undefined, -2 hole, -3 NaN, ...
            return None
        if i in cache:
            return cache[i]
        v = arr[i]
        if isinstance(v, list):
            if v and isinstance(v[0], str):
                tag = v[0]
                if tag in _WRAPPERS:
                    cache[i] = r = hydrate(v[1])
                    return r
                if tag in ("EmptyRef", "EmptyShallowRef"):
                    cache[i] = r = json.loads(v[1]) if isinstance(v[1], str) else None
                    return r
                if tag == "Date":
                    cache[i] = v[1]
                    return v[1]
                if tag == "Set":
                    cache[i] = out = []
                    out.extend(hydrate(x) for x in v[1:])
                    return out
                if tag == "Map":
                    cache[i] = out = {}
                    for k, x in zip(v[1::2], v[2::2]):
                        out[str(hydrate(k))] = hydrate(x)
                    return out
            cache[i] = out = []
            out.extend(hydrate(x) if isinstance(x, int) else x for x in v)
            return out
        if isinstance(v, dict):
            cache[i] = out = {}
            for k, x in v.items():
                out[k] = hydrate(x) if isinstance(x, int) else x
            return out
        return v

    return hydrate(0)


_ROW_ID = re.compile(rb"([0-9a-f]+):")


def flight_text_chunks(flight: str) -> dict[str, str]:
    """Map RSC text-chunk ids to their contents (`"$1d"` in a JSON object refers to chunk `1d`).

    The flight stream is a sequence of rows: `<id>:<payload>\n`, except text rows
    `<id>:T<hex byte length>,<text>` which have no terminator, so rows are walked sequentially.
    """
    data = flight.encode()
    out: dict[str, str] = {}
    pos = 0
    while pos < len(data):
        m = _ROW_ID.match(data, pos)
        if not m:  # not at a row boundary; skip to the next line
            nl = data.find(b"\n", pos)
            if nl < 0:
                break
            pos = nl + 1
            continue
        body = m.end()
        if data[body : body + 1] == b"T":
            comma = data.find(b",", body)
            length = int(data[body + 1 : comma], 16)
            out[m.group(1).decode()] = data[comma + 1 : comma + 1 + length].decode(errors="replace")
            pos = comma + 1 + length
        else:
            nl = data.find(b"\n", body)
            pos = len(data) if nl < 0 else nl + 1
    return out


def resolve_ref(value: Any, chunks: dict[str, str]) -> Any:
    """Resolve '$<hex>' text references; map '$undefined' to None; leave other values alone."""
    if isinstance(value, str) and value.startswith("$"):
        if value == "$undefined":
            return None
        return chunks.get(value[1:], value)
    return value
