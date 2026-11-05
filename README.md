# ThinkInfoSec Signal

A full-screen ambient display for cyber and world news. Stories rotate on their own, a related-topic graph sits beside the current story, and public-domain classical recordings play in the background.

Open the live page: https://thinkinfosec.github.io/Signal/

## Run it locally

Serve the folder. The page’s content security policy blocks `file://` loads.

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

The browser reads `news.json` from this site. `scripts/build_news.py` fetches the publisher feeds and writes that file. Run it and commit `news.json` when you want a fresh snapshot.

`cat` is `cyber` or `geo`. `ts` is Unix time in milliseconds. Titles and summaries are plain text, capped before they are shown.

## Fonts and music

Inter and Space Mono are stored under `fonts/` under the SIL Open Font License (`fonts/Inter-OFL.txt`, `fonts/SpaceMono-OFL.txt`). The recordings are public-domain Musopen performances stored under `audio/`.

## Headers

GitHub Pages serves the page with the policy in `index.html`. That policy keeps scripts, styles, fonts, pictures, audio, and news on this origin. The page also clears itself when it is loaded inside a frame.

`worker/index.js` is the same site with the framing rule sent as a response header, which a meta tag cannot do. From this folder:

```powershell
npx wrangler deploy
```
