import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { ScatterplotLayer, LineLayer } from '@deck.gl/layers'
import type { Vehicle } from './ws'

export interface MapViewHandle {
  updateStep: (vehicles: Vehicle[], tls: Record<string, string>, t: number) => void
  setBasemap: (on: boolean) => void
}

interface Props {
  networkGeoJSON: GeoJSON.FeatureCollection | null
}

interface StopLine {
  from: [number, number]
  to: [number, number]
  tlsId: string
  sigIdx: number
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

const BLANK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#12121f' } }],
}

export const MapView = forwardRef<MapViewHandle, Props>(({ networkGeoJSON }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const deckRef = useRef<MapboxOverlay | null>(null)
  const stopLinesRef = useRef<StopLine[]>([])

  useImperativeHandle(ref, () => ({
    setBasemap(on: boolean) {
      const map = mapRef.current
      if (map?.getLayer('basemap-l')) {
        map.setPaintProperty('basemap-l', 'raster-opacity', on ? 1 : 0)
      }
    },
    updateStep(vehicles: Vehicle[], tls: Record<string, string>) {
      const stopLines = stopLinesRef.current
      deckRef.current?.setProps({
        layers: [
          new LineLayer<StopLine>({
            id: 'stoplines',
            data: stopLines,
            getSourcePosition: (d) => d.from,
            getTargetPosition: (d) => d.to,
            getColor: (d) => tlsColor(tls[d.tlsId], d.sigIdx),
            getWidth: 3,
            widthUnits: 'pixels',
            updateTriggers: { getColor: tls },
          }),
          new ScatterplotLayer<Vehicle>({
            id: 'vehicles',
            data: vehicles,
            getPosition: (d) => [d[1], d[2]],
            getFillColor: [255, 160, 40, 230],
            getRadius: 5,
            radiusUnits: 'pixels',
            pickable: false,
          }),
        ],
      })
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

      if (map.getSource(SOURCE)) {
        (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData(networkGeoJSON)
        return
      }

      map.addSource(SOURCE, { type: 'geojson', data: networkGeoJSON })

      // Junction area fills — rendered first so lane lines appear on top
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

      // Lane lines
      map.addLayer({
        id: 'lanes',
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'lane'],
        paint: { 'line-color': '#5a5a8a', 'line-width': 1.5, 'line-opacity': 0.9 },
      })

      // Junction centre dots
      map.addLayer({
        id: 'junctions',
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'type'], 'junction'],
        paint: { 'circle-color': '#3a3a6a', 'circle-radius': 3 },
      })

      // Fit map to network bounds
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
      for (const f of networkGeoJSON.features) {
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
