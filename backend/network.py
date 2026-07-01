import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import sumolib

_cache: dict[str, dict] = {}


def build_network_geojson(net_xml_path: str) -> dict:
    if net_xml_path in _cache:
        return _cache[net_xml_path]

    net = sumolib.net.readNet(net_xml_path, withInternal=False)
    features = []

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
