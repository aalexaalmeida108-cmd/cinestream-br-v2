# CineStream

A static catalog browser for [EmbedMovies](https://embedmovies.org/) with playback through
[MyEmbed](https://myembed.biz/). Movies, series and anime are searchable and sortable, and every
title opens in a dedicated watch page with a season/episode selector for series.

The site is plain HTML, CSS and JavaScript. There is no build step and no backend.

## Why the catalog is generated

The EmbedMovies catalog endpoint (`POST https://embedmovies.org/inc/Ajax.php`) does not send CORS
headers, and it rate-limits bursts of requests. A browser on GitHub Pages therefore cannot call it
directly. `scripts/fetch_catalog.py` downloads the catalog once, normalizes it, and writes static
JSON files into `data/`. The frontend only reads those local files.

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

Each item uses compact keys: `i` (source id), `t` (title), `tp` (Portuguese title when different),
`y` (year), `r` (rating), `v` (votes), `p`/`b` (TMDB poster/backdrop paths), `tm` (TMDB id),
`im` (IMDb id), `ty` (movie/series/anime), `s` (season count), `rt` (runtime), `a` (anime flag),
`o` (short overview).

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
js/app.js                  Catalog loading, search, sort, pagination
js/player.js               URL parsing, MyEmbed URL construction, episode controls
scripts/fetch_catalog.py   Catalog downloader and normalizer
data/                      Generated catalog JSON
assets/                    Favicon and poster placeholder
```

## Notes

- Playback URLs are built as `https://myembed.biz/filme/{imdb-or-tmdb}` for movies and
  `https://myembed.biz/serie/{tmdb}/{season}/{episode}` for series and anime.
- The site does not host, proxy or store any video. All playback is provided by MyEmbed, and all
  metadata comes from EmbedMovies.
- Adult titles are filtered out of the generated catalog.
- If the catalog endpoint changes its response shape, update `normalize()` in
  `scripts/fetch_catalog.py` and regenerate the data.
