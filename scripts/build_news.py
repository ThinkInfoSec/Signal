#!/usr/bin/env python3
"""Write news.json from the publisher feeds.

The browser only reads this file. It does not call a third-party converter.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from xml.parsers import expat
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

UA = "ThinkInfoSec-Signal/1.0 (+https://github.com/ThinkInfoSec/Signal)"
MAX_FEED_BYTES = 5_000_000
MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000
PER_FEED = 8
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "news.json"
CACHE = ROOT / "image-cache.json"
MAX_PAGE_BYTES = 512_000
OG_FETCH_LIMIT = 30

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


def gunzip_capped(data: bytes, limit: int = MAX_FEED_BYTES) -> bytes:
    """Decompress gzip without letting a small bomb expand past the feed size cap."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = d.decompress(data, limit + 1)
    if len(out) > limit or d.unconsumed_tail:
        raise ValueError("decompressed feed exceeds size limit")
    return out


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
                data = response.read(MAX_FEED_BYTES + 1)
            if len(data) > MAX_FEED_BYTES:
                raise ValueError("feed exceeds size limit")
            if data[:2] == b"\x1f\x8b":
                data = gunzip_capped(data)
            return data
        except Exception as exc:  # a cut connection should not drop the feed
            last_error = exc
            if attempt == 0:
                time.sleep(1)
    assert last_error is not None
    raise last_error


def parse_xml(raw: bytes) -> ET.Element:
    """Third-party feed: refuse DTDs so entity-expansion payloads never reach the parser."""
    # The C-accelerated ET.XMLParser hides its expat parser, so guard with a pre-pass on expat itself.
    def refuse_doctype(*_args):
        raise ValueError("feed declares a DTD; refusing to parse")

    guard = expat.ParserCreate()
    guard.StartDoctypeDeclHandler = refuse_doctype
    guard.Parse(raw, True)
    return ET.fromstring(raw)


def item_link(node: ET.Element) -> str:
    """Return an RSS <link> text or the Atom rel=alternate href, if it is https."""
    for child in node:
        if local_name(child.tag) != "link":
            continue
        href = (child.get("href") or "").strip()
        if href:
            if child.get("rel", "alternate") == "alternate" and href.startswith("https://"):
                return href
            continue
        text = "".join(child.itertext()).strip()
        if text.startswith("https://"):
            return text
    return ""


def safe_image_url(url: str) -> str:
    """Return the URL only if it is https with a host, no userinfo, and a sane length."""
    url = (url or "").strip()
    if not url or len(url) > 1000:
        return ""
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or not parts.hostname or "@" in parts.netloc:
            return ""
    except ValueError:
        return ""
    return url


class _ImgFinder(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.src = ""

    def handle_starttag(self, tag, attrs):
        if tag == "img" and not self.src:
            self.src = (dict(attrs).get("src") or "").strip()

    handle_startendtag = handle_starttag


def _first_img_src(markup: str) -> str:
    finder = _ImgFinder()
    try:
        finder.feed(markup)
    except Exception:
        pass
    return finder.src


def _width(node: ET.Element) -> int:
    try:
        return int(node.get("width") or 0)
    except ValueError:
        return 0


def item_image(node: ET.Element) -> str:
    """Best banner image: media:*, image enclosure, then first <img> in the body HTML."""
    media = []
    for child in node.iter():
        name = local_name(child.tag)
        if name == "thumbnail" and child.get("url"):
            media.append(child)
        elif name == "content" and child.get("url"):
            medium = (child.get("medium") or "").lower()
            mtype = (child.get("type") or "").lower()
            if medium == "image" or mtype.startswith("image/") or (not medium and not mtype):
                media.append(child)
    for child in sorted(media, key=_width, reverse=True):
        url = safe_image_url(child.get("url") or "")
        if url:
            return url
    for child in node:
        if local_name(child.tag) == "enclosure" and (child.get("type") or "").lower().startswith("image/"):
            url = safe_image_url(child.get("url") or "")
            if url:
                return url
    for child in node:
        if local_name(child.tag) in ("description", "content", "encoded", "summary"):
            url = safe_image_url(_first_img_src("".join(child.itertext())))
            if url:
                return url
    return ""


class _OgFinder(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.og = ""
        self.twitter = ""
        self.done = False

    def handle_starttag(self, tag, attrs):
        if tag == "meta" and not self.done:
            a = {k: (v or "") for k, v in attrs}
            key = (a.get("property") or a.get("name") or "").lower()
            if key == "og:image" and not self.og:
                self.og = a.get("content", "").strip()
            elif key == "twitter:image" and not self.twitter:
                self.twitter = a.get("content", "").strip()

    def handle_endtag(self, tag):
        if tag == "head":
            self.done = True


def og_image(link: str) -> str:
    """Read og:image / twitter:image from an article's <head>. Any failure returns ''."""
    try:
        if not link.startswith("https://"):
            return ""
        request = urllib.request.Request(
            link,
            headers={"User-Agent": UA, "Accept": "text/html", "Accept-Encoding": "gzip, identity"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            data = response.read(MAX_PAGE_BYTES + 1)
        if data[:2] == b"\x1f\x8b":
            data = gunzip_capped(data, MAX_PAGE_BYTES)
        data = data[:MAX_PAGE_BYTES]
        finder = _OgFinder()
        for start in range(0, len(data), 4096):
            finder.feed(data[start:start + 4096].decode("utf-8", "replace"))
            if finder.done:
                break
        raw = finder.og or finder.twitter
        return safe_image_url(urllib.parse.urljoin(link, raw)) if raw else ""
    except Exception:
        return ""


def load_cache(path: Path = CACHE) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
    except Exception:
        pass
    return {}


def add_og_images(items: list[dict], cache: dict, fetcher=None, limit: int = OG_FETCH_LIMIT) -> dict:
    """Fill missing images from cache, then og:image (newest first, capped). Returns the pruned cache."""
    fetcher = fetcher or og_image
    fetched = 0
    for item in sorted(items, key=lambda i: i["ts"], reverse=True):
        link = item.get("link")
        if not link or item.get("image"):
            continue
        if link in cache:
            image = cache[link]
        elif fetched < limit:
            fetched += 1
            image = fetcher(link)
            cache[link] = image
        else:
            continue
        if image:
            item["image"] = image
    return {i["link"]: i.get("image", "") for i in items if i.get("link") and (i["link"] in cache or i.get("image"))}


def items_from_feed(feed: dict, raw: bytes, now_ms: int) -> list[dict]:
    root = parse_xml(raw)
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
        item = {
            "source": feed["name"],
            "cat": feed["cat"],
            "title": title,
            "summary": summary,
            "ts": ts,
        }
        link = item_link(node)
        if link:
            item["link"] = link
        image = item_image(node)
        if image:
            item["image"] = image
        kept.append(item)
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
    cache = add_og_images(items, load_cache())
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": items,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(items)} items, {len(failures)} feed errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
