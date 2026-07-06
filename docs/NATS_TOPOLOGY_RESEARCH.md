# Connecting WebSUMO's Local NATS to a Distributed NATS Ecosystem
## Best-practices research & recommendation

*Researched 2026-07-06 via multi-source web search over the official NATS
documentation (docs.nats.io), Synadia material, and NATS GitHub. The automated
synthesis step of the research run was cut short by a session limit, so this
report was assembled by hand from the collected, source-cited findings. Claims
are tagged **[verified]** (passed adversarial vote) or **[doc]** (sourced to
official NATS docs but not independently vote-checked — treat as reliable
documentation fact).*

## The problem

Today WebSUMO runs against **one local `nats-server`** (single binary, TCP
:4222) on the same host. The libsumo adapter publishes `sim.{scenario}.state`,
`.end`, `.log` and subscribes `sim.{scenario}.cmd.*`; a FastAPI relay bridges
the browser. We want to keep the viewer **self-contained** (fully functional
with just its local NATS, no external dependency) while being able to
**exchange the relevant messages** with a wider NATS ecosystem when deployed
alongside the Open Controller (OC) and other containerised services — where OC
uses flat subjects like `detector.control.*` and `group.control.*`.

## The four options

### 1. NATS leaf node — **recommended**

A leaf node is a `nats-server` that serves its own local clients normally and
**transparently routes messages to/from one or more remote NATS systems**.

- **[verified]** "A leafnode server will transparently route messages as needed
  from local clients to one or more remote NATS system(s) and vice versa." It
  serves local clients independently while bridging to a hub — exactly the
  self-contained-but-connectable requirement. (docs.nats.io/…/leafnodes)
- **[verified]** "A Leaf Node extends an existing NATS system … optionally
  bridging both operator and security domains" — so WebSUMO's local NATS keeps
  its own account/auth boundary, distinct from the central OC hub.
- **[doc]** A leaf node **keeps serving its local clients even when
  disconnected from the upstream cluster** (adaptive edge deployment) — the
  viewer never breaks just because the hub is down or absent.
- **[doc]** Config shape: a `leafnodes { }` block (default listen port **7422**)
  to accept inbound leaf links, and/or a `remotes` list where each entry gives a
  `url` with the `nats-leaf://` scheme to dial *out* to a hub. The outbound
  `remotes` entry is bound to a local `account`.
- **[doc]** Propagation is **selectively controllable**: `deny_imports` /
  `deny_exports` stop specific subjects crossing in either direction, and the
  connecting user's publish/subscribe permissions scope what is exported vs
  imported. So we can bridge *only* `detector.control.*` / `group.control.*` /
  a TLS-command subject and **never leak the browser-facing `sim.{scenario}.*`
  state stream** onto the shared bus.

Why it fits: single extra binary (we already ship `nats-server`), no code
change to the adapter (it still dials `localhost:4222`), works offline, and the
link to the hub is pure configuration that can be absent in standalone mode.

### 2. Gateways / superclusters — overkill

- **[doc]** Gateways connect **entire clusters** into a full-mesh supercluster,
  operating at the cluster level, not at the individual-node or client level.
- **[doc]** They exist to cut connection count at multi-region scale (e.g. 30
  nodes across 3 clusters = 180 gateway connections vs 4,005 full-mesh).

That is a multi-datacenter concern. WebSUMO is a single edge participant, not a
cluster peer — gateways are the wrong tool here. Rule out.

### 3. Two-connection bridge (adapter or a small bridge process) — not idiomatic

Hold two `nats-py` connections (local + remote) and forward selected subjects.

- **[doc]** NATS *does* ship an official multi-connector, **`nats-replicator`**,
  which one-way replicates messages between endpoints — so the pattern isn't
  unheard of. **But**: it is **unidirectional** (bidirectional exchange needs
  multiple connectors), has **no request-reply**, and the repo is **effectively
  deprecated** — last release v0.1.0 (Sep 2019), archived read-only (Jan 2026).
- Hand-rolling it in the adapter means owning reconnection to *two* servers,
  loop prevention, and subject-mapping yourself — all of which leaf nodes give
  for free. **[doc]** `nats-py` exposes `reconnect_time_wait` for pacing, so it
  is *possible*, but it re-implements the wheel.

Verdict: acceptable as a tiny stopgap, but strictly inferior to a leaf node for
anything lasting. The official tooling being archived is itself a signal that
leaf nodes are the blessed path.

### 4. Supporting mechanisms (use *with* the leaf node)

- **Accounts for subject-space isolation** — **[doc]** subjects are not shared
  across accounts, so WebSUMO's `sim.{scenario}.*` and OC's flat
  `detector.control.*` / `group.control.*` **cannot collide** if they live in
  separate accounts. **[doc]** Cross-account flow is **opt-in and explicit**: a
  consuming account's `import` must match an exporting account's `export` —
  fine-grained control over exactly which subjects cross.
- **Subject mapping / transforms** — **[doc]** rewrite subjects as they enter a
  scope; act as both translation and filter across accounts/leaf nodes;
  configured at the account level (server config + reload, or JWT/nsc). **[doc]**
  Token reordering with `$1`/`$2` (e.g. `bar.*.*: baz.$2.$1`) — the official
  mechanism for migrating/reconciling namespaces. If we ever need to expose a
  scoped subject to OC's flat space (or vice versa), this is how, without
  touching adapter code.
- **JetStream sourcing/mirroring** — **[doc]** commonly used across a
  hub-cluster + leaf-node topology; the path if we later want to **persist or
  replay** runs across the local-to-central link.
