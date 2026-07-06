import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { PolygonLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Vehicle } from './ws'

export interface MapViewHandle {
  updateStep: (vehicles: Vehicle[], tls: Record<string, string>, detectors: Record<string, boolean>, t: number) => void
  setBasemap: (on: boolean) => void
  fitNetwork: (gj: GeoJSON.FeatureCollection) => void
  setSelected: (kind: 'vehicle' | 'tls' | null, id: string | null) => void
}

interface Props {
  networkGeoJSON: GeoJSON.FeatureCollection | null
  onPick?: (kind: 'vehicle' | 'tls', id: string, props: Record<string, unknown>) => void
  onPickAway?: () => void
  onGenerate?: (edge: string, lane: number, vtypes: string[]) => void
}

interface StopLine {
  from: [number, number]
  to: [number, number]
  tlsId: string
  sigIdx: number
}

interface Detector {
  from: [number, number]
  to: [number, number]
  id: string
}

interface Generator {
  position: [number, number]
  edge: string
  lane: number
  vtypes: string[]
}

function tlsColor(stateStr: string | undefined, sigIdx: number): [number, number, number, number] {
  switch (stateStr?.[sigIdx]) {
    case 'G':
    case 'g': return [30, 210, 80, 255]
    case 'r':
    case 'R': return [220, 30, 30, 255]
    case 'y':
    case 'Y': return [230, 200, 0, 255]
    default:  return [140, 140, 140, 180]
  }
}

const M_PER_DEG_LAT = 111320

function vehiclePolygon(
  lon: number, lat: number,
  angleDeg: number, length: number, width: number,
): [number, number][] {
  const θ = (angleDeg * Math.PI) / 180
  // SUMO: 0=north,90=east,clockwise → forward ENU vector (east, north)
  const fE = Math.sin(θ), fN = Math.cos(θ)
  // right vector (90° clockwise from forward)
  const rE = Math.cos(θ), rN = -Math.sin(θ)
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
  const corner = (fwd: number, right: number): [number, number] => [
    lon + (fE * fwd + rE * right) / mPerDegLon,
    lat + (fN * fwd + rN * right) / M_PER_DEG_LAT,
  ]
  const w = width / 2
  // getPosition returns front-bumper centre; extend backwards by length
  return [corner(0, w), corner(0, -w), corner(-length, -w), corner(-length, w)]
}

function vehicleColor(vclass: string): [number, number, number, number] {
  switch (vclass) {
    case 'tram':
    case 'rail_urban': return [60, 180, 255, 240]
    case 'bus':        return [80, 210, 100, 240]
    case 'truck':
    case 'trailer':    return [210, 120, 40, 240]
    default:           return [255, 165, 40, 240]
  }
}

const BLANK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#12121f' } }],
}

