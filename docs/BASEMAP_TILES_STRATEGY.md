# Basemap tiles — long-term strategy for a WebSUMO product (technical + legal)

*Decision-grade research report. Deep-research pass 2026-09-04: 3 focused streams
(hosted providers; self-hosting/produce-our-own; legal/licensing + Finland/
Helsinki options), ~120 cited primary sources. Grounded against our stack:
**MapLibre GL JS** frontend (deck.gl overlays on a slippy map), currently a
**raster** basemap from **Stadia `alidade_smooth`** — an ad-hoc switch made after
CARTO began baking an "API KEY REQUIRED" watermark into unauthenticated tiles
(see `osm_extractor/docs/inspector_basemap_tiles.md`, which we mirrored).*

> This report answers: **(1)** what options exist for background tiles (roll our
> own / third-party / other); **(2)** the technical and legal limits of each;
> **(3)** long-term solutions and their trade-offs; **(4)** reasonable next steps
> for our stack. Read §5 (caveats) before acting on any specific ToS clause —
> terms change and a few quotes were captured via search, not verbatim re-reads.

---

## 0. TL;DR — the blunt verdict

1. **The Stadia switch was the right *emergency* move but is not a product
   answer.** Two problems for a real product: Stadia's **free tier is
   non-commercial** (a shipped product needs ≥ the $20/mo Starter plan), and its
   ToS **forbids server-side caching/proxying** (client cache ≤ 7 days). It's a
   fine hosted vendor, just not free and not cache-friendly.

2. **For a product, the lowest-risk long-term answer is to stop depending on a
   third party's tile *service* and instead serve our own vector tiles.** The
   modern cheap path — **Planetiler → a single `.pmtiles` file → Cloudflare R2/CDN
   → MapLibre `pmtiles://` + an open style** — is **keyless, MapLibre-native,
   caching-legal, ~$0/month to serve a city/region, and has no per-map-load
   billing.** The only recurring obligation is the OSM attribution string.

3. **Because our data is Helsinki, there's a second first-class option: Finnish
   government open basemaps** — National Land Survey (NLS/MML) and City of
   Helsinki, both **CC BY 4.0, commercial use allowed**, with Web-Mercator
   (EPSG:3857) tile sets that MapLibre can consume. These are authoritative,
   free, and legally clean; NLS needs a free API key, Helsinki's WMTS needs none.

4. **Avoid two traps.** (a) **Never hotlink `tile.openstreetmap.org`** — it's a
   donation-funded community resource, not a hosting service; production traffic
   can be silently blocked. (b) **Avoid Mapbox and Google as the basemap under
   MapLibre** — Mapbox penalises non-"Qualified" renderers (per-tile billing) and
   bars caching/proxy; Google's "non-Google map" clause effectively **forbids**
   putting its tiles under MapLibre at all.

5. **Rendered tiles are a "Produced Work" under ODbL → attribution only, no
   share-alike.** Displaying OSM-derived tiles obliges us only to show
   **"© OpenStreetMap contributors"** (linked, may be collapsed behind an "(i)").
   We do **not** inherit share-alike by rendering — that only attaches if we
   publish a re-extractable OSM database or a modified OSM tile *schema*.

**Recommended target state:** self-hosted vector **PMTiles** (Protomaps or
VersaTiles/Shortbread schema) on R2/CDN, neutral grayscale style tuned not to
fight our sim overlays, self-hosted glyphs+sprites, MapLibre `AttributionControl`
(compact) — **with the Finnish NLS/Helsinki CC-BY tiles as an authoritative
alternate layer.** Keep hosted Stadia/MapTiler as a zero-effort fallback.

---

## 1. What options do we have? (Q1)

Four families, from most to least "someone else's problem":

| Option | What it is | Keyless? | Product-viable? |
|---|---|---|---|
| **A. Hotlink community tiles** | `tile.openstreetmap.org` raster | yes | ❌ **No** — usage policy forbids it; silent blocking |
| **B. Hosted tile provider (keyed)** | Stadia (now), MapTiler, CARTO, Mapbox, Google, Esri, Thunderforest, Jawg, Geoapify, hosted Protomaps/OpenFreeMap | mostly no | ✅ Yes, with cost + ToS constraints |
| **C. Produce & self-host our own** | OSM extract → Planetiler → PMTiles → CDN → MapLibre + open style | **yes** | ✅ **Yes — best control/cost** |
| **D. Regional government open basemaps** | NLS/MML, City of Helsinki, Digitransit/HSL | key varies | ✅ **Yes — Helsinki-authentic, CC BY** |

