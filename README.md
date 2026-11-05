# ThinkInfoSec Signal

A full-screen ambient display for cyber and world news. Stories rotate on their own, a related-topic graph sits beside the current story, and public-domain classical recordings play in the background.

Open the live page: https://thinkinfosec.github.io/Signal/

## Run it locally

Open `index.html` in a browser, or serve the folder so the news feeds can load:

```powershell
python -m http.server 8080
```

Then go to http://localhost:8080. Click or press any key to start. That first gesture starts the music and asks for fullscreen.

## Controls

| Key | Action |
| --- | --- |
| Space | Play or pause music |
| N | Next track |
| M | Mute |
| ← → | Previous or next story |
| 1 2 3 | All / Cyber / World |
| Click | Open a story, or follow a topic |
| Esc | Stop following a topic |
| T | Dark or light theme |
| F | Fullscreen |
| H | Show or hide this list |

## News

With `CONFIG.API` left as the placeholder, Signal reads a small set of public RSS feeds through [rss2json](https://rss2json.com/). That service is rate-limited.

To use your own feed, deploy a proxy and set `CONFIG.API` in `index.html` to its URL. The proxy should return JSON:

```json
{
  "items": [
    {
      "title": "Story headline",
      "summary": "Short summary",
      "source": "Source name",
      "cat": "cyber",
      "ts": 1730000000000
    }
  ]
}
```

`cat` is `cyber` or `geo`. `ts` is Unix time in milliseconds. If the proxy is missing or fails, Signal falls back to the public feeds.

## Music

The recordings are public domain via [Musopen](https://musopen.org/) and are loaded from Wikimedia Commons. Titles and composers are shown on screen.