- **Loop / duplicate safety** — **[doc]** a known leafnode+JetStream case can
  double-deliver a message across a bridge; **[doc]** the `Nats-Msg-Id` header +
  JetStream duplicate window dedupes server-side. Relevant only if we bridge
  JetStream; plain core-NATS pub/sub over a single leaf link does not loop.

## Decision matrix

| Criterion | Leaf node | Gateway | 2-conn bridge |
|---|---|---|---|
| Self-contained standalone | ✅ serves locally, survives hub outage | ⚠️ cluster-oriented | ✅ local half works |
| Operational complexity | ✅ one binary + config | ❌ cluster setup | ⚠️ custom code/process |
| Security / account isolation | ✅ own operator+security domain | ✅ | ⚠️ manual |
| Subject-namespace control | ✅ deny_imports/exports + accounts + mapping | ⚠️ cluster-wide | ⚠️ manual filtering |
| Selective propagation (only OC subjects) | ✅ built-in | ❌ propagates broadly | ✅ but manual |
| Latency | ✅ local hop, lazy upstream | ✅ | ⚠️ extra process hop |
| Failure modes | ✅ auto-reconnect, offline-tolerant | cluster-level | ❌ own both reconnects + loops |
| Fit with single-binary deploy + nats-py | ✅ adapter unchanged (localhost) | ❌ | ⚠️ adapter grows |

## Recommendation

**Run the local `nats-server` as a leaf node.** The adapter and relay keep
dialing `localhost:4222` unchanged; standalone mode is literally today's setup
with no `remotes` configured. When deployed next to OC, add a `remotes` entry
pointing at the central hub and constrain propagation so only the
control-plane subjects cross.

**Standalone (today, unchanged):**
```
# nats-server.conf
port: 4222
```

**Connected (add when a hub exists) — sketch:**
```
port: 4222

# dial out to the central hub as a leaf
leafnodes {
  remotes = [
    {
      url: "nats-leaf://HUB_HOST:7422"
      account: "OC_BRIDGE"          # local account bound to the link
      credentials: "/etc/websumo/leaf.creds"   # if the hub requires auth
      # only let control-plane subjects cross; never the browser state stream
      deny_export: ["sim.>"]        # don't push sim.* up to the hub
      deny_import: ["sim.>"]        # don't pull anyone's sim.* down
    }
  ]
}

accounts {
  # viewer's private space — stays local, never bridged
  VIEWER   { users: [ { user: "websumo", password: "..." } ] }
  # the bridged control-plane space shared with OC
  OC_BRIDGE {
    # subjects here (detector.control.*, group.control.*, tls cmd) ride the leaf
  }
}
```

**Subject/namespace plan:**
- `sim.{scenario}.state|end|log|cmd.*` → the **VIEWER** account, **never
  bridged** (browser-only; `deny_export`/`deny_import` `sim.>`).
- OC-facing `detector.control.*`, `group.control.*`, and the chosen TLS-command
  subject → the **OC_BRIDGE** account, bridged over the leaf. The adapter's OC
  work (TODO item 1) publishes/subscribes these; keep them in the bridged
  account. If OC's flat names ever need reconciling with a scoped form, use
  **subject mapping** at the account boundary rather than changing code.
- This directly resolves the flat-vs-scoped tension noted in the OC integration
  TODO: the two namespaces live in **different accounts**, so they can't collide
  and only the explicitly-exported ones travel.

**Migration path:**
1. **Now:** nothing changes — single `port: 4222` broker, no leaf config. (This
   is already how WebSUMO ships; the recommendation adds zero cost today.)
2. **When OC integration lands (TODO item 1):** put the OC subjects in their own
   account; verify locally with a second `nats-server` acting as a mock hub.
3. **On deployment beside OC:** add the `remotes` block pointing at the real
   hub + credentials; confirm `deny_*` keeps `sim.*` local with `nats sub`.
4. **If persistence/replay is ever wanted:** add JetStream + sourcing across the
   leaf, with `Nats-Msg-Id` dedup.

**Do not** adopt gateways (cluster-scale, wrong level) or a hand-rolled
two-connection bridge (the official tool for it is archived; leaf nodes
supersede it) as the primary mechanism.

## References

- NATS — Leaf Nodes: https://docs.nats.io/running-a-nats-service/configuration/leafnodes
- NATS — Leaf Node config reference: https://docs.nats.io/running-a-nats-service/configuration/leafnodes/leafnode_conf
- NATS — Adaptive edge deployment: https://docs.nats.io/nats-concepts/service_infrastructure/adaptive_edge_deployment
- NATS — Accounts: https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts
- NATS — Subject mapping & transforms: https://docs.nats.io/nats-concepts/subject_mapping · https://docs.nats.io/running-a-nats-service/configuration/configuring_subject_mapping
- NATS — Gateways: https://docs.nats.io/running-a-nats-service/configuration/gateways
- NATS — JetStream source & mirror: https://docs.nats.io/nats-concepts/jetstream/source_and_mirror
- NATS — JetStream headers (Nats-Msg-Id dedup): https://docs.nats.io/nats-concepts/jetstream/headers
- nats-replicator (archived): https://github.com/nats-io/nats-replicator
- Leafnode double-delivery report: https://github.com/nats-io/nats-server/issues/3191
- nats-py reconnect: https://docs.nats.io/using-nats/developer/connecting/reconnect/wait

*Caveat: automated verification was truncated by a session limit, so several
`[doc]` claims above carry a single citation rather than a full 3-vote check.
They are drawn from official NATS documentation and are consistent with the
verified core (leaf nodes are the idiomatic self-contained-but-connectable
pattern), but re-confirm the exact config keys against the linked docs before
committing config.*