**A — hotlinking** is what a "quick demo" reaches for and must never ship: the OSM
Foundation is explicit that "our tile servers are not [free]… we may block access,
without notice." Our Stadia keyless-on-localhost habit is the same shape — fine
for dev, not for a product.

**B — hosted providers.** The realistic MapLibre-friendly set and their shape:

| Provider | Free tier | Model | Key | Caching in ToS | Self-host escape |
|---|---|---|---|---|---|
| **Stadia** (current) | 200k/mo, **non-commercial** | flat + credits ($20→$250/mo) | prod yes; keyless localhost | **no server cache; client ≤7d** | enterprise only |
| **MapTiler** | 5k sessions, non-commercial | session (their SDK) / **per-tile under MapLibre** | yes | no redistribution/proxy | ✅ **MapTiler Server / On-Prem** |
| **CARTO** | 5M/mo, non-commercial | enterprise/PAYG | **yes now** (keyless = watermark) | no server cache | CARTO Self-Hosted |
| **Esri ArcGIS** | **2M tiles/mo** | PAYG ($0.15/1k) | yes | more permissive | ✅ ArcGIS Enterprise |
| **Mapbox** | 50k loads/mo | loads *(only with "Qualified Renderer")* → **per-tile under MapLibre** | yes | **no cache/proxy** | Atlas (enterprise) |
| **Google** | 100k tiles/mo | $0.60–7/1k | yes | **very restrictive** | none |
| **Thunderforest/Jawg/Geoapify** | small | PAYG | yes | no caching proxies | none |
| **Protomaps (hosted)** | 1M/mo non-commercial | Sponsor from $14/mo | hosted yes | **explicitly allowed** | ✅ self-host PMTiles |
| **OpenFreeMap (public)** | **unlimited, commercial OK** | free (donations) | **none** | fully open | ✅ self-host planet |

**C — produce our own.** The cheap recipe (details in §3): **Planetiler** turns an
OSM extract into a single **PMTiles** file with no database; PMTiles is read
directly by the browser from static storage via HTTP range requests — **no tile
server**. Serving a Helsinki/Finland extract from **Cloudflare R2 costs ≈ $0**
(cents of storage, zero egress). MapLibre reads it via the `pmtiles://` protocol.

**D — Finnish government basemaps** (our data is Helsinki, so these are a natural
fit, all commercial-use-allowed):
- **National Land Survey (NLS/MML)** — CC BY 4.0; **free API key required**;
  vector tiles (MVT 2.1) in **both** ETRS-TM35FIN (3067) **and Web Mercator
  (3857)**, with a ready Mapbox-GL style → MapLibre-consumable.
- **City of Helsinki WMTS** (base maps + 5 cm orthophotos) — CC BY 4.0; **no key**
  for anonymous access; publishes an **EPSG:3857** TileMatrixSet.
- **Digitransit / HSL** — OSM-based (ODbL) tiles + a MapLibre-compatible style
  (`hsl-map-style`); free `digitransit-subscription-key`; note the style *build
  code* is AGPL-3.0 (the tiles and CC-BY design are not).

---

## 2. Technical & legal limitations of each approach (Q2)

### 2a. Technical

- **Vector vs raster.** We currently render **raster**. Vector tiles (the target)
  are **crisper on retina, rotate/tilt cleanly, are restyleable at runtime, and
  are far smaller** — and let us tune the basemap to sit *under* our deck.gl
  overlays without fighting them. MapLibre is vector-native; moving to vector is
  the right technical direction regardless of provider.
- **Projection.** Web slippy maps are **EPSG:3857 (Web Mercator)**. Finnish
  national data is natively **ETRS-TM35FIN (3067)** / Helsinki **ETRS-GK25
  (3879)** — but both NLS and Helsinki also publish **3857** tile sets, so
  MapLibre works; just pick the 3857 endpoints.
