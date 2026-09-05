import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { PolygonLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Vehicle, Person, Ldm, LdmObject } from './ws'

export interface MapViewHandle {
  updateStep: (vehicles: Vehicle[], tls: Record<string, string>, detectors: Record<string, boolean>, persons: Person[], t: number) => void
  setBasemap: (on: boolean) => void
  fitNetwork: (gj: GeoJSON.FeatureCollection) => void
  setSelected: (kind: 'vehicle' | 'tls' | null, id: string | null) => void
  setFcd: (graph: Record<string, unknown> | null) => void
  setLdm: (ldm: Ldm | null) => void
  setLdmOn: (on: boolean) => void
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

interface Crossing {
  from: [number, number]
  to: [number, number]
  tlsId?: string
  sigIdx?: number
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

// V2X overlay: colour the "approaching" link by the next signal's state char
function fcdStateColor(c: string | undefined): [number, number, number, number] {
  switch ((c ?? '')[0]) {
    case 'G':
    case 'g': return [40, 220, 90, 255]
    case 'r':
    case 'R': return [230, 50, 50, 255]
    case 'y':
    case 'Y':
    case 'o': return [235, 200, 40, 255]
    default:  return [150, 150, 170, 220]
  }
}

// one drawn edge of the egocentric graph (ego → leader / neighbour / signal)
interface FcdLink {
  from: [number, number]
  to: [number, number]
  color: [number, number, number, number]
  width: number
}

// a perception halo around a vehicle in the shared-LDM overlay
interface LdmHalo {
  pos: [number, number]
  color: [number, number, number, number]
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
    case 'bicycle':    return [230, 60, 60, 245]   // red — distinct from car orange
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
  const crossingsRef = useRef<Crossing[]>([])
  const pedSignalsRef = useRef<StopLine[]>([])
  const detectorsRef = useRef<Detector[]>([])
  const generatorsRef = useRef<Generator[]>([])
  const selectedRef = useRef<{ kind: string; id: string } | null>(null)
  // V2X: selected floating car's latest egocentric graph, drawn over the map
  const fcdRef = useRef<Record<string, any> | null>(null)
  // V2X: fused shared Local Dynamic Map + whether its overlay is on
  const ldmRef = useRef<Ldm | null>(null)
  const ldmOnRef = useRef(false)
  const lastStepRef = useRef<{ vehicles: Vehicle[]; tls: Record<string, string>; detectors: Record<string, boolean>; persons: Person[] }>(
    { vehicles: [], tls: {}, detectors: {}, persons: [] })
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
    persons: Person[] = lastStepRef.current.persons,
  ) => {
    lastStepRef.current = { vehicles, tls, detectors, persons }
    const sel = selectedRef.current
    const selVehicle = sel?.kind === 'vehicle' ? sel.id : null

    // V2X: draw the selected floating car's egocentric graph as links to its
    // leader (following), perceived neighbours (sees), and next signal
    // (approaching). Endpoints come from the current step's vehicle positions,
    // so the lines always land on the rendered vehicles.
    const fcd = fcdRef.current
    const egoId = fcd ? String(fcd['@id'] ?? '').replace(/^veh:/, '') : null
    const fcdLinks: FcdLink[] = []
    if (fcd && egoId && egoId === selVehicle) {
      const pos = new Map<string, [number, number]>()
      for (const v of vehicles) pos.set(v[0], [v[1], v[2]])
      const ego = pos.get(egoId)
      if (ego) {
        const foll = fcd.following as { '@id': string } | undefined
        if (foll) {
          const lp = pos.get(String(foll['@id']).replace(/^veh:/, ''))
          if (lp) fcdLinks.push({ from: ego, to: lp, color: [255, 170, 40, 255], width: 3 })
        }
        for (const s of (fcd.sees as { '@id': string }[] | undefined) ?? []) {
          const np = pos.get(String(s['@id']).replace(/^veh:/, ''))
          if (np) fcdLinks.push({ from: ego, to: np, color: [90, 200, 230, 130], width: 1 })
        }
        const appr = fcd.approaching as { signalIndex: number; state: string } | undefined
        if (appr) {
          const sl = stopLinesRef.current.find((s) => s.sigIdx === appr.signalIndex)
          if (sl) {
            const mid: [number, number] = [(sl.from[0] + sl.to[0]) / 2, (sl.from[1] + sl.to[1]) / 2]
            fcdLinks.push({ from: ego, to: mid, color: fcdStateColor(appr.state), width: 2.5 })
          }
        }
      }
    }

    // V2X: shared-LDM perception overlay. A halo per vehicle coloured by how the
    // connected cars collectively perceive it. Two views:
    //  · no probe selected → coverage by corroboration
    //      green = confirmed (≥2 probes)  ·  amber = single-source  ·  none = unseen
    //  · a probe A selected → "what connectivity adds to A"
    //      cyan = A perceives it  ·  magenta = only *other* probes see it
    const ldm = ldmRef.current
    const ldmHalos: LdmHalo[] = []
    if (ldmOnRef.current && ldm) {
      const byId = new Map<string, LdmObject>()
      for (const o of ldm.objects) byId.set(o['@id'].replace(/^veh:/, ''), o)
      const selProbe = selVehicle && byId.get(selVehicle)?.isProbe ? selVehicle : null
      for (const v of vehicles) {
        const o = byId.get(v[0])
        let color: [number, number, number, number] | null = null
        if (selProbe) {
          if (v[0] === selProbe) color = [0, 240, 255, 255]              // the probe itself
          else if (o?.observedBy.includes(selProbe)) color = [0, 220, 255, 210]  // A sees it
          else if (o) color = [235, 90, 220, 210]                        // only others see it
        } else if (o) {
          color = o.sources >= 2 ? [40, 220, 90, 220] : [235, 170, 40, 220]
        }
        if (color) ldmHalos.push({ pos: [v[1], v[2]], color })
      }
    }

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
        // Pedestrian crossing AREA — neutral zebra marking (not signal-coloured).
        new LineLayer<Crossing>({
          id: 'crossings',
          data: crossingsRef.current,
          getSourcePosition: (d) => d.from,
          getTargetPosition: (d) => d.to,
          getColor: [225, 225, 232, 190],
          getWidth: 6,
          widthUnits: 'pixels',
        }),
        // Pedestrian SIGNAL — a bar perpendicular to the crossing at the kerb,
        // coloured by the ped signal (same convention as vehicle stoplines).
        new LineLayer<StopLine>({
          id: 'ped-signals',
          data: pedSignalsRef.current,
          getSourcePosition: (d) => d.from,
          getTargetPosition: (d) => d.to,
          getColor: (d) => tlsColor(tls[d.tlsId], d.sigIdx),
          getWidth: 4,
          widthUnits: 'pixels',
          updateTriggers: { getColor: tls },
        }),
        // Pedestrians — small violet dots (point agents, not sized bodies).
        // Violet reads as "people" and stays distinct from cars (orange),
        // bikes (red), trams (blue), buses (green) and detectors (cyan).
        new ScatterplotLayer<Person>({
          id: 'persons',
          data: persons,
          getPosition: (p) => [p[1], p[2]],
          getRadius: 0.6,
          radiusUnits: 'meters',
          radiusMinPixels: 2,
          radiusMaxPixels: 6,
          getFillColor: [170, 100, 240, 240],
          getLineColor: [40, 20, 60, 200],
          lineWidthMinPixels: 0.5,
          stroked: true,
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
        new ScatterplotLayer<LdmHalo>({
          id: 'ldm-halos',
          data: ldmHalos,
          getPosition: (d) => d.pos,
          getLineColor: (d) => d.color,
          getRadius: 3.6,
          radiusUnits: 'meters',
          radiusMinPixels: 8,
          stroked: true,
          filled: false,
          lineWidthMinPixels: 2,
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
        new LineLayer<FcdLink>({
          id: 'fcd-links',
          data: fcdLinks,
          getSourcePosition: (d) => d.from,
          getTargetPosition: (d) => d.to,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          widthUnits: 'pixels',
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
    updateStep(vehicles: Vehicle[], tls: Record<string, string>, detectors: Record<string, boolean>, persons: Person[]) {
      renderDeck(vehicles, tls, detectors, persons)
    },
    setFcd(graph) {
      // redraw against the last known positions so the overlay appears at once
      // — including while paused, when no step render would otherwise fire
      fcdRef.current = graph
      const { vehicles, tls, detectors } = lastStepRef.current
      renderDeck(vehicles, tls, detectors)
    },
    setLdm(ldm) {
      // stored only; the next step render (or setLdmOn) draws it against fresh
      // positions. LDM arrives ~3 Hz, decoupled from the ~10 Hz step frames.
      ldmRef.current = ldm
    },
    setLdmOn(on) {
      ldmOnRef.current = on
      const { vehicles, tls, detectors } = lastStepRef.current
      renderDeck(vehicles, tls, detectors)   // reflect the toggle immediately
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
      doubleClickZoom: false,   // reserve double-click for interaction, not zoom
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

    // Stadia alidade_smooth basemap — hidden by default, toggled via setBasemap().
    // Replaces CARTO light_all, which began returning HTTP-200 tiles with an
    // "API KEY REQUIRED" watermark baked into the raster (no error surfaces —
    // see osm_extractor docs/inspector_basemap_tiles.md). Stadia's keyless tier
    // is for local dev and needs a Referer header (browsers always send one);
    // the attribution line is required by their terms, not cosmetic.
    map.once('load', () => {
      map.addSource('basemap', {
        type: 'raster',
        tiles: ['https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png'],
        tileSize: 256,
        maxzoom: 21,
        attribution:
          '© <a href="https://stadiamaps.com/">Stadia Maps</a> ' +
          '© <a href="https://openmaptiles.org/">OpenMapTiles</a> ' +
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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

      // Pedestrian crossings: the crossing AREA (neutral zebra marking) and,
      // separately, the perpendicular signal bar (coloured live by the ped
      // signal, like a vehicle stopline).
      crossingsRef.current = networkGeoJSON.features
        .filter((f) => f.properties?.type === 'crossing')
        .map((f) => {
          const coords = (f.geometry as GeoJSON.LineString).coordinates
          return {
            from: coords[0] as [number, number],
            to: coords[coords.length - 1] as [number, number],
          }
        })
      pedSignalsRef.current = networkGeoJSON.features
        .filter((f) => f.properties?.type === 'ped_signal')
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
      // Pedestrian footpaths (walk graph) — soft continuous tint, always shown.
      map.addLayer({
        id: 'footpaths',
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'footpath'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#cdb58a',
          'line-width': 2,
          'line-opacity': 0.5,
        },
      })
      // Bicycle lanes / cycle-track crossings — dashed red, always shown.
      map.addLayer({
        id: 'cyclelanes',
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'cyclelane'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#d23c3c',
          'line-width': 2,
          'line-opacity': 0.8,
          'line-dasharray': [2, 1.5],
        },
      })
      map.addLayer({
        id: 'junctions',
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'junction'],
        paint: { 'circle-color': '#3a3a6a', 'circle-radius': 3 },
      })
    }

    // 'idle', not 'load': when the network arrives moments after map creation
    // (embed mode auto-Load), 'load' has already fired and adding the basemap
    // leaves isStyleLoaded() false for a tick — a queued 'load' handler would
    // then never run and the static network layers would never be added.
    if (map.isStyleLoaded()) addLayers()
    else map.once('idle', addLayers)
  }, [networkGeoJSON])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0 }}
    />
  )
})

MapView.displayName = 'MapView'
