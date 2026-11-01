# Media Hub

A remote-driven web viewer for smart TVs (webOS, Tizen, Android/Google TV) that makes dense, noisy
web dashboards feel like native TV apps, plus a small ingestion service that merges JSON feeds from
several providers into one catalog.

Everything runs as **one Node 22 process with zero dependencies**: the TV shell, a rewriting
proxy, the catalog API, artwork storage, and a deliberately messy demo portal you can test against.

```
TV app shell (owns focus + remote)            Node hub (LAN box / NAS / Pi)
┌──────────────────────────────┐              ┌───────────────────────────────┐
│ home grid  ←  IndexedDB      │ ◄─ deltas ── │ /api/catalog   SQLite (WAL)   │
│ portal frame (1280 logical,  │              │ /api/artwork   content-addr.  │
│   scaled to surface)         │ ◄─ HTML ──── │ /p/<src>/…     rewriting proxy│
│   window.__hub (injected)    │              │ /x/<src>/<url> 3rd-party path │
│ focus ring · cursor · OSD    │              │ adapters → normalise → merge  │
└──────────────────────────────┘              └───────────────────────────────┘
```

## Quick start

```bash
npm test          # unit tests: title normalisation, request classifier, HTML rewrite
npm start         # http://127.0.0.1:8787  (shell at /, status at /api/status)
```

Open http://127.0.0.1:8787 in a browser. Desktop keys: arrows move, Enter opens, Esc back,
`M` toggles cursor mode, Space starts playback, `I` shows the stats HUD. The first tile opens the
demo portal (fixed header, hero slider, cookie wall, in-grid ad slots, late interstitial,
pop-under on click, window-level infinite scroll, a player page) so every layer can be checked.

## How it works

### 1. Rendering

* The portal is loaded in an **iframe served from the hub's own origin** via the proxy, rendered at
  a fixed 1280 logical width (`<meta viewport width=1280>` injected) and scaled as a whole with
  `transform: scale()` to the TV surface. The portal sees the desktop layout it was built for.
* The shell's logical surface is capped at 1920 even on 4K panels; the panel upscales.
* **Z-index conflicts**: in playback mode the player is reparented into a shell-owned overlay with
  its own stacking context, and sticky headers are un-fixed by injected CSS
  (`shell/inject/content.css`). Outside playback the portal's chrome is untouched.

### 2. Interaction

* `shell/js/keymap.js` normalises webOS, Tizen, Android and desktop keyCodes into one intent enum in
  a capture-phase handler. The portal never sees raw keys. Tizen media/colour keys are registered
  at boot; webOS keys are declared in `appinfo.json`.
* **Spatial navigation** (`spatial.js`): candidates are the portal's focusables plus any element
  that registered a click/mousedown listener (tracked by wrapping `addEventListener`). Score is
  primary-axis distance + off-axis penalty − overlap bonus. Rect caches are invalidated on scroll,
  resize and DOM mutation, recomputed at most once per frame.
* **Cursor mode** (`cursor.js`) is the explicit fallback: hold-to-accelerate pointer, and "select"
  synthesises the full `pointerdown → mousedown → pointerup → mouseup → click` sequence because
  many portals bind to `mousedown` only.
* **Seek latency** (`player.js`): held left/right accumulates a target and commits one seek per
  250 ms or on key release, using `fastSeek` (keyframe) where available. FF cycles
  `playbackRate` 2/4/8 (muted above 2x) before falling back to keyframe stepping.
* Touch is never emulated globally: `maxTouchPoints` is spoofed to 0 and `ontouchstart` removed so
  the portal commits to its desktop layout. A per-source `touch: true` flag opts a portal back in.

### 3. Noise reduction

Rules are data, per source, in `config/sources.json`:

```json
"rules": {
  "css": [".hero-slider", "#top-banner", "[class*='cookie']"],
  "removeOnMount": [".interstitial"],
  "preserve": [".grid", ".card", "[data-item-id]"],
  "scrollRoot": ".grid-container",
  "player": ".player-root video"
}
```

* `css` hides known chrome before first paint; `removeOnMount` runs from a rAF-throttled
  `MutationObserver` for late overlays; a generic heuristic (fixed/sticky, high z-index, large
  coverage, ad-unit sized media, no video, little text, not navigation) catches the rest.
* **Grid integrity**: an element that is a direct child of a grid/flex `preserve` root is never
  removed; it is replaced by an empty placeholder that copies its `grid-column`, `flex-basis`,
  width and height so neighbours keep their position.
* **Placeholders, not hard blocks** (`server/filters.js`): requests matching host/path lists or
  ad-unit dimensions get a well-formed empty response of the expected type (empty JS module,
  1x1 PNG, blank document, 204). The page's own code sees success and takes no error branch.
  An image that resolves to the 1x1 placeholder collapses its slot client-side.
* **Infinite scroll** in a fixed-height frame: the configured `scrollRoot` becomes the real
  scroller, `window.scrollY`/`scrollTo`/scroll events are forwarded to it, and focus keeps the
  current row at 40% from the top so the sentinel is reached early.

### 4. Ingestion

* `server/ingest/adapters.js`: one generic JSON adapter driven by the manifest
  (`feed.url`, `feed.items`, `feed.map`, `feed.next`), with jittered backoff on 429/5xx and a
  per-source minimum interval. The scheduler runs sources concurrently with per-source
  concurrency of one.
* `normalise.js`: NFKC + diacritics folding → bracket tags dropped (trailing year kept) →
  separators → `SxxEyy`/`Season N` extracted → release tokens stripped → `titleKey` without
  articles. Items merge on `(titleKey, year, kind)` or Jaro-Winkler ≥ 0.92 within the same
  kind/year.
* `catalog.js`: `node:sqlite` in WAL mode with `synchronous = NORMAL`; every change bumps a
  sequence so the TV pulls `/api/catalog?since=<cursor>` with `If-None-Match` and pays zero
  writes when nothing changed.
* `artwork.js`: content-addressed files, downloads batched and written in bursts (flash
  controllers prefer this), fixed byte budget with an LRU sweep that runs only when idle. If
  `sharp` is installed artwork is pre-resized to 300x450 and 600x900 WebP; otherwise originals
  are stored.
* TV side (`shell/js/catalog.js`): IndexedDB mirror plus a 64 MB in-memory LRU for decoded
  artwork, evicted by last-focus time so the row being scanned never thrashes.

## Adding a source

Add an entry to `config/sources.json` with `origin` (the portal), a `feed` block describing its
JSON endpoint, and `rules`. Restart. Hot-reloading rules without a store resubmission is just
serving a new `sources.json`; the TV app itself never changes.

Only point this at sources you are entitled to access and scrape.

## Packaging for a TV

The TV app is `shell/`. For webOS use `shell/appinfo.json` with `ares-package`; for Tizen use
`shell/config.xml` with Tizen Studio; for Android TV wrap `http://<hub>:8787/` in a `WebView`
(where `shouldInterceptRequest` can additionally apply `server/filters.js` natively). Point the
packaged app at the hub's LAN address.

## Layout

```
server/index.js          single-port router
server/proxy.js          rewrite + inject + placeholders
server/filters.js        request classifier and placeholder bodies
server/ingest/           adapters, normalise, catalog (sqlite), artwork, scheduler
shell/                   TV app: index.html, shell.css, js/*, inject/* (runs inside the portal)
config/                  sources.json, filters.json
demo/                    messy demo portal + feed
test/                    node --test suites
```

MIT licence.
