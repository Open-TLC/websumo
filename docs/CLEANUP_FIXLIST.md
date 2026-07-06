# WebSUMO — Prioritized Cleanup / Fix List

*Produced 2026-07-03 by a multi-agent audit of the repo (four analyzers: stale
code, terminology/modeling, anti-patterns, doc/tech-debt) with an adversarial
verification pass on every removal and high-severity claim. Findings a verifier
refuted or downgraded have already been dropped or softened here.*

## Executive summary

WebSUMO is a small, mostly sound single-operator viewer. The two real themes
are (1) the client-supplied `scenario` string is trusted everywhere — used
unvalidated for filesystem paths, subprocess argv, and NATS subjects — and
(2) pervasive documentation drift around the not-yet-built Open Controller
integration, where the README claims OC subjects are already published (no such
code exists) and the TLS-command subject is spelled three incompatible ways.
The code itself has a cluster of backend robustness issues around the
adapter-process lifecycle and the per-client WebSocket/NATS relay. Most
high-value fixes are small and localized; the larger refactors rank below the
quick correctness/security wins.

## Cross-cutting themes

1. **Path/identity trust** — `scenario` flows unvalidated into filesystem, subprocess, and NATS, though `list_scenarios()` already exists to allowlist it.
2. **OC doc contract is unbuilt but described as shipped** — TLS-command subject named 3 ways (`sim.{scenario}.cmd.tls` vs `group.control.*` vs `group.status.*`); detector/group subjects break the `sim.{scenario}.*` convention.
3. **Duplicated data contracts** — the 7-field vehicle tuple lives in Python, a TS tuple, MapView index access, and the README with no shared source of truth; `det_id`/`id` and `vclass`/`vtype` splits compound it.
4. **Fragile adapter + relay lifecycle** — global singleton process, `pgrep`-by-name teardown, per-client NATS connection with no connect-failure handling, swallowed send errors, no subscription teardown.
5. **Stale design docs** — IMPLEMENTATION_PLAN and INTEGRATION_ROADMAP describe the pre-migration TraCI architecture and reference the deleted `session.py`; not marked historical.
6. **Environment fragility** — hardcoded `python3.14` site-packages path in all three backend modules; 16 MB committed `nats-server` binary; scattered magic numbers and a duplicated NATS default.

## Fix list (ranked; do #1 first)

