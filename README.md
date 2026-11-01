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
`M` toggles cursor mode, `H` hides the element under the cursor and saves the rule, Space starts
playback, `I` shows the stats HUD. The home screen is rows: Continue watching, Sources, Movies,
Series, Episodes. The Demo Portal tile opens a deliberately messy page (fixed header, hero slider,
cookie wall, in-grid ad slots, late interstitial, pop-under on click, window-level infinite
scroll, a player page) so every layer can be checked. A second demo source ingests a static HTML
list to show cross-provider merging.

On Windows PowerShell 5.1 use `;` rather than `&&` to chain commands.

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
* **Search** (`search.js`): a Search tile (or `S` on desktop) opens an on-screen keyboard grid
  navigated by the same spatial code. Every key press filters the local catalog with prefix,
  word-prefix, substring and Jaro-Winkler fuzzy ranking, so results appear with no network
  round trip. A physical or USB keyboard types directly. Back deletes a character and leaves
  the screen when the query is empty; opening a result and pressing Back returns to the results.
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
"allowHosts": ["(^|\\.)cdn\\.portal-a\\.example$"],
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
* **Rule inspector**: on the TV, point the cursor (or focus) at a noisy element and press the
  `menu` key (`H` on desktop). The element is hidden immediately and its selector is written into
  that source's `css` rules through `PATCH /api/sources/<id>/rules`. Config is hot-reloaded, so
  rules written from the couch apply to every later page load without a restart.

### Redirect and escape protection

The viewer frame cannot leave the hub. Layers, outermost first:

* The shell page is served with `Content-Security-Policy: frame-src 'self'`, so the browser itself
  refuses any navigation of the portal frame to another origin, whatever script asked for it. The
  shell notices the refused load, discards the frame, and reloads the last good page.
* Proxied pages get `default-src 'self'`: every resource must come through the hub, where the
  classifier runs. Static URLs are rewritten by the proxy; URLs set by scripts (`fetch`, XHR,
  `img.src`, `script.src`, `setAttribute`) are rewritten by the content script. `meta refresh`
  redirects are routed or dropped.
* **Strict third-party blocking** (`config/filters.json`, `strict: true` by default): scripts,
  frames and data calls to any domain other than the portal's own are answered with placeholders,
  whether or not the domain is on an ad list. Images, video, fonts and stylesheets from CDNs stay
  allowed. If a portal genuinely needs a host (its player CDN, its API), add it to that source's
  `allowHosts` or the global `allowHosts`. `/api/status` lists what was blocked and why.
* `window.open` to another origin returns null. Clicks on links to another origin are cancelled;
  script-assigned links to the portal's own origin are routed. `_blank` becomes `_self`.
* Overlays that catch stray remote clicks are removed before they can be clicked.
* The proxy never fetches from loopback, link-local or private (home network) addresses on behalf
  of a page, unless the source itself is hosted there. Cookies are prefixed per source and only
  sent back to that source; third parties cannot set cookies on the TV.

* **Client allowlist** (`config/access.json`): list the TV's address in `allowClients` and every
  other device on the network gets a 403. The machine running the hub is always allowed. Empty
  list means any device. Hot-reloaded on save.

**Threat model.** The hub is a home-LAN appliance with no login. Without the client allowlist,
anyone on your network can browse through it and change rules. Do not expose port 8787 to the internet. Portal JavaScript still
runs inside the TV browser (locked to the hub origin by CSP), so keep the TV's firmware updated as
you would for any browsing, and only configure sources you trust.

### 4. Ingestion

* `server/ingest/adapters.js`: a generic JSON adapter driven by the manifest
  (`feed.url`, `feed.items`, `feed.map`, `feed.next`), and an HTML list adapter for portals
  without a feed (`feed.type: "html"`, `feed.itemRegex` with named groups `title`, `url`,
  `image`, `year`, `kind`, optional `feed.nextRegex` with group `url`). Both use jittered backoff
  on 429/5xx and a per-source minimum interval. The scheduler runs sources concurrently with
  per-source concurrency of one.
* `normalise.js`: NFKC + diacritics folding → bracket tags dropped (trailing year kept) →
  separators → `SxxEyy`/`Season N` extracted → release tokens stripped → `titleKey` without
  articles. Items merge on `(titleKey, year, kind)` or Jaro-Winkler ≥ 0.92 within the same
  kind/year.
* `catalog.js`: `node:sqlite` in WAL mode with `synchronous = NORMAL`. The sequence only moves
  when a source link, artwork, or missing year actually changes, so re-ingesting an unchanged
  feed sends nothing to the TV: it pulls `/api/catalog?since=<cursor>` with `If-None-Match` and
  pays zero writes.
* `artwork.js`: content-addressed files, downloads batched and written in bursts (flash
  controllers prefer this), fixed byte budget with an LRU sweep that runs only when idle. If
  `sharp` is installed artwork is pre-resized to 300x450 and 600x900 WebP; otherwise originals
  are stored.
* TV side (`shell/js/catalog.js`): IndexedDB mirror plus a 64 MB in-memory LRU for decoded
  artwork, evicted by last-focus time so the row being scanned never thrashes. Resume positions
  (`progress.js`) live in localStorage and feed the Continue watching row; playback resumes
  automatically and finished titles drop off the row.

## Adding a source

Add an entry to `config/sources.json` with `origin` (the portal), a `feed` block describing its
JSON endpoint or HTML list page, and `rules`. Save the file: the hub watches `config/` and
reloads sources and filters in place, scheduling new sources within a second. The TV app itself
never changes.

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
