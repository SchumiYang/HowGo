"""Guard: indoor nav edges must not run through walls (indoor/mapdata/tools/nav_wall_check.py).

positioning/grid.ts carves free space along nav edges, so an edge crossing a wall lets the position estimate pass
through it, and the route is drawn through it. Fails on the live venue data and checks the checker itself.
"""
import importlib.util
import json
from pathlib import Path

import pytest

MAPDATA = Path(__file__).resolve().parents[2] / "indoor" / "mapdata"
_spec = importlib.util.spec_from_file_location("nav_wall_check", MAPDATA / "tools" / "nav_wall_check.py")
chk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(chk)


@pytest.mark.skipif(not (MAPDATA / "data" / "tianmu" / "nav.geojson").exists(), reason="no venue data")
def test_tianmu_nav_edges_do_not_cross_walls():
    bad = chk.crossings(str(MAPDATA / "data" / "tianmu"))
    assert bad == [], "\n".join(f"{c['edge']} crosses {c['layer']} #{c['wall']} at {c['at']}" for c in bad)
    # a node on a wall line would hide a crossing behind the end trim: only declared openings may sit there
    issues = chk.node_issues(str(MAPDATA / "data" / "tianmu"))
    assert issues == [], "\n".join(f"{n['node']} at {n['at']}: {n['issue']}" for n in issues)


def _venue(tmp_path, edges, walls):
    v = tmp_path / "v"
    (v / "levels" / "1F").mkdir(parents=True, exist_ok=True)
    nodes = {n: xy for e in edges for n, xy in (e[0], e[1])}
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": list(xy)},
              "properties": {"kind": "node", "id": n, "level": "1F"}} for n, xy in nodes.items()]
    feats += [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(a[1]), list(b[1])]},
               "properties": {"kind": "edge", "from": a[0], "to": b[0], "type": t, "accessible": True, "length_m": 1}}
              for a, b, t in edges]
    (v / "nav.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    wf = [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": c}, "properties": {"layer": layer}}
          for c, layer in walls]
    (v / "levels" / "1F" / "walls.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": wf}))
    return str(v)


def test_checker_flags_interior_crossings_only(tmp_path):
    wall = ([[5, -1], [5, 1]], "wall")
    # crossing in the middle of an edge
    d = _venue(tmp_path, [(("a", (0, 0)), ("b", (10, 0)), "corridor")], [wall])
    assert [c["at"] for c in chk.crossings(d)] == [[5.0, 0.0]]
    # a door node sitting in the opening: the crossing is within the trimmed end
    d = _venue(tmp_path, [(("a", (0, 0)), ("d", (5.3, 0)), "door")], [wall])
    assert chk.crossings(d) == []
    # non-blocking layers (door leaves, fixtures, seat-row 'other') don't count
    d = _venue(tmp_path, [(("a", (0, 0)), ("b", (10, 0)), "corridor")], [([[5, -1], [5, 1]], "door")])
    assert chk.crossings(d) == []
    # a node placed on the wall hides the crossing behind the end trim: reported unless declared
    d = _venue(tmp_path, [(("a", (0, 0)), ("w", (5, 0)), "corridor"), (("w", (5, 0)), ("b", (10, 0)), "corridor")], [wall])
    assert chk.crossings(d) == [] and [n["node"] for n in chk.node_issues(d)] == ["w"]
    # elevator connectors are vertical: not checked
    d = _venue(tmp_path, [(("a", (0, 0)), ("b", (10, 0)), "elevator")], [wall])
    assert chk.crossings(d) == []