**Progress:**
- Batch A (#1, #8) done 2026-07-03 — `_require_scenario` allowlist validation on all entry points; CORS restricted to `ALLOWED_ORIGINS`.
- Batch B (#2, #5, #7) done 2026-07-03 — OC subject naming reconciled (`detector.control.*` / `group.control.*`, verify-against-OC caveat added), false "adapter already publishes OC subjects" claim removed; IMPLEMENTATION_PLAN marked HISTORICAL + dead link removed, INTEGRATION_ROADMAP updated to libsumo+NATS (Option 1 = done, `session.py`→`sumo_adapter.py`); dead `:9222` WebSocket config + README mentions removed.

| # | Sev / Effort | Item |
|---|---|---|
| 1 | High / M | ✅ Validate `scenario` against an allowlist before any fs/subprocess/NATS use |
| 2 | Med / S | ✅ Fix README's false "adapter already publishes OC subjects" claim; pick one OC TLS subject name |
| 3 | Med / S | Replace hardcoded `python3.14` `sys.path` (×3) with a derived path in one helper |
| 4 | Med / M | Named decoder + arity assertion for the 7-field vehicle tuple (Python/TS/README) |
| 5 | High / M | ✅ Mark IMPLEMENTATION_PLAN + INTEGRATION_ROADMAP historical / update to libsumo+NATS |
| 6 | Med / M | Harden WS relay + per-client NATS lifecycle (teardown, connect-failure, no bare-except) |
| 7 | Low / S | ✅ Remove unused NATS WebSocket `:9222` config block + README mentions |
| 8 | Med / S | ✅ Restrict CORS from `allow_origins=['*']`; bind process-control API to localhost |
| 9 | Med / L | Serialize adapter lifecycle; make orphan-kill scenario-specific (not `pgrep`-by-name) |
| 10 | Low / S | Untrack the 16 MB `nats-server` binary; document how to fetch it |
| 11 | Low / S | Add mtime invalidation to the network GeoJSON cache |
| 12 | Low / S | Reconcile `vclass`/`vtype` and `det_id`/`id` naming before the generator/OC join |
| 13 | Low / M | Convert `_stretch_flows` regex XML rewrite to ElementTree; clean up temp route files |
| 14 | Med / M | Add LICENSE, `.env.example`, a minimal test + CI baseline |
| 15 | Low / S | Centralize config; share the single NATS default; small doc-hygiene fixes |

### Details

**#1 — Validate `scenario` (High / M).** `backend/main.py:60-61,73-88,105-114,125-134,151`; `backend/sumo_adapter.py:145-146`.
`scenario` comes straight from URL path / JSON body into `f'{SCENARIOS_DIR}/{scenario}.sumocfg'`, `/tmp/sumo_adapter_{scenario}.log`, `/tmp/{scenario}.rou.{end}.xml`, subprocess argv, and NATS subjects. `get_adapter_log` returns the contents of `/tmp/sumo_adapter_{scenario}.log`, so a crafted `scenario` escapes the intended dir to read arbitrary `.log`-suffixed paths (the `start` path is additionally gated by an `.sumocfg` existence check; the log-read is the cleaner primitive). CORS is `*` with no auth, so any origin can drive it.
*Fix:* one FastAPI dependency rejecting any `scenario` not matching `^[A-Za-z0-9._-]+$` **and** not in `list_scenarios()` (exists at `main.py:58-61`); additionally `Path.resolve().is_relative_to(SCENARIOS_DIR)`. Apply to `get_network`, `get_adapter_log`, `start_adapter`, `stop_adapter`, `ws_endpoint`. Pairs with #8.

**#2 — README OC claim + subject naming (Med / S).** `README.md:229-231,132,129`; `TODO.md:25-27`; `docs/INTEGRATION_ROADMAP.md`.
`detector.control.*`, `group.status.*`, `group.control.*` appear only in README/TODO, never in code; the adapter publishes only `sim.{scenario}.state/.end/.log` and subscribes `sim.{scenario}.cmd.*`. Yet README:229-230 says in present tense the adapter "publishes on the same subjects OC expects". The OC TLS subject is spelled three incompatible ways.
*Fix:* reword README:229-231 to planned tense; choose one authoritative TLS-command subject (recommend `sim.{scenario}.cmd.tls`) used identically across README:132/230, TODO:27, INTEGRATION_ROADMAP; decide detector-republish namespace. Confirm spellings against OC's real `simengine_integrated.py` before finalizing.

**#3 — `sys.path` hardcode (Med / S).** `backend/{main,network,sumo_adapter}.py:2`.
All three modules start with `sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')`. Verified **load-bearing** — `sumolib` is only importable through it (the installed dist is `eclipse_sumo`, no top-level `sumolib`), so it can't just be deleted. It hardcodes the Python minor version and absolute prefix, duplicated 3×; a Python/SUMO bump breaks `import sumolib` silently.
*Fix:* derive the tools dir once (`import sumo; Path(sumo.__file__).parent/'tools'`, or `os.environ['SUMO_HOME']/'tools'` with a clear error if absent) in one shared helper imported by all three. Document the requirement in README.

**#4 — Vehicle tuple contract (Med / M).** `backend/sumo_adapter.py:108-116`; `frontend/src/ws.ts:1-2`; `frontend/src/MapView.tsx:134-137,215`; `README.md:85`.
Positional `[id, lon, lat, angle, length, width, vclass]` built in Python, re-declared as a TS tuple (only a comment links them), consumed by raw index in MapView, documented a fourth time in README. No shared schema, no runtime validation; a mid-array insert silently shifts every MapView index with no compile error.
*Fix:* destructure into named fields on the TS side; add a one-time arity assertion on the first frame; single source-of-truth comment both ends reference; append-only if ever extended.

**#5 — Historical docs (High / M).** `docs/SUMO_WEB_VIEWER_IMPLEMENTATION_PLAN.md:1-6,295-301`; `docs/INTEGRATION_ROADMAP.md:9-13,46-62`.
IMPLEMENTATION_PLAN (406 lines) is still "Design / pre-implementation" yet contradicts the shipped system on every major point (decides TraCI not libsumo; lists shipped features as out-of-scope; names nonexistent endpoints; `ScatterplotLayer` not oriented rectangles; no NATS) and has a dead link to a nonexistent `SUMO_WEB_VISUALIZATION_RESEARCH.md`. INTEGRATION_ROADMAP's "Current state" says WebSUMO owns TraCI and references the deleted `session.py`. High because these actively mislead the OC work in flight.
*Fix:* add a "HISTORICAL — superseded by libsumo+NATS; see README" banner to IMPLEMENTATION_PLAN (or move to `docs/historical/`) and remove the dead link; rewrite INTEGRATION_ROADMAP "Current state" to the shipped architecture, mark the NATS option DONE, replace `session.py` references with `sumo_adapter.py`.

**#6 — WS relay lifecycle (Med / M).** `backend/main.py:154-155,157-172,174-183`.
Each socket does `nc = await connect(...)` with no try/except after `accept()`; if NATS is down the exception propagates on an accepted socket and the `finally`'s `nc.drain()` itself `NameError`s. `on_state/on_end` swallow send errors (`except Exception: pass`), so when the browser drops, sends keep raising ~20×/s until the receive loop notices; nothing unsubscribes → leaked NATS connection + 3 subscriptions per dropped tab. (Verifier corrected the original "blocks indefinitely" — sends raise, not hang.)
*Fix:* `try/except` the connect + `websocket.close(code)`, init `nc=None` so `finally` is safe; a shared `closed` flag to stop forwarding; capture sids and unsubscribe / `nc.close()` on every exit; catch `WebSocketDisconnect` explicitly and log other exceptions.

**#7 — Dead `:9222` config (Low / S).** `nats-server.conf:3-6`; `README.md:36,26`.
`9222` appears only in the conf and README; the browser connects to FastAPI `/api/ws`, backend uses NATS TCP `:4222`. The `websocket{}` listener is a leftover from the abandoned browser→NATS design.
*Fix:* delete the block and the README `:9222` mention; clarify only `:4222` (backend↔NATS) and `:8775` (browser↔FastAPI) are used.

**#8 — CORS (Med / S).** `backend/main.py:27-32`.
`allow_origins=['*']`, all methods/headers, no auth, on endpoints that spawn/kill SUMO subprocesses and return file contents — any visited website can drive the local server. Widens #1's blast radius.
*Fix:* bind to `127.0.0.1`, set `allow_origins` to the known frontend origin; add auth if it must be network-reachable.

**#9 — Adapter lifecycle (Med / L).** `backend/main.py:36,39-55,96-115,137-148`.
`_adapter_proc` is a module global; sync `start/stop` with no lock → two concurrent Starts both pass the `poll()` check and leak a process. `_kill_orphans` SIGTERMs every `pgrep -f 'sumo_adapter.py'` system-wide at import + start + stop, so starting scenario B kills scenario A. (Multi-worker premise is hypothetical — uvicorn runs single-worker — but the race and blunt-kill are real.)
*Fix:* serialize start/stop with a lock; track processes per-scenario by PID and terminate the tracked PID; if keeping `pgrep`, match the full `ADAPTER_SCRIPT` path.

**#10 — Untrack `nats-server` (Low / S).** `nats-server`; `.gitignore:8`; `README.md:48`.
16,607,555-byte ELF (ARM64) tracked despite being in `.gitignore:8` (predates the rule); no version/checksum, non-portable, bloats history. Functionally used, so the issue is how it's shipped.
*Fix:* `git rm --cached nats-server` (keep locally); README fetches it from nats.io releases pinned to a version+platform (+ optional sha256).

**#11 — GeoJSON cache invalidation (Low / S).** `backend/network.py:11,85-87,171-173`.
`_cache` keys by net.xml path, never evicts or checks mtime → stale GeoJSON after an on-disk edit (directly conflicts with planned edit/persistence work) and unbounded growth.
*Fix:* compare net.xml mtime and/or LRU cap; also fix the `.net.xml`→`.detectors.xml` string-replace at `network.py:56` to use pathlib stem logic.

**#12 — `vclass`/`vtype` + `det_id`/`id` naming (Low / S).** `backend/sumo_adapter.py:44,115,122-124`; `backend/network.py:78`; `frontend/src/MapView.tsx:31,270-273`.
Vehicle category is `vclass` in state/inspect but the planned spawn command names it `vtype` (distinct SUMO concepts); the generator UI mixes labels. Detector id is `det_id` in the adapter but plain `id` in GeoJSON/TS — the occupancy join works only because they're the same underlying inductionLoop id, with no type link.
*Fix:* name the spawn payload field for what it is (`vtype` for typeID, `vclass` for movement class) and document the UI-label→vType mapping; pick one detector-id name across all three, with a comment that the state key and GeoJSON id must match.

**#13 — `_stretch_flows` hygiene (Low / M).** `backend/sumo_adapter.py:138-156`.
The "silently drops duration" claim was **refuted** — the regex correctly rewrites all flows on the real graph2sumo inputs. What remains: regex XML rewriting is fragile vs ElementTree (already used in network.py), and `/tmp/{scenario}.rou.{end}.xml` temp files are never cleaned up.
*Fix:* parse with ElementTree, set `end` explicitly, warn if zero flows found; write to a managed per-scenario temp dir and remove after the run. Low priority — not a live bug.

**#14 — LICENSE / tests / CI (Med / M).** repo root; `backend/main.py:21-22`; `.gitignore:6`.
No LICENSE, no tests, no CI, no `.env.example` despite reading `SCENARIOS_DIR`/`NATS_URL`. Research docs claim "verified 70/70" with nothing committed to reproduce.
*Fix:* add LICENSE (MIT/Apache-2.0 per the plan); a minimal pytest (network.py GeoJSON build against a fixture .net.xml + subject-schema smoke test); GH Actions running pytest + tsc + vite build; `.env.example`.

**#15 — Config centralization (Low / S).** `backend/main.py:21-22`; `backend/sumo_adapter.py:269`; `frontend/src/MapView.tsx:46`; `frontend/src/App.tsx:89,215`; `README.md:26`.
NATS default `nats://localhost:4222` defined independently in main.py and as a literal in sumo_adapter.py (can drift); magic numbers scattered (Helsinki map center/zoom, step_delay, clamps, 500 log cap, 3000 ms poll); README self-inconsistent on port (8775 vs 8000).
*Fix:* share the NATS default from one place; hoist frontend constants to a config module; derive the initial map center from loaded network bounds; one README line explaining 8775 (prod) vs 8000 (dev behind Vite proxy).

## Suggested batches

- **Batch A (security/correctness, do first):** #1, #8 — allowlist + CORS together.
- **Batch B (doc truth for OC work):** #2, #5, #7 — so the integration is planned against reality.
- **Batch C (robustness):** #6, #9, #3 — relay + adapter lifecycle + import path.
- **Batch D (contracts):** #4, #12 — before the generator/OC join is built.
- **Batch E (hygiene, low urgency):** #10, #11, #13, #14, #15.
