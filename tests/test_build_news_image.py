import io
import socket
import sys
import unittest
import urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_news  # noqa: E402

NS = 'xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"'


def node(inner):
    return ET.fromstring(f"<item {NS}>{inner}</item>")


PUBLIC = [(socket.AF_INET, 0, 0, "", ("93.184.216.34", 0))]


def addr(ip):
    return [(socket.AF_INET, 0, 0, "", (ip, 0))]


class FakeResp:
    def __init__(self, data):
        self.data = data

    def read(self, n=-1):
        if n < 0:
            n = len(self.data)
        out, self.data = self.data[:n], self.data[n:]
        return out

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ItemImage(unittest.TestCase):
    def test_media_thumbnail(self):
        n = node('<media:thumbnail url="https://x.com/t.jpg" width="240"/>')
        self.assertEqual(build_news.item_image(n), "https://x.com/t.jpg")

    def test_media_content_largest(self):
        n = node('<media:content url="https://x.com/s.jpg" medium="image" width="100"/>'
                 '<media:content url="https://x.com/b.jpg" type="image/jpeg" width="900"/>'
                 '<media:content url="https://x.com/v.mp4" medium="video" width="2000"/>')
        self.assertEqual(build_news.item_image(n), "https://x.com/b.jpg")

    def test_enclosure(self):
        n = node('<enclosure url="https://x.com/e.png" type="image/png"/>')
        self.assertEqual(build_news.item_image(n), "https://x.com/e.png")
        n = node('<enclosure url="https://x.com/a.mp3" type="audio/mpeg"/>')
        self.assertEqual(build_news.item_image(n), "")

    def test_html_img(self):
        n = node('<description>&lt;p&gt;hi&lt;img src="https://x.com/d.jpg"&gt;&lt;/p&gt;</description>')
        self.assertEqual(build_news.item_image(n), "https://x.com/d.jpg")
        n = node('<content:encoded><![CDATA[<figure><img src="https://x.com/c.jpg" /></figure>]]></content:encoded>')
        self.assertEqual(build_news.item_image(n), "https://x.com/c.jpg")

    def test_rejects_unsafe(self):
        for bad in ("http://x.com/a.jpg", "javascript:alert(1)", "https://user:pw@x.com/a.jpg",
                    "https://x.com/" + "a" * 1000):
            self.assertEqual(build_news.item_image(node(f'<media:thumbnail url="{bad}"/>')), "")


class OgImage(unittest.TestCase):
    def run_og(self, html, link="https://site.com/a/b"):
        opener = mock.Mock()
        opener.open.return_value = FakeResp(html)
        with mock.patch("urllib.request.build_opener", return_value=opener),                 mock.patch("socket.getaddrinfo", return_value=PUBLIC):
            return build_news.og_image(link)

    def test_absolute_and_relative(self):
        self.assertEqual(self.run_og(b'<html><head><meta property="og:image" content="https://c.com/i.jpg"></head>'),
                         "https://c.com/i.jpg")
        self.assertEqual(self.run_og(b'<head><meta property="og:image" content="/img/i.jpg"></head>'),
                         "https://site.com/img/i.jpg")

    def test_twitter_fallback_and_body_ignored(self):
        self.assertEqual(self.run_og(b'<head><meta name="twitter:image" content="https://c.com/t.jpg"></head>'),
                         "https://c.com/t.jpg")
        self.assertEqual(self.run_og(b'<head></head><meta property="og:image" content="https://c.com/x.jpg">'), "")

    def test_rejects_and_errors(self):
        self.assertEqual(self.run_og(b'<head><meta property="og:image" content="http://c.com/i.jpg"></head>'), "")
        self.assertEqual(build_news.og_image("http://site.com/a"), "")
        opener = mock.Mock()
        opener.open.side_effect = OSError("boom")
        with mock.patch("urllib.request.build_opener", return_value=opener),                 mock.patch("socket.getaddrinfo", return_value=PUBLIC):
            self.assertEqual(build_news.og_image("https://site.com/a"), "")


