import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_media  # noqa: E402

MEDIUM = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0"><channel>
<title><![CDATA[Stories by Andre Camillo on Medium]]></title>
<item>
<title><![CDATA[Agents on the estate]]></title>
<link>https://andrecamillo.medium.com/agents-on-the-estate-1a2b3c4d5e6f?source=rss-5cfa35a50265------2</link>
<guid isPermaLink="false">https://medium.com/p/1a2b3c4d5e6f</guid>
<pubDate>Tue, 24 Nov 2026 07:00:00 GMT</pubDate>
<content:encoded><![CDATA[<figure><img src="https://cdn-images-1.medium.com/max/1024/1*abc.png" /></figure><p>""" + b"word " * 460 + b"""</p>]]></content:encoded>
</item>
<item><title>No date</title><link>https://andrecamillo.medium.com/x-111111111111</link></item>
</channel></rss>"""

YOUTUBE = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<title>ThinkInfoSec</title><published>2018-09-13T02:14:36+00:00</published>
<entry>
<yt:videoId>S8cgevadQ_A</yt:videoId>
<title>Kernel access, redesigned</title>
<published>2026-06-14T07:00:19+00:00</published>
<media:group><media:description>What changed   and why.</media:description></media:group>
</entry>
<entry><yt:videoId>bad</yt:videoId><title>Broken</title><published>2026-06-01T00:00:00+00:00</published></entry>
</feed>"""


class MediumTests(unittest.TestCase):
    def test_parses_article(self):
        items = build_media.medium_items(MEDIUM)
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["id"], "medium:1a2b3c4d5e6f")
        self.assertEqual(item["kind"], "article")
        self.assertEqual(item["title"], "Agents on the estate")
        self.assertEqual(item["url"], "https://andrecamillo.medium.com/agents-on-the-estate-1a2b3c4d5e6f")
        self.assertEqual(item["thumb"], "https://cdn-images-1.medium.com/max/1024/1*abc.png")
        self.assertEqual(item["minutes"], 2)
        self.assertLessEqual(len(item["summary"]), build_media.SUMMARY_MAX + 1)
        self.assertIsInstance(item["ts"], int)


class YouTubeTests(unittest.TestCase):
    def test_parses_video_and_skips_bad_ids(self):
        items = build_media.youtube_items(YOUTUBE)
        self.assertEqual([i["id"] for i in items], ["youtube:S8cgevadQ_A"])
        item = items[0]
        self.assertEqual(item["url"], "https://www.youtube.com/watch?v=S8cgevadQ_A")
        self.assertEqual(item["thumb"], "https://i.ytimg.com/vi/S8cgevadQ_A/hqdefault.jpg")
        self.assertEqual(item["summary"], "What changed and why.")
        self.assertEqual(item["kind"], "video")


class XmlGuardTests(unittest.TestCase):
    def test_refuses_entity_declarations(self):
        bomb = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel></channel></rss>'
        with self.assertRaises(ValueError):
            build_media.medium_items(bomb)


class DoctypeInCdataTests(unittest.TestCase):
    def test_literal_doctype_in_cdata_is_not_refused(self):
        raw = MEDIUM.replace(b"<p>", b"<p>&lt;!DOCTYPE html&gt;", 1).replace(
            b"]]></content:encoded>", b"<!DOCTYPE html>]]></content:encoded>", 1)
        self.assertIn(b"<!DOCTYPE html>", raw)
        self.assertEqual(len(build_media.medium_items(raw)), 1)


class MergeTests(unittest.TestCase):
    def test_keeps_old_items_and_updates_by_id(self):
        old = [{"id": "a", "ts": 1, "title": "old a"}, {"id": "b", "ts": 2, "title": "b"}]
        fresh = [{"id": "a", "ts": 1, "title": "new a"}, {"id": "c", "ts": 3, "title": "c"}]
        merged = build_media.merge(old, fresh)
        self.assertEqual([i["id"] for i in merged], ["c", "b", "a"])
        self.assertEqual(merged[2]["title"], "new a")

    def test_no_duplicates(self):
        merged = build_media.merge([{"id": "a", "ts": 1}], [{"id": "a", "ts": 1}])
        self.assertEqual(len(merged), 1)


if __name__ == "__main__":
    unittest.main()
