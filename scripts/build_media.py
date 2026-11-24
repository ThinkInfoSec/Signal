"""Build media.json from the Medium and YouTube feeds.

Items are merged by id and never dropped, so the archive grows past the
10 to 15 items each feed returns. The file is only rewritten when items change.
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_news import child_text, fetch, local_name, parse_ts, parse_xml, strip_html  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media.json"
MEDIUM_FEED = "https://medium.com/feed/@andrecamillo"
YOUTUBE_CHANNEL = "UCK5IydDSpf-Yz7qCmVjDN5Q"
YOUTUBE_FEED = f"https://www.youtube.com/feeds/videos.xml?channel_id={YOUTUBE_CHANNEL}"
SUMMARY_MAX = 240
WORDS_PER_MINUTE = 230
IMG_RE = re.compile(r'<img[^>]+src="(https://(?:cdn-images-1|miro)\.medium\.com/[^"]+)"')
MEDIUM_ID_RE = re.compile(r"-([0-9a-f]{8,12})(?:[/?#]|$)")
VIDEO_ID_RE = re.compile(r"[\w-]{11}")


def clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut + "…"


def medium_items(raw: bytes) -> list[dict]:
    root = parse_xml(raw)
    out: list[dict] = []
    for node in root.iter():
        if local_name(node.tag) != "item":
            continue
        link = child_text(node, "link").strip().split("?", 1)[0]
        title = strip_html(child_text(node, "title"))
        ts = parse_ts(child_text(node, "pubDate"))
        if not (link.startswith("https://") and title and ts):
            continue
        body = child_text(node, "encoded")
        text = strip_html(body)
        match = MEDIUM_ID_RE.search(link)
        item = {
            "id": "medium:" + (match.group(1) if match else link),
            "kind": "article",
            "title": title,
            "url": link,
            "ts": ts,
            "summary": clip(text, SUMMARY_MAX),
            "minutes": max(1, round(len(text.split()) / WORDS_PER_MINUTE)),
        }
        img = IMG_RE.search(body)
        if img:
            item["thumb"] = img.group(1)
        out.append(item)
    return out


def youtube_items(raw: bytes) -> list[dict]:
    root = parse_xml(raw)
    out: list[dict] = []
    for entry in root:
        if local_name(entry.tag) != "entry":
            continue
        vid = child_text(entry, "videoId").strip()
        title = child_text(entry, "title").strip()
        ts = parse_ts(child_text(entry, "published"))
        if not (VIDEO_ID_RE.fullmatch(vid) and title and ts):
            continue
        desc = ""
        for node in entry.iter():
            if local_name(node.tag) == "description":
                desc = "".join(node.itertext())
        out.append(
            {
                "id": "youtube:" + vid,
                "kind": "video",
                "title": title,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "ts": ts,
                "summary": clip(desc, SUMMARY_MAX),
                "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            }
        )
    return out


def merge(existing: list[dict], fresh: list[dict]) -> list[dict]:
    by_id = {item["id"]: item for item in existing if "id" in item}
    for item in fresh:
        by_id[item["id"]] = item
    return sorted(by_id.values(), key=lambda item: item.get("ts", 0), reverse=True)


def load_existing() -> list[dict]:
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
        return data["items"] if isinstance(data.get("items"), list) else []
    except (OSError, ValueError, AttributeError):
        return []


def main() -> int:
    existing = load_existing()
    fresh: list[dict] = []
    ok = 0
    for name, url, parse in (("medium", MEDIUM_FEED, medium_items), ("youtube", YOUTUBE_FEED, youtube_items)):
        try:
            got = parse(fetch(url))
            fresh.extend(got)
            ok += 1
            print(f"ok  {name}: {len(got)}")
        except Exception as exc:  # one dead feed must not wipe the archive
            print(f"err {name}: {exc}", file=sys.stderr)
    if ok == 0:
        print("no media feeds fetched; leaving media.json unchanged", file=sys.stderr)
        return 1
    items = merge(existing, fresh)
    if items == existing:
        print("media unchanged")
        return 0
    payload = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "items": items}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(items)} media items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