- **PMTiles operational limit:** the file is **immutable — no incremental
  update.** Refreshing from OSM means a **full Planetiler rebuild + full
  re-upload** (binary-diff rsync mitigates bandwidth). A PostGIS/dynamic stack can
  apply OSM diffs and re-render only dirty tiles — the one place the heavier
  option wins. For a basemap that changes slowly, monthly/quarterly rebuilds are
  fine.
- **A basemap is more than tiles.** Self-hosting also means hosting the
  **style.json + glyphs (fonts) + sprite (icons)** as static assets. Miss glyphs →
  labels vanish; miss the sprite → icons vanish. Not hard, but real setup.
- **Styles are schema-locked.** An OpenMapTiles-schema style renders nothing
  against Protomaps/Shortbread tiles. Choose schema first, then a matching style.
- **Provider gotchas:** Esri vector can be **blank above ~z16** in some regions
  (we saw this in Helsinki during the CARTO fix — Esri was rejected then for
  exactly this) → test before adopting; Mapbox/Google JS SDKs are **not** MapLibre.

### 2b. Legal

- **ODbL — rendered tiles = "Produced Work" → attribution only.** The ODbL
  explicitly says making a Produced Work "does not create a Derivative Database,"
  so **rendering raster/vector tiles does *not* trigger share-alike.** We owe an
  **attribution notice**, not source disclosure. Share-alike attaches only if we
  publicly use a **Derivative Database** — e.g. republish a re-extractable OSM
  dataset or a **modified OSM-derived tile schema**. A viewer that renders tiles
  for display is safely in attribution-only territory.
- **Required OSM attribution:** **"© OpenStreetMap contributors"**, linked to
  `openstreetmap.org/copyright`, visible on the map. **May be collapsed** behind a
  compact "(i)" control (OSMF explicitly permits this) as long as the info + link
  remain reachable. *(Our current basemap sets an attribution string but we should
  confirm the link + compact control — see §4.)*
