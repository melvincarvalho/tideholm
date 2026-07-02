// Tideholm — rasterize real-world coastlines into a compact land mask for a
// map theme. Pure node, no dependencies.
//
// Data source: Natural Earth (naturalearthdata.com) — public domain.
//   e.g. 50m/physical/ne_50m_land.json and 10m/physical/ne_10m_minor_islands.json
//   from the GeoJSON mirror at github.com/martynafford/natural-earth-geojson
//
// Usage: node tools/build-region.js land.json [more.json...] > public/maps/aegean.json

'use strict';

const fs = require('fs');

// The Aegean & Ionian basin. Change these for other regions.
const NAME = 'aegean';
const BBOX = { lon0: 19.5, lat0: 34.0, lon1: 30.0, lat1: 41.8 };
const W = 200;
const H = 200;

const dLon = (BBOX.lon1 - BBOX.lon0) / W;
const dLat = (BBOX.lat1 - BBOX.lat0) / H;
const mask = Array.from({ length: H }, () => new Uint8Array(W));

function polygons(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

// Scanline fill with even-odd rule across all rings of one polygon.
function rasterize(rings) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (maxLon < BBOX.lon0 || minLon > BBOX.lon1 || maxLat < BBOX.lat0 || minLat > BBOX.lat1) return;

  const rowStart = Math.max(0, Math.floor((BBOX.lat1 - maxLat) / dLat));
  const rowEnd = Math.min(H - 1, Math.ceil((BBOX.lat1 - minLat) / dLat));
  for (let row = rowStart; row <= rowEnd; row++) {
    const lat = BBOX.lat1 - (row + 0.5) * dLat; // row 0 = north
    const xs = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        if ((y1 > lat) !== (y2 > lat)) {
          xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - BBOX.lon0) / dLon - 0.5));
      const to = Math.min(W - 1, Math.floor((xs[k + 1] - BBOX.lon0) / dLon - 0.5));
      for (let col = from; col <= to; col++) mask[row][col] = 1;
    }
  }
}

let features = 0;
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const f of data.features) {
    for (const poly of polygons(f.geometry)) {
      rasterize(poly);
      features++;
    }
  }
}

const land = mask.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
console.error(`rasterized ${features} polygons — ${land} land cells of ${W * H}`);

console.log(JSON.stringify({
  name: NAME,
  source: 'Natural Earth (public domain)',
  w: W,
  h: H,
  rows: mask.map((row) => Array.from(row).join('')),
}));
