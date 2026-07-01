import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { ScatterplotLayer } from '@deck.gl/layers'
import type { Vehicle } from './ws'

export interface MapViewHandle {
  updateVehicles: (vehicles: Vehicle[], t: number) => void
}

interface Props {
  networkGeoJSON: GeoJSON.FeatureCollection | null
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

  useImperativeHandle(ref, () => ({
    updateVehicles(vehicles: Vehicle[]) {
      deckRef.current?.setProps({
        layers: [
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
    return () => { map.remove() }
  }, [])

  // Load network geometry when GeoJSON arrives
  useEffect(() => {
    const map = mapRef.current
    if (!map || !networkGeoJSON) return

    const SOURCE = 'network'

    const addLayers = () => {
      if (map.getSource(SOURCE)) {
        (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData(networkGeoJSON)
        return
      }
      map.addSource(SOURCE, { type: 'geojson', data: networkGeoJSON })
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
        paint: { 'circle-color': '#3a3a6a', 'circle-radius': 4 },
      })

      // Fit map to network bounds
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
      for (const f of networkGeoJSON.features) {
        const g = f.geometry
        const pts: number[][] =
          g.type === 'LineString' ? g.coordinates
          : g.type === 'Point' ? [g.coordinates]
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