export const MapView = forwardRef<MapViewHandle, Props>(({ networkGeoJSON, onPick, onPickAway, onGenerate }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const deckRef = useRef<MapboxOverlay | null>(null)
  const stopLinesRef = useRef<StopLine[]>([])
  const detectorsRef = useRef<Detector[]>([])
  const generatorsRef = useRef<Generator[]>([])
  const selectedRef = useRef<{ kind: string; id: string } | null>(null)
  const lastStepRef = useRef<{ vehicles: Vehicle[]; tls: Record<string, string>; detectors: Record<string, boolean> }>(
    { vehicles: [], tls: {}, detectors: {} })
  const onPickRef = useRef(onPick)
  const onPickAwayRef = useRef(onPickAway)
  const onGenerateRef = useRef(onGenerate)
  onPickRef.current = onPick
  onPickAwayRef.current = onPickAway
  onGenerateRef.current = onGenerate

  const renderDeck = (
    vehicles: Vehicle[],
    tls: Record<string, string>,
    detectors: Record<string, boolean>,
  ) => {
    lastStepRef.current = { vehicles, tls, detectors }
    const sel = selectedRef.current
    const selVehicle = sel?.kind === 'vehicle' ? sel.id : null
    deckRef.current?.setProps({
      layers: [
        new LineLayer<Detector>({
          id: 'detectors',
          data: detectorsRef.current,
          getSourcePosition: (d) => d.from,
          getTargetPosition: (d) => d.to,
          // occupied = bright cyan, clear = steel blue
          getColor: (d) => detectors[d.id]
            ? [0, 240, 255, 255]
            : [120, 150, 210, 230],
          getWidth: (d) => detectors[d.id] ? 6 : 3,
          widthUnits: 'pixels',
          updateTriggers: { getColor: detectors, getWidth: detectors },
        }),
        new LineLayer<StopLine>({
          id: 'stoplines',
          data: stopLinesRef.current,
          getSourcePosition: (d) => d.from,
          getTargetPosition: (d) => d.to,
          getColor: (d) => tlsColor(tls[d.tlsId], d.sigIdx),
          getWidth: 3,
          widthUnits: 'pixels',
          updateTriggers: { getColor: tls },
        }),
        new ScatterplotLayer<Generator>({
          id: 'generators',
          data: generatorsRef.current,
          getPosition: (d) => d.position,
          getRadius: 4,   // one per lane — kept small so adjacent lanes separate on zoom
          radiusUnits: 'pixels',
          radiusMinPixels: 3,
          getFillColor: [40, 200, 90, 210],
          getLineColor: [230, 255, 235, 240],
          lineWidthMinPixels: 1,
          stroked: true,
          pickable: true,
        }),
        new PolygonLayer<Vehicle>({
          id: 'vehicles',
          data: vehicles,
          getPolygon: (d) => vehiclePolygon(d[1], d[2], d[3], d[4], d[5]),
          getFillColor: (d) => vehicleColor(d[6]),
          getLineColor: (d) => d[0] === selVehicle ? [0, 240, 255, 255] : [0, 0, 0, 80],
          getLineWidth: (d) => d[0] === selVehicle ? 1.2 : 0.3,
          lineWidthUnits: 'meters',
          lineWidthMinPixels: 0.5,
          pickable: true,
        }),
      ],
    })
  }

  useImperativeHandle(ref, () => ({
    setBasemap(on: boolean) {
      const map = mapRef.current
      if (map?.getLayer('basemap-l')) {
        map.setPaintProperty('basemap-l', 'raster-opacity', on ? 1 : 0)
      }
    },
    fitNetwork(gj: GeoJSON.FeatureCollection) {
      const map = mapRef.current
      if (!map) return
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
      for (const f of gj.features) {
        const g = f.geometry
        const pts: number[][] =
          g.type === 'LineString' ? g.coordinates
          : g.type === 'Point' ? [g.coordinates]
          : g.type === 'Polygon' ? g.coordinates[0]
          : []
        for (const [lon, lat] of pts) {
          if (lon < minLon) minLon = lon
          if (lon > maxLon) maxLon = lon
          if (lat < minLat) minLat = lat
          if (lat > maxLat) maxLat = lat
        }
      }
      if (isFinite(minLon)) {
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, maxZoom: 18 })
      }
    },
    updateStep(vehicles: Vehicle[], tls: Record<string, string>, detectors: Record<string, boolean>) {
      renderDeck(vehicles, tls, detectors)
    },
    setSelected(kind, id) {
      selectedRef.current = kind && id ? { kind, id } : null
      const { vehicles, tls, detectors } = lastStepRef.current
      renderDeck(vehicles, tls, detectors)
      const map = mapRef.current
      if (map?.getLayer('junction-area-outline')) {
        const selJunction = kind === 'tls' ? id : ''
        map.setPaintProperty('junction-area-outline', 'line-color',
          ['case', ['==', ['get', 'id'], selJunction], '#00f0ff', '#3a3a60'])
        map.setPaintProperty('junction-area-outline', 'line-width',
          ['case', ['==', ['get', 'id'], selJunction], 2.5, 1])
      }
    },
  }))

  // Initialise map once
  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BLANK_STYLE,
      center: [24.92, 60.165],
      zoom: 15,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    const deck = new MapboxOverlay({ layers: [] })
    map.addControl(deck)
    mapRef.current = map
    deckRef.current = deck

    // unified picking: deck.gl generators (explicit markers) then vehicles,
    // then MapLibre junction areas, else deselect
    map.on('click', (e) => {
      const pick = deck.pickObject?.({
        x: e.point.x, y: e.point.y, radius: 6, layerIds: ['generators', 'vehicles'],
      })
      if (pick?.object) {
        if (pick.layer?.id === 'generators') {
          const g = pick.object as Generator
          onGenerateRef.current?.(g.edge, g.lane, g.vtypes)
        } else {
          onPickRef.current?.('vehicle', (pick.object as Vehicle)[0], {})
        }
        return
      }
      const feats = map.queryRenderedFeatures(e.point, { layers: ['junction-areas'] })
      const tlsFeat = feats.find((f) => f.properties?.node_type === 'traffic_light')
      if (tlsFeat) {
        onPickRef.current?.('tls', tlsFeat.properties!.id as string, tlsFeat.properties ?? {})
        return
      }
      onPickAwayRef.current?.()
    })

    // CartoDB Light basemap — hidden by default, toggled via setBasemap()
    map.once('load', () => {
      map.addSource('basemap', {
        type: 'raster',
        tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'],
        tileSize: 256,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
          '© <a href="https://carto.com/attributions">CARTO</a>',
      })
      map.addLayer({ id: 'basemap-l', type: 'raster', source: 'basemap',
                     paint: { 'raster-opacity': 0 } })
    })
    return () => { map.remove() }
  }, [])

  // Load network geometry when GeoJSON arrives
  useEffect(() => {
    const map = mapRef.current
    if (!map || !networkGeoJSON) return

    const SOURCE = 'network'

    const addLayers = () => {
      // Parse stop lines into ref for deck.gl use
      stopLinesRef.current = networkGeoJSON.features
        .filter((f) => f.properties?.type === 'stopline')
        .map((f) => {
          const coords = (f.geometry as GeoJSON.LineString).coordinates
          return {
            from: coords[0] as [number, number],
            to: coords[1] as [number, number],
            tlsId: f.properties!.tls_id as string,
            sigIdx: f.properties!.sig_idx as number,
          }
        })

      // Parse detectors into ref for deck.gl use
      detectorsRef.current = networkGeoJSON.features
        .filter((f) => f.properties?.type === 'detector')
        .map((f) => {
          const coords = (f.geometry as GeoJSON.LineString).coordinates
          return {
            from: coords[0] as [number, number],
            to: coords[1] as [number, number],
            id: f.properties!.id as string,
          }
        })

      // Parse generator markers (click to inject a vehicle at that entry)
      generatorsRef.current = networkGeoJSON.features
        .filter((f) => f.properties?.type === 'generator')
        .map((f) => ({
          position: (f.geometry as GeoJSON.Point).coordinates as [number, number],
          edge: f.properties!.edge as string,
          lane: (f.properties!.lane as number) ?? 0,
          vtypes: (f.properties!.vtypes as string[]) ?? [],
        }))

      // Show static geometry (detectors dim, stop lines grey, generators) before sim starts
      renderDeck([], {}, {})

      if (map.getSource(SOURCE)) {
        (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData(networkGeoJSON)
        return
      }

      map.addSource(SOURCE, { type: 'geojson', data: networkGeoJSON })

      map.addLayer({
        id: 'junction-areas',
        type: 'fill',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'junction-area'],
        paint: { 'fill-color': '#1e1e38', 'fill-opacity': 0.9 },
      })
      map.addLayer({
        id: 'junction-area-outline',
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'junction-area'],
        paint: { 'line-color': '#3a3a60', 'line-width': 1 },
      })
      map.addLayer({
        id: 'lanes',
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'lane'],
        paint: { 'line-color': '#5a5a8a', 'line-width': 1.5, 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: 'junctions',
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'junction'],
        paint: { 'circle-color': '#3a3a6a', 'circle-radius': 3 },
      })
    }

    if (map.isStyleLoaded()) addLayers()
    else map.once('load', addLayers)
  }, [networkGeoJSON])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0 }}
    />
  )
})

MapView.displayName = 'MapView'
