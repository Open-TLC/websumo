import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import math
import sumolib

_cache: dict[str, dict] = {}


def _stopline_coords(shape, net, half_width: float = 1.8) -> list | None:
    """Perpendicular line segment at the end of a lane shape, in WGS84."""
    if len(shape) < 2:
        return None
    x1, y1 = shape[-2]
    x2, y2 = shape[-1]
    dx, dy = x2 - x1, y2 - y1
    L = math.sqrt(dx * dx + dy * dy)
    if L == 0:
        return None
    px, py = -dy / L, dx / L
    lon_l, lat_l = net.convertXY2LonLat(x2 + px * half_width, y2 + py * half_width)
    lon_r, lat_r = net.convertXY2LonLat(x2 - px * half_width, y2 - py * half_width)
    return [[lon_l, lat_l], [lon_r, lat_r]]


def build_network_geojson(net_xml_path: str) -> dict:
    if net_xml_path in _cache:
        return _cache[net_xml_path]

    net = sumolib.net.readNet(net_xml_path, withInternal=False)
    features = []

    # Junction area polygons (rendered as filled shapes)
    for node in net.getNodes():
        shape = node.getShape()
        if len(shape) < 3:
            continue
        coords = [list(net.convertXY2LonLat(x, y)) for x, y in shape]
        coords.append(coords[0])  # close ring
        features.append({
            'type': 'Feature',
            'properties': {'id': node.getID(), 'type': 'junction-area'},
            'geometry': {'type': 'Polygon', 'coordinates': [coords]},
        })

    # Lane centerlines
    for edge in net.getEdges():
        if edge.getFunction() == 'internal':
            continue
        for lane in edge.getLanes():
            shape = lane.getShape()
            if len(shape) < 2:
                continue
            coords = [list(net.convertXY2LonLat(x, y)) for x, y in shape]
            features.append({
                'type': 'Feature',
                'properties': {'id': lane.getID(), 'type': 'lane'},
                'geometry': {'type': 'LineString', 'coordinates': coords},
            })

    # TLS stop lines — one per incoming lane, mapped to its signal index
    seen_lanes: set[str] = set()
    for tls in net.getTrafficLights():
        tls_id = tls.getID()
        for sig_idx, conns in tls.getLinks().items():
            for from_lane, _to_lane, _via in conns:
                lane_id = from_lane.getID()
                if lane_id in seen_lanes:
                    continue
                seen_lanes.add(lane_id)
                coords = _stopline_coords(from_lane.getShape(), net)
                if coords is None:
                    continue
                features.append({
                    'type': 'Feature',
                    'properties': {
                        'type': 'stopline',
                        'tls_id': tls_id,
                        'sig_idx': int(sig_idx),
                    },
                    'geometry': {'type': 'LineString', 'coordinates': coords},
                })

    # Junction centre points
    for node in net.getNodes():
        x, y = node.getCoord()
        lon, lat = net.convertXY2LonLat(x, y)
        features.append({
            'type': 'Feature',
            'properties': {'id': node.getID(), 'type': 'junction'},
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        })

    geojson = {'type': 'FeatureCollection', 'features': features}
    _cache[net_xml_path] = geojson
    return geojson
