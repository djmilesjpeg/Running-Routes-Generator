# Loop

Enter a distance and a run type. Get a loop route that starts and ends where you
are standing, drawn on a map and downloadable as GPX for Strava, Runna or a
watch.

Static site. No build step, no bundler, no framework, no npm dependencies, and
no third-party CDN at runtime - Leaflet is vendored into `docs/vendor/`. Deploys
to GitHub Pages as-is.

---

## Before you deploy

**GitHub Pages serves every file in the published directory, whether or not
anything links to it. An unlinked file is a public file.** That is the
assumption behind everything below.

This repository is set up so nothing sensitive can be published by accident, but
the guarantees only hold if you install the hook:

```bash
npm run install-hooks
```

That points `core.hooksPath` at `.githooks/`, enabling a pre-commit check that
blocks the commit on:

| Check | Scope | Exemptions |
|---|---|---|
| Forbidden paths — `*.gpx`, `config.json`, `.env*` | every commit | none |
| Credential formats — ORS, Google, AWS, GitHub, Slack, JWT, private keys | every file | none |
| Coordinate shapes — lat/lon pairs, `lat:`/`lon:` fields, geo URLs | every file | `.coordcheckignore` |

Scan the whole working tree at any time:

```bash
npm run check
```

### Never commit

- **Your ORS API key.** It belongs in browser localStorage only. Not in source,
  not in a config file, not in a URL query string. The deployed JavaScript is
  public; anything in it is public.
- **Real coordinates.** No home or workplace location, in any file — including
  test fixtures, default map centres, code comments and commit messages.
- **`.gpx`, `.tcx` or `.fit` files.** These are route and activity exports and
  contain exactly the coordinates you are trying not to publish.
- **A real `config.json`.** Only `config.example.json` is committed, and the app
  never reads a config file at all.
- **Screenshots showing a real map position.** The repository contains no
  screenshots for this reason.
- **A route cache.** `route-cache.json` and `*.routes.json` are gitignored.

Test fixtures use invented coordinates around Wellington, New Zealand — chosen
because a negative latitude and a longitude near the antimeridian catch sign and
wrap bugs that a northern-hemisphere fixture would hide. Nothing in
`test/fixtures/` corresponds to a real location anyone has visited, and the
generator builds every route from a seeded PRNG rather than from recorded data.

### What the app stores on your device

| Data | Where | Cleared by |
|---|---|---|
| ORS API key | `localStorage` | Settings → Clear key |
| Last 5 routes, with coordinates | `localStorage` | Settings → Clear saved routes |
| Distance and run type preference | `localStorage` | browser site data |
| App shell (HTML, CSS, JS, icons) | Cache Storage | browser site data |

Your location is held in memory for the session and never written to storage.
Routing responses and map tiles are never cached, because the first carries your
start point and the second records which area you were looking at.

---

## Setup

```bash
git clone <your-fork-url>
cd <repo>
npm run install-hooks    # do this first
npm test
```

There is nothing to build or install. `package.json` exists only to run the test
suite and install the hook; there are no dependencies to install.

### Get an API key

