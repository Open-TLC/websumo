"""Open Controller (OC) ↔ SUMO join for the `--opencontroller` display mode.

WebSUMO renders SUMO geometry; OC owns the control plane. To draw OC signal
groups on the map we need to know, for each OC group, which SUMO traffic-light
signal indices (links) it controls — and how OC's NATS subjects key onto those
indices. This module builds that join from an OC controller config, and is
deliberately small and dependency-free (json + stdlib) so it can run in the
backend or as a standalone check.

Two OC numbering schemes exist and must not be confused (verified against the OC
codebase, 2026-08-15):

- ``group.status.<ctrl>.<N>`` — published by the *distributed simengine*
  (`services/simengine/src/outputs.py::GroupStorage`). It iterates the SUMO TLS
  ``getRedYellowGreenState()`` string and emits one subject per **signal index**,
  so ``N`` is the raw SUMO link/signal index (position in the RYG string).
  Join to WebSUMO is therefore trivial: ``group.status.<ctrl>.N`` ↔ the stopline
  whose ``sig_idx == N`` on TLS ``<ctrl>_*``.

- ``group.control.<ctrl>.<M>`` — published by the *control engine*. Here ``M`` is
  OC's own 1-based group number, and one group can drive several links. The
  link membership is the **positional** ``group_outputs`` list:
  ``group_outputs[i]`` is the group name controlling signal index ``i`` (and a
  group name repeats once per extra link — e.g. JS270 ``group1`` → links [0, 1]).

For P1 we consume ``group.status`` (needs only the simengine) but present it as
OC *groups*: the per-index live state is aggregated/labelled by the group name
from ``group_outputs``, which is the OC abstraction SUMO lacks.

The geometry half of the join (signal index → lanes → stopline coordinates)
already lives in ``network.py`` / sumolib; this module intentionally does NOT
read the net — it maps indices and names only, so the two halves stay decoupled.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional


def _strip_json_comments(text: str) -> str:
    """OC config files are JSON-with-//-comments (they use jsmin). Strip //
    line comments so the stdlib json parser accepts them. Kept minimal: it does
    not attempt to preserve `//` inside string literals, which OC configs don't
    use (paths use forward slashes but always as part of `"..."` values without
    a leading `//`)."""
    return re.sub(r"//[^\n]*", "", text)


@dataclass
class OCGroup:
    """One OC signal group and the SUMO signal indices it controls."""

    name: str                      # OC group name, e.g. "group1"
    links: list[int]               # SUMO signal indices this group drives
    control_number: Optional[int] = None   # 1-based group.control.<ctrl>.M number
    timing: dict = field(default_factory=dict)  # min/max green etc. from config


@dataclass
class OCJoin:
    """The full group↔link join for one OC controller / SUMO TLS."""

    controller: str                # OC controller name, e.g. "JS270"
    tls_id: str                    # SUMO TLS id, e.g. "270_Tyyn_Vali"
    subject_key: str               # subject infix, e.g. "270" (from tls_id.split('_')[0])
    num_links: int                 # number of signal indices (len of group_outputs)
    link_group: dict[int, str]     # signal index → OC group name
    groups: dict[str, OCGroup]     # group name → OCGroup

    def status_subject(self, sig_idx: int) -> str:
        """The `group.status.*` subject carrying the live state of a signal index."""
        return f"group.status.{self.subject_key}.{sig_idx}"

    def group_of_index(self, sig_idx: int) -> Optional[str]:
        return self.link_group.get(sig_idx)

    def to_frontend(self) -> dict:
        """Compact JSON the browser needs to render OC groups: the index→group
        map, per-group member links + timing, and the subject key. Live state is
        streamed separately (per-index `group.status`)."""
        return {
            "controller": self.controller,
            "tls_id": self.tls_id,
            "subject_key": self.subject_key,
            "num_links": self.num_links,
            "link_group": {str(k): v for k, v in self.link_group.items()},
            "groups": {
                g.name: {
                    "links": g.links,
                    "control_number": g.control_number,
                    "timing": g.timing,
                }
                for g in self.groups.values()
            },
        }


def build_join_from_controller_conf(path: str) -> OCJoin:
    """Build an :class:`OCJoin` from an OC controller config file.

    Reads the ``controller`` block: ``sumo_name`` (the SUMO TLS id),
    ``group_outputs`` (positional index→group list), and ``signal_groups``
    (per-group timing). Does not touch the SUMO net.
    """
    conf = json.loads(_strip_json_comments(open(path).read()))
    ctrl = conf.get("controller", conf)

    controller = ctrl.get("name", "unknown")
    tls_id = ctrl["sumo_name"]
    subject_key = tls_id.split("_")[0]
    group_outputs: list[str] = ctrl["group_outputs"]
    signal_groups: dict = ctrl.get("signal_groups", {})

    # signal index → group name (positional), and its inverse
    link_group: dict[int, str] = {i: g for i, g in enumerate(group_outputs)}
    members: dict[str, list[int]] = defaultdict(list)
    for i, g in enumerate(group_outputs):
        members[g].append(i)

    # OC's group.control.<ctrl>.M number. Authoritative source is the group's
    # `channel` field (e.g. "group.control.270.1"); parse its trailing number.
    # Fall back to trailing digits of the group name (group1 → 1). NOTE: the
    # 1-based order within `signal_groups` is NOT reliable — the dict starts with
    # a "default" template entry that is not a real group and shifts the count.
    def control_number(name: str) -> Optional[int]:
        chan = signal_groups.get(name, {}).get("channel", "")
        m = re.search(r"(\d+)\s*$", chan)
        if m:
            return int(m.group(1))
        m = re.search(r"\d+", name)
        return int(m.group()) if m else None

    groups: dict[str, OCGroup] = {}
    for name, links in members.items():
        groups[name] = OCGroup(
            name=name,
            links=links,
            control_number=control_number(name),
            timing=signal_groups.get(name, {}),
        )

    return OCJoin(
        controller=controller,
        tls_id=tls_id,
        subject_key=subject_key,
        num_links=len(group_outputs),
        link_group=link_group,
        groups=groups,
    )


if __name__ == "__main__":
    # Self-test / demo against OC's JS270 controller config. Prints the join and
    # asserts the invariants verified against a live OC bus run (16 links,
    # group1 spanning links [0, 1]).
    import sys

    default = ("/repos/graph2sumo/vendor/open_controller/"
               "models/JS270_DEMO/contr/JS270_DEMO.json")
    path = sys.argv[1] if len(sys.argv) > 1 else default
    j = build_join_from_controller_conf(path)

    print(f"controller={j.controller}  tls_id={j.tls_id}  key={j.subject_key}  "
          f"num_links={j.num_links}")
    print("\nsignal index → group → status subject:")
    for i in range(j.num_links):
        print(f"  {i:<2} → {j.group_of_index(i):<8} → {j.status_subject(i)}")
    print("\nOC group → member links (control#):")
    for name in sorted(j.groups, key=lambda x: j.groups[x].control_number or 0):
        g = j.groups[name]
        print(f"  {g.name:<8} ctrl#{g.control_number} → links {g.links}"
              f"  min_green={g.timing.get('min_green')}")

    # invariants
    assert j.tls_id == "270_Tyyn_Vali", j.tls_id
    assert j.num_links == 16, j.num_links
    assert j.groups["group1"].links == [0, 1], j.groups["group1"].links
    print("\nself-test OK")
