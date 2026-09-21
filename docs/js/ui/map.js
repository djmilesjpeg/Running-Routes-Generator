/**
 * Leaflet map wrapper.
 *
 * COORDINATE ORDER
 * The rest of the app uses GeoJSON order, [lon, lat]. Leaflet uses [lat, lon].
 * This file is the only place that flips them, so a mix-up cannot spread: a
 * swap here shows a route in the wrong hemisphere, which is impossible to miss.
 *
 * ATTRIBUTION
 * OpenStreetMap data is ODbL licensed and attribution is a condition of use,
 * not a courtesy. It is set on the tile layer so it cannot be detached from
 * the map, and repeated in the page footer.
 *
 * The map opens on a neutral world view. There is no home coordinate anywhere
 * in this source.
 */

import { boundsOf } from '../core/geo.js';
import { debug } from '../core/log.js';

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">' +
  'OpenStreetMap</a> contributors, ODbL';

/** A neutral opening view: no location, fully zoomed out. */
const WORLD_VIEW = { center: [20, 0], zoom: 2 };

const ROUTE_STYLE = { color: '#e8590c', weight: 5, opacity: 0.9, lineJoin: 'round', lineCap: 'round' };
const GHOST_STYLE = { color: '#868e96', weight: 3, opacity: 0.45, dashArray: '6 6' };

export class RouteMap {
  /**
   * @param {string|HTMLElement} target element or element id
   * @param {Object} [options]
   */
  constructor(target, { onTileError = null } = {}) {
    const L = globalThis.L;
    if (!L) throw new Error('Leaflet failed to load. Check the network and reload.');

    this.L = L;
    this.map = L.map(target, {
      zoomControl: true,
      attributionControl: true,
      // Two-finger drag would fight page scrolling on a phone.
      tap: true,
    }).setView(WORLD_VIEW.center, WORLD_VIEW.zoom);

    this.tiles = L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
      crossOrigin: true,
    }).addTo(this.map);

    // Offline, every tile request fails. Report it once so the UI can explain
    // that the route is still correct even though the backdrop is blank.
    let reported = false;
    this.tiles.on('tileerror', () => {
      if (reported || !onTileError) return;
      reported = true;
      onTileError();
    });

    this.routeLayer = L.layerGroup().addTo(this.map);
    this.startMarker = null;
  }

  /** GeoJSON [lon, lat] to Leaflet [lat, lon]. The only flip in the app. */
  static toLeaflet(coords) {
    return coords.map(([lon, lat]) => [lat, lon]);
  }

  /**
   * Draw a route, optionally with other candidates behind it.
   *
   * @param {Object} route          the selected Route
   * @param {Array}  [alternatives] other candidates, drawn faintly
   */
  showRoute(route, alternatives = []) {
    this.routeLayer.clearLayers();

    for (const other of alternatives) {
      if (other.id === route.id) continue;
      this.L.polyline(RouteMap.toLeaflet(other.coords), GHOST_STYLE).addTo(this.routeLayer);
    }

    const line = this.L.polyline(RouteMap.toLeaflet(route.coords), ROUTE_STYLE).addTo(this.routeLayer);

    const [startLon, startLat] = route.coords[0];
    this.L.circleMarker([startLat, startLon], {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#2b8a3e',
      fillOpacity: 1,
    })
      .addTo(this.routeLayer)
      .bindTooltip('Start and finish', { direction: 'top' });

    this.map.fitBounds(line.getBounds(), { padding: [28, 28] });
    debug('route drawn', { points: route.coords.length });
  }

  /** Mark the runner's current position without drawing a route. */
  showStart(lat, lon, { zoom = 15 } = {}) {
    if (this.startMarker) this.startMarker.remove();

    this.startMarker = this.L.circleMarker([lat, lon], {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#1c7ed6',
      fillOpacity: 1,
    })
      .addTo(this.map)
      .bindTooltip('You are here', { direction: 'top' });

    this.map.setView([lat, lon], zoom);
  }

  /** Remove every route, keeping the current view. */
  clearRoutes() {
    this.routeLayer.clearLayers();
  }

  /** Leaflet needs telling when its container changes size. */
  invalidate() {
    this.map.invalidateSize();
  }
}
