import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_news  # noqa: E402

NOW = int(time.time() * 1000)
FEED = {"name": "Fixture", "cat": "cyber"}
DATE = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime())

RSS = f"""<rss version="2.0"><channel><item><title>RSS story</title>
<link>https://example.com/rss-story</link><pubDate>{DATE}</pubDate></item>
<item><title>Plain http story</title><link>http://example.com/insecure</link><pubDate>{DATE}</pubDate></item>
</channel></rss>""".encode()

ATOM = f"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom story</title>
<link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/atom-story"/>
<updated>{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}</updated></entry></feed>""".encode()


class LinkTests(unittest.TestCase):
    def test_rss_link(self):
        items = build_news.items_from_feed(FEED, RSS, NOW)
        self.assertEqual(items[0]["link"], "https://example.com/rss-story")

    def test_http_link_dropped(self):
        items = build_news.items_from_feed(FEED, RSS, NOW)
        self.assertNotIn("link", items[1])

    def test_atom_alternate_link(self):
        items = build_news.items_from_feed(FEED, ATOM, NOW)
        self.assertEqual(items[0]["link"], "https://example.com/atom-story")


if __name__ == "__main__":
    unittest.main()
