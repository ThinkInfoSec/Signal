import gzip
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_news  # noqa: E402


class GunzipCapTests(unittest.TestCase):
    def test_normal_feed_decompresses(self):
        body = b"<rss><channel></channel></rss>"
        self.assertEqual(build_news.gunzip_capped(gzip.compress(body)), body)

    def test_bomb_is_rejected(self):
        bomb = gzip.compress(b"\0" * (build_news.MAX_FEED_BYTES + 10))
        self.assertLess(len(bomb), build_news.MAX_FEED_BYTES)
        with self.assertRaises(ValueError):
            build_news.gunzip_capped(bomb)


if __name__ == "__main__":
    unittest.main()