class Ssrf(unittest.TestCase):
    def redirect(self, url, handler=None):
        handler = handler or build_news._SafeRedirect()
        req = urllib.request.Request("https://site.com/a")
        with mock.patch("socket.getaddrinfo", return_value=PUBLIC):
            return handler.redirect_request(req, None, 302, "Found", {}, url)

    def test_redirect_to_http_rejected(self):
        with self.assertRaises(urllib.error.URLError):
            self.redirect("http://site.com/b")

    def test_redirect_to_private_rejected(self):
        for ip in ("127.0.0.1", "10.1.2.3", "169.254.169.254", "0.0.0.0", "224.0.0.1"):
            with mock.patch("socket.getaddrinfo", return_value=addr(ip)):
                handler = build_news._SafeRedirect()
                req = urllib.request.Request("https://site.com/a")
                with self.assertRaises(urllib.error.URLError, msg=ip):
                    handler.redirect_request(req, None, 302, "Found", {}, "https://evil.com/x")

    def test_redirect_cap(self):
        handler = build_news._SafeRedirect()
        for _ in range(3):
            self.assertIsNotNone(self.redirect("https://site.com/b", handler))
        with self.assertRaises(urllib.error.URLError):
            self.redirect("https://site.com/b", handler)

    def test_initial_private_and_literal_hosts_refused(self):
        with mock.patch("socket.getaddrinfo", return_value=addr("10.0.0.5")),                 mock.patch("urllib.request.build_opener") as bo:
            self.assertEqual(build_news.og_image("https://internal.example/a"), "")
            bo.assert_not_called()
        with mock.patch("urllib.request.build_opener") as bo:
            self.assertEqual(build_news.og_image("https://127.0.0.1/a"), "")
            self.assertEqual(build_news.og_image("https://[::1]/a"), "")
            bo.assert_not_called()


class Budget(unittest.TestCase):
    def test_budget_stops_fetches_and_negative_cache_first(self):
        items = [{"ts": i, "link": f"https://s.com/{i}"} for i in range(5)]
        cache = {}
        seen_before = []

        def fetcher(link):
            seen_before.append(cache.get(link))
            return "https://c.com/i.jpg"

        clock = iter([0, 0, 10, 100, 100, 100, 100])
        with mock.patch("time.monotonic", side_effect=lambda: next(clock)):
            out = build_news.add_og_images(items, cache, fetcher)
        self.assertEqual(len(seen_before), 2)
        self.assertEqual(seen_before, ["", ""])
        self.assertEqual(sum(1 for i in items if i.get("image")), 2)
        self.assertEqual(len(out), 2)


class Cache(unittest.TestCase):
    def items(self, n):
        return [{"ts": i, "link": f"https://s.com/{i}"} for i in range(n)]

    def test_cache_hit_skips_fetch(self):
        fetcher = mock.Mock(return_value="https://c.com/n.jpg")
        items = self.items(2)
        cache = build_news.add_og_images(
            items, {"https://s.com/1": "https://c.com/h.jpg", "https://s.com/0": ""}, fetcher)
        fetcher.assert_not_called()
        self.assertEqual(items[1]["image"], "https://c.com/h.jpg")
        self.assertNotIn("image", items[0])
        self.assertEqual(cache["https://s.com/0"], "")

    def test_limit_newest_first_and_prune(self):
        fetcher = mock.Mock(return_value="https://c.com/n.jpg")
        items = self.items(5)
        cache = build_news.add_og_images(items, {"https://gone.com/": "https://c.com/g.jpg"}, fetcher, limit=2)
        self.assertEqual([c.args[0] for c in fetcher.call_args_list], ["https://s.com/4", "https://s.com/3"])
        self.assertEqual(set(cache), {"https://s.com/4", "https://s.com/3"})


if __name__ == "__main__":
    unittest.main()
