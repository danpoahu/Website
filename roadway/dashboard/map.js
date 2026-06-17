// map.js
// Leaflet map: OSM tiles, cluster circleMarkers, Leaflet.draw polygon tool,
// and work-order polygon overlays. Determines per-bump assignment status so
// clusters can render as needs-assignment / assigned / fixed.
//
// Depends on globals L (Leaflet + Leaflet.draw) and turf (Turf.js) from CDN.

import { REGIONS, selectBumpsInPolygon } from "./data.js";
import { isActiveStatus } from "./workorders.js";

let map = null;
let tileLayer = null;
let clusterGroup = null;
let workOrderGroup = null;
let drawnItems = null;
let rectDraw = null;
let assignModeOn = false;
let onPolygonComplete = null;

// Turf-backed point-in-polygon predicate used in production.
function turfPip(lng, lat, ring) {
  try {
    const poly = turf.polygon([ring]);
    return turf.booleanPointInPolygon(turf.point([lng, lat]), poly);
  } catch (e) {
    return false;
  }
}

export function initMap(elementId, regionKey, polygonCompleteCallback) {
  onPolygonComplete = polygonCompleteCallback;

  const region = REGIONS[regionKey];
  map = L.map(elementId, { zoomControl: true }).setView(region.center, 12);

  tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  workOrderGroup = L.layerGroup().addTo(map);
  clusterGroup = L.layerGroup().addTo(map);

  // Draw setup — drag-to-draw rectangle selection. The Rectangle handler takes
  // over the mouse drag while active, so the map no longer pans while the user
  // is selecting an area (matches the Swift dashboard's box-drag behavior).
  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  map.on(L.Draw.Event.CREATED, (e) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    const latlngs = e.layer.getLatLngs()[0].map((p) => ({ lat: p.lat, lng: p.lng }));
    if (onPolygonComplete) onPolygonComplete(latlngs);
    // Re-arm so another box can be drawn while still in Assign Mode.
    if (assignModeOn) setTimeout(armRectangleDraw, 0);
  });

  return map;
}

export function setRegion(regionKey) {
  const region = REGIONS[regionKey];
  if (map && region) map.setView(region.center, 12);
}

// Enable Leaflet.draw's drag-to-draw Rectangle handler.
function armRectangleDraw() {
  if (!map) return;
  if (rectDraw) { try { rectDraw.disable(); } catch (e) { /* ignore */ } }
  rectDraw = new L.Draw.Rectangle(map, {
    shapeOptions: { color: "#FF8000", weight: 2, fillOpacity: 0.1 }
  });
  rectDraw.enable();
}

// Toggle area-selection (Assign Mode). When on, dragging draws a selection box
// instead of panning the map.
export function setAssignMode(on) {
  if (!map) return;
  assignModeOn = on;
  if (on) {
    armRectangleDraw();
  } else {
    if (rectDraw) { try { rectDraw.disable(); } catch (e) { /* ignore */ } rectDraw = null; }
    if (drawnItems) drawnItems.clearLayers();
  }
}

export function clearDrawnPolygon() {
  if (drawnItems) drawnItems.clearLayers();
}

// Compute, for each work order, the set of pothole eventIds inside its polygon,
// and whether that order is active (orange) or done (green).
// Returns { assignedIds:Set, fixedIds:Set }
function computeBumpStatus(bumps, workOrders) {
  const assignedIds = new Set();
  const fixedIds = new Set();

  for (const wo of workOrders) {
    if (!Array.isArray(wo.area) || wo.area.length < 3) continue;
    const selected = selectBumpsInPolygon(bumps, wo.area, turfPip);
    const active = isActiveStatus(wo.status);
    for (const b of selected) {
      const idKey = b.eventId || (b.lat + "," + b.lng);
      if (active) assignedIds.add(idKey);
      else fixedIds.add(idKey);
    }
  }
  return { assignedIds, fixedIds };
}