1. Sign up free at [openrouteservice.org](https://openrouteservice.org/dev/#/signup).
2. Create a token for the **Directions** service.
3. Open the app and paste it when prompted. It is stored in that browser only.

The free tier allows 40 directions requests per minute and 2000 per day. One
route generation costs up to 16 requests, so roughly 125 generations a day.

### Run it locally

```bash
npm start
```

Then open `http://127.0.0.1:8099` **in your browser** — that is a web address,
not a command. Ctrl+C in the terminal stops the server.

Geolocation and service workers both need a secure context; `localhost` and
`127.0.0.1` count as one, so this works without HTTPS.

**Use this rather than `python -m http.server`.** python's server sends no
`Cache-Control`, so browsers fall back to heuristic caching — and each ES module
is cached independently, so a plain reload does not pick up an edited file. That
produces a genuinely confusing failure: the file on disk is correct, the server
serves it correctly, and the page keeps running the old version. This server
sends `no-store`, so a reload always runs what is on disk.

If the page ever behaves like an older version anyway, check which build is
running from the browser console (F12):

```js
__loopgenBuild
```

Production caching is a separate matter and is handled deliberately by the
service worker, versioned via `CACHE_VERSION` in `docs/sw.js`.

### Deploy to GitHub Pages

1. Push to GitHub.
2. Settings → Pages → Source: **Deploy from a branch**.
3. Branch `main`, folder **`/docs`**.

Serving from `/docs` rather than the repository root means only `docs/` is
reachable by URL. Tests, fixtures, hooks and scripts stay in the repository but
are never served.

Add it to your phone's home screen from the browser's share menu and it opens
fullscreen with its own icon.

---

## Using it

Tap **Start from here**. That is the whole flow: it takes a location fix and
generates using your last distance and run type.

To search again after changing the distance or style, use **Find routes with
these settings**. It reuses the starting point you already set, so it does not
ask for your location a second time.

| Run type | Optimises for |
|---|---|
| **Easy** | Least total ascent |
| **Tempo** | Fewest turns and road crossings |
| **Long** | Closest to the requested distance, ignoring terrain |
| **Hills** | Most total ascent |

Switching run type re-ranks the routes already downloaded. It costs no
additional requests, so it is free to try all four.

### Route style, and what it cannot promise

| Style | Sends |
|---|---|
| **Quiet** (default) | Walking profile, weighted hard towards quiet streets and away from main roads |
| **Paths** | Hiking profile, weighted towards parks and green space |
| **Direct** | Walking profile, no preference |

Unlike run type, style changes the routing itself, so it needs a new search.

**No routing service can guarantee a pavement.** OpenRouteService has no
sidewalk filter, because `sidewalk` tagging in OpenStreetMap is too incomplete
to route on — a road can be routable on foot simply because nobody has recorded
whether there is a path beside it. `avoid_features` does not help either: for
foot profiles it covers ferries, fords and steps, not roads.

Quiet weighting is the strongest available lever and it is the default, but
**look at the map before you set off.**

The `quiet` and `green` weightings depend on extended graph storages that a
given OpenRouteService deployment may not have built. If they are rejected, the
app retries once without them and tells you the style could not be applied,
rather than silently returning a route that may use main roads.

GPX downloads are written as tracks with elevation on every point and **no
timestamps** — a plan, not a recorded run.

---

## The distance problem

Round-trip routing treats a requested loop length as a hint rather than a
contract. Below roughly 10km the result is close. Beyond that it degrades badly
and silently: **ask for 21km and you can get a 38km loop.** The service reports
38km quite honestly — it simply built a different loop than the one requested.

The fix treats the router as an opaque function `A = f(R, seed)` mapping a
requested length to a delivered one, and solves `f(R) = target`:

1. Request several candidates with different seeds.
2. **Measure** each returned route from its geometry. The reported distance is
   the number that goes wrong, so it carries no signal about the error.
3. Fit the observations and re-request at a corrected length.
4. Keep candidates within 5% of target. If none qualify, say so and offer the
   closest.

Step 3 uses a **power-law fit**, `A = c·R^k`, solved for the target. A linear
secant was tried first and converges too slowly — the error is multiplicative
rather than additive, so a secant undershoots systematically and needs five or
more rounds at marathon distance. Fitting the exponent reaches tolerance in
three. Against the simulated router in the test suite:

| Target | Naive first request returns | After correction |
|---|---|---|
| 10 km | 10.8 km | −0.04% |
| 21.1 km | 35.9 km | −1.01% |
| 32 km | 73.8 km | −2.02% |
| 42.2 km | 121.3 km | −2.75% |

Each seed is solved independently, because `f` genuinely differs per seed: one
seed may drop its loop into a dense street grid and another onto a river path
with almost no options.

The whole policy is a pure function. `planCorrection()` takes every attempt so
far and returns what to request next; the network loop only executes those
instructions. That is what makes it testable entirely from fixtures, with no
network calls — the test files replace `globalThis.fetch` with a thrower so a
stray request fails loudly rather than quietly spending API quota.

---

## Architecture

```
docs/                        <- the only directory GitHub Pages serves
  index.html
  manifest.webmanifest
  sw.js
  css/app.css
  icons/
  vendor/leaflet/            vendored, so the app depends on no external CDN
  js/
    core/                    pure; no network, no DOM, fully unit tested
      geo.js                 haversine, polyline length, elevation deltas
      route.js               the provider-neutral Route model
      correction.js          the distance-correction algorithm
      scoring.js             easy / tempo / long / hills
      gpx.js                 track writer
      log.js                 redacting logger
    providers/
      RouteProvider.js       the interface: generateCandidates({lat, lon, distanceM, seed})
      OrsProvider.js         the only file that knows OpenRouteService exists
    app/
      generate.js            orchestrator; talks to the interface, never to ORS
      cache.js               recent routes in localStorage
    ui/
      map.js                 Leaflet; the only coordinate-order flip
      keystore.js            API key in localStorage
    main.js                  wiring
test/                        node:test, no dependencies, no network
scripts/make-icons.mjs       regenerates the PWA icons
.githooks/pre-commit         the privacy check
```

Dependencies point one way: `ui` → `app` → `providers` → `core`. Nothing in
`core` imports anything above it.

### Swapping the routing provider

Everything above `providers/` is written against the `Route` shape, never
against a service. To add Trail Router:

1. Write `docs/js/providers/TrailRouterProvider.js` extending `RouteProvider`
   and implementing `generateCandidates({lat, lon, distanceM, seed})`.
2. Change the line in `main.js` that constructs the provider.

No scoring, correction, GPX or UI code is touched. The contract an
implementation owes its caller is documented at the top of `RouteProvider.js`;
the important one is that `actualLengthM` must be measured from the returned
geometry and never copied from the provider's own reported distance.

---

## Tests

```bash
npm test          # 171 tests
npm run test:watch
```

Built on `node:test`, so there is nothing to install. No test performs a network
call. The correction, scoring and GPX layers were written and tested before any
UI existed.

Worth knowing about the fixtures: `test/fixtures/synthetic.js` includes a
simulated router that reproduces the real distance failure — accurate below 8km,
inflating sharply beyond — which lets the whole correction loop be driven to
convergence offline. That simulation is what showed the linear secant was too
slow, and what proves an uncorrectable router terminates rather than looping.

---

## Licence

MIT. See [LICENSE](LICENSE).

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
licensed under [ODbL](https://opendatacommons.org/licenses/odbl/). Routing by
[OpenRouteService](https://openrouteservice.org/). Attribution is a condition of
the licence, not a courtesy — it appears on the map, in the page footer and
inside every generated GPX file.
