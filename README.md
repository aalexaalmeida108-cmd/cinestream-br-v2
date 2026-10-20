# CineStream

Live site: <https://aalexaalmeida108-cmd.github.io/cinestream-br-v2/>

A static catalog browser for [EmbedMovies](https://embedmovies.org/) with direct playback through
[WatchPlay](https://watchplay.shop/) ([MyEmbed](https://myembed.biz/) remains available as an
alternate player). Movies, series and anime are searchable, sortable and filterable by genre, and
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
- WatchPlay runs in a cross-origin iframe and does not publish playback events to the parent page.
  The site therefore cannot detect the end of an episode and advance by itself; the watch page
  provides a **Next episode** button instead, which follows the real episode count of each season
  and rolls into the next season on the last episode. True automatic advance would require a
  same-origin HLS player and a stream URL source, not the current embedded player.
- The episode counter comes from `data/episodes.json`, which is measured against the player. A
  title that the player does not host has no measured counts, so the watch page falls back to the
  catalog season count.
- The original MyEmbed URL is exposed as an alternate player on every watch page.
- The site does not host, proxy or store any video. Playback is provided by WatchPlay, and metadata
  comes from EmbedMovies. Genre metadata comes from Bingebang and IMDb.
- Adult titles are filtered out of the generated catalog.
- If the catalog endpoint changes its response shape, update `normalize()` in
  `scripts/fetch_catalog.py` and regenerate the data.
