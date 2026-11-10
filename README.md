# CineStream

Live site: <https://aalexaalmeida108-cmd.github.io/cinestream-br-v2/>

A static catalog browser for [EmbedMovies](https://embedmovies.org/) with playback through
several embeddable sources (VidSrc, WatchPlay and VidLink). Movies, series and anime are searchable, sortable and filterable by genre, and
every title opens in a dedicated watch page with a season/episode selector for series. The catalog
also keeps a local "Continue watching" row with the last opened titles and episodes.

The site is plain HTML, CSS and JavaScript. There is no build step and no backend.

## Why the catalog is generated

The EmbedMovies catalog endpoint (`POST https://embedmovies.org/inc/Ajax.php`) does not send CORS
headers, requires a CSRF token from a catalog page, and rate-limits bursts of requests. A browser
on GitHub Pages therefore cannot call it directly. `scripts/fetch_catalog.py` handles the token,
downloads the catalog once, normalizes it, and writes static JSON files into `data/`. The frontend
only reads those local files.

## Local preview

```bash
cd streaming-site
python3 -m http.server 8080
```

Open <http://localhost:8080>. Opening `index.html` straight from the filesystem will not work because
the browser blocks `fetch()` for `file://` URLs.

## Automatic weekly updates

The site refreshes itself every Monday at 06:17 UTC through
`.github/workflows/refresh-catalog.yml`: it fetches the catalog, fills missing genres from IMDb,
recounts episodes, validates the JSON, and commits the result. GitHub Pages redeploys on that
commit, so no manual step is needed.

To run the same pipeline from a checkout (cron, systemd timer or by hand):

```bash
./scripts/weekly_update.sh            # refresh + commit + push
./scripts/weekly_update.sh --no-push  # refresh + commit only
./scripts/weekly_update.sh --dry-run  # refresh, keep the tree dirty
```

The script logs progress, refuses to commit an empty or malformed catalog, and skips the commit
when nothing changed. Cron example:

```cron
17 6 * * 1 cd /path/to/cinestream-br-v2 && ./scripts/weekly_update.sh >> .cache/weekly.log 2>&1
```

## Donations

The site shows a PIX strip below the header and a QR modal (`js/donate.js`) with the key
`1088safary@gmail.com` and a suggested R$ 20. The BR Code is a static EMV payload rendered once to
`assets/pix-qr.png` with `qrencode`, so the page needs no third-party QR service and no network call
to draw it. The image has fixed pixel dimensions on purpose: an SVG with percentage width/height has
no intrinsic size and some browsers (notably iOS Safari) refuse to paint it inside an `<img>`. The
**Copiar código do QR Code** button copies the full BR Code for PIX Copia e Cola.

### Reminder schedule

The strip is not always on screen. `js/pix-schedule.js` opens a **3-day window every 31 days**:
3 days visible, 28 days hidden, repeat. It runs synchronously in `<head>` and adds `pix-off` to
`<html>` before the first paint, so a closed window never flashes the banner.

The schedule is pure calendar arithmetic against a fixed anchor, so it is identical for every
visitor — no cookie, no `localStorage`, no server, and no drift if someone clears their browser.
To move the calendar, edit one line:

```js
var ANCHOR = { year: 2026, month: 11, day: 10 }; // first day of a visible window
```

Manual control for a campaign or a test: `?pix=on` forces the strip on, `?pix=off` forces it off.
The footer link **Apoiar via PIX** stays available at all times, so a donation is always possible
even while the strip is in its hidden phase.

## Refresh the catalog

```bash
python3 scripts/fetch_catalog.py --workers 6
```

The script caches raw API pages under `.cache/embedmovies/`. Rerunning it only downloads missing or
changed pages. Use `--refresh` to ignore the cache, or `--only movie`, `--only tv`, `--only anime`
while debugging. Output:

| File | Contents |
| --- | --- |
| `data/movies.json` | Movies |
| `data/series.json` | Live-action series (anime removed) |
| `data/animes.json` | Anime series |
| `data/index.json` | Generated timestamp and per-category counts |
| `data/genres.json` | Genre bitmask per catalog id |

Each item uses compact keys: `i` (source id), `t` (title), `tp` (Portuguese title when different),
`y` (year), `r` (rating), `v` (votes), `p`/`b` (TMDB poster/backdrop paths), `tm` (TMDB id),
`im` (IMDb id), `ty` (movie/series/anime), `s` (season count), `rt` (runtime), `a` (anime flag),
`o` (short overview).

## Refresh genres

```bash
python3 scripts/enrich_genres.py
python3 scripts/enrich_imdb_genres.py
```

`enrich_genres.py` crawls Bingebang's movie and TV genre feeds, joins them by title and year, and
writes `data/genres.json` as a bitmask (`1` action, `2` adventure, `4` horror, `8` comedy,
`16` drama). The feeds cap at 500 pages per genre; `--skip-crawl` reuses `.cache/bingebang/`.
`--search` fills gaps through Bingebang's search endpoint, but that endpoint is aggressively rate
limited, so it is opt-in. `enrich_imdb_genres.py` downloads IMDb's `title.basics` dataset, joins
remaining items by IMDb id, then by exact normalized title and release year with title-type and
runtime guards. It never overwrites Bingebang matches. The weekly workflow runs the IMDb fallback
after refreshing the catalog; the dataset is cached under `.cache/imdb/` locally.

## Refresh episode counts

```bash
python3 scripts/fetch_episodes.py --workers 3
python3 scripts/probe_episodes.py --workers 6
```

The watch page needs to know how many episodes each season has, so the **Next episode** button can
roll from the last episode of a season into the first episode of the next one instead of running off
the end of a season.

`fetch_episodes.py` reads the TMDB season listing of every series and anime in the catalog
(`/tv/{id}/seasons`) and extracts the episode count of each season. Pages are cached under
`.cache/tmdb/seasons/`, so a rerun only downloads missing titles. Use `--cache-only` to build from
the cache without touching the network.

`probe_episodes.py` checks those counts against the player itself. The player is the authority on
which episodes exist, and it occasionally differs from TMDB (some anime carry an extra episode, and
a few titles are split into different season lengths). The script probes episode 1 of every known
season, then binary searches for the last existing episode, and also probes the season after the
last known one to catch seasons the catalog has not listed yet. A request that cannot be answered
is treated as unknown rather than as "missing", so a rate limit never becomes a wrong count.
Results are cached in `.cache/watchplay/counts.json` and saved as the run progresses.

Both scripts write `data/episodes.json`, the file the watch page downloads:

| File | Contents |
| --- | --- |
| `data/episodes.json` | Episode count per season, keyed by TMDB id |

The payload is a dense list per title, indexed by season: `[10, 10, 10, 10, 10, 10, 7, 6]` means
season 1 has 10 episodes and season 8 has 6. The player uses the count to bound the episode input,
to label the counter, and to decide when **Next episode** moves to the next season. When a title
has no entry in the file the watch page falls back to the catalog season count and stays usable.

## Deploy to GitHub Pages

The repository is already configured for Pages from the `main` branch, repository root. Push to
`main` and Pages rebuilds the site.

For a fresh repository:

1. Push the project to GitHub.
2. Open **Settings → Pages**.
3. Set **Source** to **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Push again or run the Pages build manually.

`.github/workflows/refresh-catalog.yml` refreshes the JSON once a week (and on manual dispatch) and
commits the updated `data/` directory. That commit triggers a normal Pages build.

## Structure

```
index.html                 Catalog page
player.html                Watch page
css/style.css              Shared layout, catalog grid, cards
css/player.css             Watch page and player shell
js/app.js                  Catalog loading, search, sort, pagination, Continue watching row
js/player.js               URL parsing, WatchPlay URL construction, episode controls
js/recent.js               Shared localStorage history for Continue watching
scripts/fetch_catalog.py   Catalog downloader and normalizer
scripts/enrich_genres.py   Bingebang genre crawl, title/year join, bitmask output
scripts/enrich_imdb_genres.py  IMDb id genre fallback
scripts/fetch_episodes.py  TMDB season listing, episode count per season
scripts/probe_episodes.py  Player probes, authoritative episode counts
scripts/episode_data.py    Shared cache and merge helpers for the episode counts
data/                      Generated catalog JSON, genres.json and episodes.json
assets/                    Favicon and poster placeholder
```

## Notes

- Playback URLs are built as `https://v2.watchplay.shop/movie/{tmdb-or-imdb}` for movies and
  `https://v2.watchplay.shop/tvshow/{tmdb}/{season}/{episode}` for series and anime. The player
  iframe runs with a sandbox that blocks popups while allowing scripts, forms and fullscreen.
- Continue watching is stored only in `localStorage` under `cinestream:recent:v1` and capped at 12
  entries. It records the title and last opened season/episode, never uploads history, and can be
  removed per title or cleared from the catalog row.
- Players run in a cross-origin iframe and publish no playback events to the parent page, so the
  site cannot detect the end of an episode. The watch page provides a **Next episode** button
  instead, which follows the real episode count of each season and rolls into the next season on
  the last episode.
- Each source has its own library. The watch page keeps the choice in `cinestream:source` and
  exposes a **Try another source** button, because a title missing from one source usually plays
  on another. Availability was measured directly: WatchPlay resolves roughly half of the catalog
  on its own, VidSrc covers a different half, and the union is higher than either one alone.
- The episode counter comes from `data/episodes.json`, which is measured against the player. A
  title that the player does not host has no measured counts, so the watch page falls back to the
  catalog season count.
- Sources are complementary, not equivalent. `Law & Order: Special Victims Unit` has no server for
  season 1 on VidSrc, but VidLink plays it. `data/availability.json` maps a TMDB id to the seasons
  each source answers, and the watch page moves the episode to a source that carries the requested
  season before it considers changing the season. The notice under the episode controls says which
  source was chosen and why. Titles absent from the map are treated as unknown.
- The player iframe is sandboxed with `allow-scripts allow-same-origin allow-forms
  allow-presentation`. The embed pages check for a sandbox and only refuse when the frame cannot
  keep its own origin, so `allow-same-origin` is the flag that matters. With the sandbox on, the
  third-party frames cannot open popups nor navigate the top window, which is what used to send
  the viewer to an ad page. Verified: the VidLink and WatchPlay players both render and stream
  inside the sandbox.
- Language is a per-source switch, applied to the player URL. `js/player.js` keeps the choice in
  `cinestream:audio` and rewrites the URL: VidSrc reads `?ad=` and matches it against the audio
  tracks of the server it picked, VidLink reads `?multiLang=` and opens the multi language menu
  where the Portuguese subtitle track sits. The VidSrc embed reports its audio tracks back to the
  embed API (`api.php?a=atracks`), so a Portuguese track is picked automatically when the
  upstream server carries one.
- What the catalog actually carries: VidLink ships one audio track per title (the original) plus
  subtitles in about a dozen languages, including `Português`. The Brazilian Portuguese dub does
  not exist as a separate audio track on VidSrc, WatchPlay or VidLink for the titles measured, so
  the site offers the subtitle track and the audio preference instead of promising a dub that is
  not there.
- The map cannot be crawled in one go: the embed host rate-limits per IP and returns 403 after a
  few thousand requests. `.github/workflows/probe-availability.yml` therefore probes a batch of 120
  series every six hours from a fresh runner IP, merges into the file and stores a `cursor`, so the
  catalog is covered over a few days without ever hammering the host. Run it by hand with:

  ```bash
  python3 scripts/probe_availability.py --offset 0 --limit 120 --merge --workers 4 --rate 1.5
  ```
- MyEmbed (`myembed.biz`) no longer serves a player, so it was removed from the watch page.
- The site does not host, proxy or store any video. Playback is provided by the third-party sources
  listed above, and metadata comes from EmbedMovies. Genre metadata comes from Bingebang and IMDb.
- Adult titles are filtered out of the generated catalog.
- If the catalog endpoint changes its response shape, update `normalize()` in
  `scripts/fetch_catalog.py` and regenerate the data.
