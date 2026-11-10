#!/usr/bin/env python3
"""Write news.json from the publisher feeds.

The browser only reads this file. It does not call a third-party converter.
"""

from __future__ import annotations

import gzip
import json
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

UA = "ThinkInfoSec-Signal/1.0 (+https://github.com/ThinkInfoSec/Signal)"
MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000
PER_FEED = 8
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "news.json"

FEEDS = [
    {"name": "BleepingComputer", "cat": "cyber", "url": "https://www.bleepingcomputer.com/feed/"},
    {"name": "The Hacker News", "cat": "cyber", "url": "https://feeds.feedburner.com/TheHackersNews"},
    {"name": "Krebs on Security", "cat": "cyber", "url": "https://krebsonsecurity.com/feed/"},
    {"name": "BBC World", "cat": "geo", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
    {"name": "Al Jazeera", "cat": "geo", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
    {"name": "RNZ World", "cat": "geo", "url": "https://www.rnz.co.nz/rss/world.xml"},
    # Labs for releases, models, and research; newsrooms for what shipped and the money.
    {"name": "OpenAI", "cat": "ai", "url": "https://openai.com/news/rss.xml"},
    {"name": "Google DeepMind", "cat": "ai", "url": "https://deepmind.google/blog/rss.xml"},
    {"name": "Google AI", "cat": "ai", "url": "https://blog.google/technology/ai/rss/"},
    {"name": "NVIDIA", "cat": "ai", "url": "https://blogs.nvidia.com/feed/"},
    {"name": "Hugging Face", "cat": "ai", "url": "https://huggingface.co/blog/feed.xml"},
    {"name": "MIT Technology Review", "cat": "ai", "url": "https://www.technologyreview.com/topic/artificial-intelligence/feed"},
    {"name": "Ars Technica", "cat": "ai", "url": "https://arstechnica.com/ai/feed/"},
    {"name": "Financial Times", "cat": "ai", "url": "https://www.ft.com/artificial-intelligence?format=rss"},
]


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in ("script", "style"):
            self.skip += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


def strip_html(value: str) -> str:
    parser = TextExtractor()
    parser.feed(value or "")
    parser.close()
    return " ".join("".join(parser.parts).split())


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(parent: ET.Element, name: str) -> str:
    for node in parent:
        if local_name(node.tag) == name:
            return "".join(node.itertext())
    return ""


def parse_ts(value: str) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (TypeError, ValueError, IndexError, OverflowError):
        pass
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except ValueError:
        return None


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            "Accept-Encoding": "gzip, identity",
        },
    )
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read()
            if data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            return data
        except Exception as exc:  # a cut connection should not drop the feed
            last_error = exc
            if attempt == 0:
                time.sleep(1)
    assert last_error is not None
    raise last_error


def items_from_feed(feed: dict, raw: bytes, now_ms: int) -> list[dict]:
    root = ET.fromstring(raw)
    nodes = [node for node in root.iter() if local_name(node.tag) in ("item", "entry")]
    kept: list[dict] = []
    for node in nodes:
        if len(kept) >= PER_FEED:
            break
        title = strip_html(child_text(node, "title"))[:220]
        summary = strip_html(
            child_text(node, "description")
            or child_text(node, "summary")
            or child_text(node, "content")
        )[:320]
        ts = parse_ts(
            child_text(node, "pubDate")
            or child_text(node, "published")
            or child_text(node, "updated")
            or child_text(node, "date")
        )
        if not title or ts is None or ts < now_ms - MAX_AGE_MS:
            continue
        kept.append(
            {
                "source": feed["name"],
                "cat": feed["cat"],
                "title": title,
                "summary": summary,
                "ts": ts,
            }
        )
    return kept


def main() -> int:
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    items: list[dict] = []
    failures: list[str] = []
    for feed in FEEDS:
        try:
            items.extend(items_from_feed(feed, fetch(feed["url"]), now_ms))
            print(f"ok  {feed['name']}")
        except Exception as exc:  # a dead feed should not wipe the snapshot
            failures.append(f"{feed['name']}: {exc}")
            print(f"err {feed['name']}: {exc}", file=sys.stderr)
    if not items:
        print("no items fetched; leaving news.json unchanged", file=sys.stderr)
        return 1
    items.sort(key=lambda item: item["ts"], reverse=True)
    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": items,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(items)} items, {len(failures)} feed errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