// Render work-order polygons (orange active / green done).
export function renderWorkOrders(workOrders, regionKey) {
  if (!workOrderGroup) return;
  workOrderGroup.clearLayers();

  for (const wo of workOrders) {
    if (regionKey && wo.region && wo.region !== regionKey) continue;
    if (!Array.isArray(wo.area) || wo.area.length < 3) continue;
    const active = isActiveStatus(wo.status);
    const latlngs = wo.area.map((p) => [p.lat, p.lng]);
    const poly = L.polygon(latlngs, {
      color: active ? "#FF8000" : "#1DB954",
      weight: 2,
      fillColor: active ? "#FF8000" : "#1DB954",
      fillOpacity: 0.18
    });
    poly.bindPopup(
      `<strong>${escapeHtml(wo.crewName || "Crew")}</strong><br>` +
      `Status: ${escapeHtml(wo.status || "")}<br>` +
      `Potholes: ${wo.potholeCount != null ? wo.potholeCount : (wo.potholes ? wo.potholes.length : 0)}` +
      (wo.notes ? `<br><em>${escapeHtml(wo.notes)}</em>` : "")
    );
    workOrderGroup.addLayer(poly);
  }
}

// Render clusters as circleMarkers, styling by assignment status.
export function renderClusters(clusters, bumps, workOrders) {
  if (!clusterGroup) return;
  clusterGroup.clearLayers();

  const { assignedIds, fixedIds } = computeBumpStatus(bumps, workOrders);

  for (const c of clusters) {
    // Determine cluster-level status: does any member belong to a work order?
    let status = "open"; // needs assignment
    for (const m of c.members) {
      const idKey = m.eventId || (m.lat + "," + m.lng);
      if (fixedIds.has(idKey)) { status = "fixed"; break; }
      if (assignedIds.has(idKey)) { status = "assigned"; }
    }

    let fillColor = c.color;
    let fillOpacity = 0.85;
    let strokeColor = "#222";
    let strokeWeight = 1;
    let dashArray = null;

    if (status === "fixed") {
      fillColor = "#1DB954";       // muted green = fixed
      fillOpacity = 0.5;
      strokeColor = "#0E7A33";
    } else if (status === "assigned") {
      strokeColor = "#FF8000";     // orange ring = assigned
      strokeWeight = 3;
      dashArray = "4,3";
    }

    const marker = L.circleMarker([c.avgLat, c.avgLng], {
      radius: c.radius,
      color: strokeColor,
      weight: strokeWeight,
      fillColor,
      fillOpacity,
      dashArray
    });

    marker.bindPopup(buildClusterPopup(c, status));
    clusterGroup.addLayer(marker);
  }
}

function buildClusterPopup(c, status) {
  const typeLabel = c.dominantBumpType === "Pothole" ? "Pothole"
    : c.dominantBumpType === "Speed Bump" ? "Speed Bump" : "Unknown";
  let mixed = "";
  if (c.potholeCount > 0 && c.speedBumpCount > 0) {
    mixed = `<br>Breakdown: ${c.potholeCount} P / ${c.speedBumpCount} SB`;
  }
  const statusLine = status === "fixed" ? `<br><span style="color:#1DB954">Fixed</span>`
    : status === "assigned" ? `<br><span style="color:#FF8000">Assigned to crew</span>`
    : `<br><span style="color:#888">Needs assignment</span>`;

  return (
    `<div style="min-width:160px">` +
    `<strong>${c.reportCount} report${c.reportCount === 1 ? "" : "s"}</strong><br>` +
    `Severity: <strong>${c.label}</strong><br>` +
    `Avg G: ${c.avgVerticalG.toFixed(2)} &nbsp; Max G: ${c.maxVerticalG.toFixed(2)}<br>` +
    `Dominant: ${typeLabel}` +
    mixed +
    statusLine +
    `</div>`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