- **Provider ToS patterns that bite a product:**
  - **No server-side caching / no proxying** — Stadia, MapTiler (Cloud), CARTO,
    Mapbox, Google. If we ever want our own CDN/tile cache in front, most hosted
    providers forbid it (self-host doesn't have this problem).
  - **Renderer lock-in** — Mapbox bills **per-tile** (not per-load) when the
    renderer isn't Mapbox's own; MapTiler's cheap "session" pricing likewise
    requires *their* SDK, else per-tile under MapLibre.
  - **"Non-Google map" clause** — Google forbids using its tiles "in conjunction
    with a non-Google map," i.e. **not usable under MapLibre.**
  - **Mandatory, non-removable logos/telemetry** — Mapbox logo + default
    telemetry (removing it worsens billing); Google logo must not be obscured.
  - **Non-commercial free tiers** — Stadia, MapTiler, CARTO, Jawg free tiers
    exclude commercial use; a product needs a paid plan on those.
- **Finnish/CC-BY specifics:** NLS and Helsinki require a **dataset + date**
  credit (e.g. "contains data from the National Land Survey of Finland Topographic
  Database MM/YYYY"; "Data and maps © City of Helsinki, City Survey Services").
  Digitransit's **style-build code is AGPL-3.0** — if we deploy modified build
  code over a network we'd owe that source (the tiles/design don't encumber us).
- **Community/free options are legally safe commercially** — OpenFreeMap (MIT
  code), Protomaps (BSD code, CC0 design), VersaTiles (Unlicense/CC0) — *provided*
  we still show "© OpenStreetMap contributors" (the permissive **code** licence
  never removes the ODbL **data** obligation).

### 2c. Legal-risk ranking (for a commercial product)

1. **Lowest:** self-host OSM-derived PMTiles (OpenFreeMap/Protomaps/VersaTiles) **or**
   Finnish CC-BY government tiles (NLS, Helsinki). Only duty: correct attribution.
2. **Low–moderate:** hosted keyed MapLibre-friendly provider (MapTiler, Stadia,
   CARTO, HSL) — obey no-cache/no-proxy, keep attribution, manage per-request cost.
3. **Moderate–high:** Mapbox/Google under MapLibre — renderer penalties, telemetry,
   "non-Google map" prohibition. Usable only in narrow, blessed configs.
4. **Highest — do not ship:** hotlinking `tile.openstreetmap.org` or scraping any
   provider. Policy violation; silent production blocking; no commercial footing.

---

## 3. Long-term solutions & trade-offs (Q3)

Three viable long-term postures. They are **not mutually exclusive** — the robust
answer combines a primary + a fallback.

### Solution A — Self-host vector PMTiles *(recommended primary)*
**Recipe:** Geofabrik **Finland extract** (`finland-latest.osm.pbf`, 707 MB) → **Planetiler**
(runs in minutes for a country extract; outputs `.pmtiles` directly, Protomaps or
Shortbread schema) → **Cloudflare R2** (zero egress) behind a CDN → MapLibre
`pmtiles://` source + an **open style** (Protomaps `grayscale`/`light` or
VersaTiles `graybeard` — neutral bases that won't fight sim overlays) + self-hosted
glyphs + sprite.

- **Pros:** keyless; **caching/proxy fully ours**; **~$0/month** to serve a
  region; no per-load/session billing risk ever; vector crispness/retina/rotate;
  only ODbL attribution owed; no vendor can watermark or cut us off.
- **Cons:** we own a (small) **data pipeline** — schedule an extract→Planetiler→
  upload rebuild to stay current (PMTiles has **no incremental update**); we host
  **style+glyphs+sprite**; style/cartography tuning is bespoke work.
- **Best when:** we're productising and want zero third-party runtime dependency
  and predictable cost. **This is the target.**

### Solution B — Finnish government basemaps (NLS / City of Helsinki) *(authoritative alternate)*
- **Pros:** authoritative Finnish cartography; **CC BY 4.0 commercial**; free;
  Helsinki WMTS needs no key; genuinely local/trustworthy for a Helsinki product.
- **Cons:** **geographic lock-in to Finland** (useless if we expand to other
  cities); NLS open interface has **no high-volume SLA**; attribution must carry
  dataset+date; projection endpoints need care (use their 3857 sets).
- **Best when:** we want an authoritative, official-looking base for Helsinki
  deployments — ideal as a **selectable layer** alongside Solution A, not the sole
  base if we ever leave Finland.

### Solution C — Hosted commercial provider with an SLA (MapTiler primary) *(managed fallback)*
- **Pros:** someone else runs it, real SLA, raster+vector, MapLibre-supported, and
  **MapTiler has a self-host escape hatch** (Server/On-Prem) so we're not trapped
  by Cloud caching clauses.
- **Cons:** ongoing per-request/session cost; non-commercial free tier; caching/
  proxy restricted on the Cloud plan; a vendor dependency that can change terms
  (exactly what bit us with CARTO).
- **Best when:** we want to defer ops, or need a hot fallback if the self-hosted
  file/CDN has an incident. Keep as **fallback**, not primary.

**Explicitly rejected long-term:** Mapbox/Google (renderer + anti-caching +
non-Google-map clause), CARTO (the thing we fled), and anything hotlinked.

**Trade-off summary:**

| | A. Self-host PMTiles | B. Finnish gov | C. Hosted (MapTiler) |
|---|---|---|---|
| Runtime cost | ~$0 | free | per-request/session |
| Vendor lock/cutoff risk | **none** | low (gov) | moderate (terms change) |
| Caching/proxy rights | **ours** | n/a | restricted |
| Ops burden | rebuild pipeline + assets | low | lowest |
| Geographic reach | **global** (any OSM) | Finland only | global |
| Attribution duty | OSM | OSM+dataset/date | OSM+provider logo |
| SLA | ours to build | none (open tier) | **yes** |

---

## 4. Reasonable next steps for our stack (Q4)

Ordered, low-risk-first. Nothing here is urgent while we're demoing (Stadia works),
but each de-risks the product path.

**Immediate (hours) — make the current state compliant & honest**
1. **Fix attribution now.** Ensure the MapLibre map shows **"© OpenStreetMap
   contributors"** linked to `openstreetmap.org/copyright` plus the current
   provider's required credit, via `AttributionControl({compact:true})`. (Our
   basemap sets an attribution string; verify the link + that it's actually
   rendered.) This is a legal must the moment anyone outside sees it.
2. **Record the constraint in the README/notes:** Stadia's free tier is
   **non-commercial** and forbids server-side caching — so the current setup is a
   *demo* configuration, not a shippable one. (Prevents a silent
   "it-worked-in-the-demo" trap, same lesson as the CARTO watermark.)

**Near-term (½–1 day) — stand up the self-hosted vector path as a spike**
3. **Build a Helsinki/Finland PMTiles spike:** run **Planetiler** on the Geofabrik
   Finland extract → `finland.pmtiles` (Protomaps schema); drop it on R2 (or even
   serve locally first); host an open **grayscale** style + glyphs + sprite.
4. **Wire `pmtiles://` into `MapView.tsx`:** switch the basemap source from the
   Stadia raster to the PMTiles vector source behind our existing **BLK/OSM
   toggle**; tune the style so the base sits *under* the deck.gl stoplines/vehicles
   (neutral greys, muted labels). Keep the raster path as a fallback flag.
5. **Add a basemap selector** (BLK / OSM-vector / Helsinki-gov) — cheap once the
   vector source exists, and it makes the Finnish CC-BY layer available.

**Medium-term (product hardening)**
6. **Decide primary vs fallback:** self-hosted PMTiles (A) as primary + MapTiler
   (C) as SLA fallback is the robust combo; add NLS/Helsinki (B) as an
   authoritative Helsinki layer.
7. **Automate the rebuild:** a scheduled job (monthly/quarterly) extract→Planetiler
   →upload, since PMTiles has no incremental update. Document the pipeline.
8. **Attribution/About panel:** a "Data sources" panel listing every layer's
   licence (belt-and-suspenders for the CC-BY sources' dataset+date requirement).

**Do-not-do**
- Don't ship hotlinked `tile.openstreetmap.org` or keyless-spoofed hosted tiles.
- Don't adopt Mapbox/Google as the MapLibre basemap.
- Don't put a CDN/cache in front of a hosted provider that forbids proxying
  (Stadia/MapTiler-Cloud/CARTO/Mapbox/Google) — that's what self-hosting is for.

---

## 5. Caveats & confidence

- **Strong, primary-sourced:** ODbL "Produced Work → attribution-only" mechanics;
  the OSM tile-usage policy (no hotlinking/bulk); PMTiles-on-static-storage
  serving model + Planetiler toolchain; the NLS/Helsinki **CC BY 4.0** licences
  and 3857 availability; OpenFreeMap/Protomaps/VersaTiles permissive licences with
  residual ODbL attribution; MapLibre `AttributionControl({compact})`.
- **Vendor ToS — verify verbatim before contracting:** the Mapbox "Qualified
  Renderer"/no-cache wording (dated Product Terms PDF), Google's "non-Google map"
  clause, and MapTiler/Stadia caching limits were captured via docs + search
  excerpts; re-read the live terms before relying on them commercially.
- **Test-before-adopt items:** Esri's blank-above-z16 behaviour in Helsinki; the
  exact City-of-Helsinki 3857 TileMatrixSet identifier (from live GetCapabilities);
  Digitransit's AGPL-on-build-code scope; NLS Web-Mercator availability per
  specific raster layer (vector `taustakartta` confirmed).
- **Numbers are order-of-magnitude:** Planetiler planet build (~3h21m on 16
  CPU/128 GB per the repo; faster on bigger hardware), planet PMTiles ~99–120 GB,
  Finland extract 707 MB, city PMTiles tens of MB, R2 zero-egress. City/region
  serving cost rounds to ~$0; planet-scale storage is the cost driver if we ever go
  global-eager rather than per-extract.
- **The CARTO watermark date (~Aug 2026)** and Esri z16 issue came from community
  reports/our own hands-on fix, not formal KB articles.

---

## Primary sources

**Our stack / MapLibre**
- MapLibre GL JS: https://github.com/maplibre/maplibre-gl-js · AttributionControl: https://maplibre.org/maplibre-gl-js/docs/API/classes/AttributionControl/ · fork rationale: https://www.maptiler.com/news/2021/01/maplibre-mapbox-gl-open-source-fork/
- (Internal) the CARTO-watermark fix we mirrored: `osm_extractor/docs/inspector_basemap_tiles.md`

**Hosted providers**
- Stadia: https://stadiamaps.com/pricing/ · https://stadiamaps.com/terms-of-service/ · https://stadiamaps.com/attribution/
- MapTiler: https://www.maptiler.com/cloud/pricing/ · https://www.maptiler.com/terms/ · https://www.maptiler.com/server/ · https://docs.maptiler.com/guides/maps-apis/maps-platform/tile-requests-and-map-sessions-compared/
- Mapbox: https://www.mapbox.com/legal/tos · https://www.mapbox.com/legal/product-terms · https://docs.mapbox.com/help/dive-deeper/mapbox-in-maplibre/
- Google: https://developers.google.com/maps/documentation/tile/policies · https://cloud.google.com/maps-platform/terms/maps-service-terms
- CARTO: https://carto.com/basemaps/apikey/ · https://carto.com/legal/basemap-terms/ · https://github.com/CartoDB/basemap-styles/blob/master/LICENSE.md
- Esri: https://location.arcgis.com/pricing/ · https://developers.arcgis.com/maplibre-gl-js/ · https://community.esri.com/t5/open-source-mapping-libraries-ques/vector-tile-basemaps-in-maplibre/td-p/1491361
- Thunderforest: https://www.thunderforest.com/pricing/ · https://www.thunderforest.com/terms/ · Jawg: https://www.jawg.io/en/pricing/ · Geoapify: https://www.geoapify.com/pricing/

**Produce & self-host (vector/PMTiles)**
- Planetiler: https://github.com/onthegomap/planetiler · https://github.com/onthegomap/planetiler/blob/main/PLANET.md
- PMTiles/Protomaps: https://docs.protomaps.com/pmtiles/ · https://docs.protomaps.com/pmtiles/maplibre · https://docs.protomaps.com/pmtiles/cloud-storage · https://protomaps.com/blog/free-tier-maps/ · https://github.com/protomaps/basemaps
- OpenFreeMap: https://openfreemap.org/ · https://github.com/hyperknot/openfreemap
- VersaTiles/Shortbread: https://versatiles.org/ · https://shortbread-tiles.org/ · https://github.com/versatiles-org/versatiles-style
- Tilemaker/OpenMapTiles/Tippecanoe: https://github.com/systemed/tilemaker · https://github.com/openmaptiles/openmaptiles · https://raw.githubusercontent.com/openmaptiles/openmaptiles/master/LICENSE.md · https://github.com/felt/tippecanoe
- Dynamic servers: https://github.com/maplibre/martin · https://github.com/maptiler/tileserver-gl
- Styling/assets: https://github.com/maplibre/maputnik · https://github.com/openmaptiles/fonts · https://maplibre.org/maplibre-style-spec/glyphs/ · https://maplibre.org/maplibre-style-spec/sprite/
- Data/infra: https://download.geofabrik.de/europe/finland.html · https://planet.openstreetmap.org/pbf/ · https://switch2osm.org/serving-tiles/ · https://wiki.openstreetmap.org/wiki/Planet.osm/diffs

**Legal / licensing**
- ODbL 1.0: https://opendatacommons.org/licenses/odbl/1-0/ · OSMF attribution: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines · Produced-Work guideline: https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline · https://www.openstreetmap.org/copyright
- OSM tile usage policy: https://operations.osmfoundation.org/policies/tiles/

**Finland / Helsinki open basemaps**
- NLS/MML: https://www.maanmittauslaitos.fi/en/opendata-licence-cc40 · https://www.maanmittauslaitos.fi/en/maps-and-spatial-data/datasets-and-interfaces/map-interface-services/map-image-service-wms-wmts · https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-ohje
- Digitransit/HSL: https://digitransit.fi/en/developers/apis/5-map-api/ · https://github.com/HSLdevcom/hsl-map-style · https://www.hsl.fi/en/hsl/open-data
- City of Helsinki / HRI: https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/make-better-use-of-geospatial-data/open-geographic-data · https://hri.fi/en_gb/ · https://kartta.hel.fi/ws/geoserver/avoindata/gwc/service/wmts?request=GetCapabilities
- Copernicus (satellite layer, CC BY since 2 Jul 2025): https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/OGC/WMTS.html
