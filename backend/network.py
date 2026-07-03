import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import json
import math
import pathlib
import xml.etree.ElementTree as ET

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


def _cross_lane_coords(shape, offset: float, net, half_width: float = 2.2) -> list | None:
    """Short line segment across the lane at the given offset along its shape."""
    if len(shape) < 2:
        return None
    # walk the polyline to find the segment containing the offset
    walked = 0.0
    for (x1, y1), (x2, y2) in zip(shape[:-1], shape[1:]):
        seg = math.dist((x1, y1), (x2, y2))
        if seg == 0:
            continue
        if walked + seg >= offset:
            f = (offset - walked) / seg
            x = x1 + (x2 - x1) * f
            y = y1 + (y2 - y1) * f
            dx, dy = (x2 - x1) / seg, (y2 - y1) / seg
            px, py = -dy, dx
            lon_l, lat_l = net.convertXY2LonLat(x + px * half_width, y + py * half_width)
            lon_r, lat_r = net.convertXY2LonLat(x - px * half_width, y - py * half_width)
            return [[lon_l, lat_l], [lon_r, lat_r]]
        walked += seg
    return None


def _detector_features(net_xml_path: str, net) -> list:
    """Detector positions from {scenario}.detectors.xml, as cross-lane bars."""
    p = pathlib.Path(net_xml_path)
    det_xml = p.parent / (p.name.replace('.net.xml', '.detectors.xml'))
    if not det_xml.exists():
        return []

    features = []
    for loop in ET.parse(det_xml).getroot().iter('inductionLoop'):
        lane_id = loop.get('lane', '')
        try:
            lane = net.getLane(lane_id)
        except KeyError:
            continue
        length = lane.getLength()
        pos = float(loop.get('pos', 0))
        offset = pos if pos >= 0 else length + pos
        offset = max(0.0, min(offset, length))
        coords = _cross_lane_coords(lane.getShape(), offset, net)
        if coords is None:
            continue
        features.append({
            'type': 'Feature',
            'properties': {
                'type': 'detector',
                'id': loop.get('id', ''),
            },
            'geometry': {'type': 'LineString', 'coordinates': coords},
        })
    return features


def build_network_geojson(net_xml_path: str) -> dict:
    if net_xml_path in _cache:
        return _cache[net_xml_path]

    net = sumolib.net.readNet(net_xml_path, withInternal=False, withPrograms=True)
    features = []

    # TLS programs keyed by junction ID (static inspection before Start)
    tls_programs: dict[str, dict] = {}
    for tls in net.getTrafficLights():
        tls_programs[tls.getID()] = {
            pid: [[ph.duration, ph.state] for ph in prog.getPhases()]
            for pid, prog in tls.getPrograms().items()
        }

    # Junction area polygons (rendered as filled shapes)
    for node in net.getNodes():
        shape = node.getShape()
        if len(shape) < 3:
            continue
        coords = [list(net.convertXY2LonLat(x, y)) for x, y in shape]
        coords.append(coords[0])  # close ring
        props = {
            'id': node.getID(),
            'type': 'junction-area',
            'node_type': node.getType(),
        }
        if node.getID() in tls_programs:
            props['tls_programs'] = json.dumps(tls_programs[node.getID()])
        features.append({
            'type': 'Feature',
            'properties': props,
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

    # Induction loop detectors (bars across lanes, live status via deck.gl)
    features.extend(_detector_features(net_xml_path, net))

    geojson = {'type': 'FeatureCollection', 'features': features}
    _cache[net_xml_path] = geojson
    return geojson
