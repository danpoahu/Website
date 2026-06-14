// data.js
// Reads `trips` from Firestore, flattens events into bumps, computes location clusters,
// applies filters, and exposes a pure point-in-polygon selection helper.
// All cluster math ported from the Swift Roadway app.

import { db } from "./firebase-config.js";
import {
  collection, query, where, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------
export const REGIONS = {
  Oahu: { name: "Oahu", center: [21.4389, -158.0001], span: 0.45 },
  Colorado: { name: "Colorado", center: [38.68, -104.70], span: 0.45 }
};

// A bump belongs to a region if its coordinate falls within the region's span box.
export function regionForLatLng(lat, lng) {
  for (const key of Object.keys(REGIONS)) {
    const r = REGIONS[key];
    const half = r.span / 2;
    if (
      lat >= r.center[0] - half && lat <= r.center[0] + half &&
      lng >= r.center[1] - half && lng <= r.center[1] + half
    ) {
      return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Severity helpers (by avg vertical G)
// ---------------------------------------------------------------------------
export function severityColor(avgVerticalG) {
  if (avgVerticalG < 0.8) return "#FFF200";   // neon yellow
  if (avgVerticalG < 1.2) return "#FF8000";   // vivid orange
  if (avgVerticalG < 1.6) return "#FF0066";   // hot pink
  return "#E60000";                            // bright red
}

export function severityLabel(avgVerticalG) {
  if (avgVerticalG < 0.8) return "Low";
  if (avgVerticalG < 1.2) return "Moderate";
  if (avgVerticalG < 1.6) return "High";
  return "Severe";
}

// Marker radius: maxVerticalG/2 clamped to >=1 → mapped to 12–28px base,
// plus a boost based on reportCount.
export function clusterRadius(maxVerticalG, reportCount) {
  const intensity = Math.max(1, maxVerticalG / 2); // clamp lower bound to 1
  // intensity of 1 → 12px, scale upward, cap base at 28px
  let base = 12 + (intensity - 1) * 16;
  if (base < 12) base = 12;
  if (base > 28) base = 28;

  let boost = 0;
  if (reportCount >= 25) boost = 12;
  else if (reportCount >= 10) boost = 9;
  else if (reportCount >= 5) boost = 6;
  else if (reportCount >= 2) boost = 3;

  return base + boost;
}

// ---------------------------------------------------------------------------
// Trip / bump fetch
// ---------------------------------------------------------------------------
// Subscribe to completed trips. callback receives an array of bump objects:
//   { eventId, tripId, lat, lng, verticalG, severity, type, heading, speedMph, timestamp(Date) }
export function subscribeCompletedBumps(callback) {
  const q = query(collection(db, "trips"), where("status", "==", "complete"));
  return onSnapshot(q, (snap) => {
    const bumps = [];
    snap.forEach((docSnap) => {
      const trip = docSnap.data();
      const tripId = docSnap.id;
      const events = Array.isArray(trip.events) ? trip.events : [];
      for (const ev of events) {
        const lat = Number(ev.lat);
        const lng = Number(ev.lng);
        if (!lat || !lng) continue;          // skip lat==0 / lng==0 / NaN
        bumps.push({
          eventId: ev.id || "",
          tripId,
          lat,
          lng,
          verticalG: Number(ev.verticalG) || 0,
          severity: ev.severity || "Low",
          type: ev.type || "Unknown",
          heading: ev.heading != null ? Number(ev.heading) : null,
          speedMph: ev.speedMph != null ? Number(ev.speedMph) : null,
          timestamp: ev.timestamp && ev.timestamp.toDate ? ev.timestamp.toDate() : null
        });
      }
    });
    callback(bumps);
  });
}

// Subscribe to active trips → live driver count (dedupe by deviceId, ignore >4h old).
export function subscribeLiveCount(callback) {
  const q = query(collection(db, "trips"), where("status", "==", "active"));
  return onSnapshot(q, (snap) => {
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const live = new Set();
    snap.forEach((docSnap) => {
      const trip = docSnap.data();
      const start = trip.startDate && trip.startDate.toDate ? trip.startDate.toDate().getTime() : 0;
      if (start && start < fourHoursAgo) return; // stale active trip
      if (trip.deviceId) live.add(trip.deviceId);
    });
    callback(live.size);
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
// filters: { severity, bumpType, region, dateRange:{from:Date|null,to:Date|null} }
export function applyFilters(bumps, filters) {
  return bumps.filter((b) => {
    // Region
    if (filters.region && regionForLatLng(b.lat, b.lng) !== filters.region) return false;

    // Severity
    if (filters.severity && filters.severity !== "All" && b.severity !== filters.severity) return false;

    // Bump type
    if (filters.bumpType && filters.bumpType !== "All") {
      const isPothole = b.type === "Pothole";
      const isSpeedBump = b.type === "Speed Bump";
      if (filters.bumpType === "Potholes" && !isPothole) return false;
      if (filters.bumpType === "Speed Bumps" && !isSpeedBump) return false;
    }

    // Date range
    if (filters.dateRange && (filters.dateRange.from || filters.dateRange.to)) {
      const t = b.timestamp ? b.timestamp.getTime() : null;
      if (t == null) return false;
      if (filters.dateRange.from && t < filters.dateRange.from.getTime()) return false;
      if (filters.dateRange.to && t > filters.dateRange.to.getTime()) return false;
    }

    return true;
  });
}

// Build a date range object from a named preset.
export function dateRangeForPreset(preset, customFrom, customTo) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (preset) {
    case "Today":
      return { from: startOfToday, to: now };
    case "This Week": {
      const day = startOfToday.getDay(); // 0=Sun
      const weekStart = new Date(startOfToday);
      weekStart.setDate(startOfToday.getDate() - day);
      return { from: weekStart, to: now };
    }
    case "Last Week": {
      const day = startOfToday.getDay();
      const thisWeekStart = new Date(startOfToday);
      thisWeekStart.setDate(startOfToday.getDate() - day);
      const lastWeekStart = new Date(thisWeekStart);
      lastWeekStart.setDate(thisWeekStart.getDate() - 7);
      return { from: lastWeekStart, to: thisWeekStart };
    }
    case "Month": {
      const from = new Date(now);
      from.setMonth(now.getMonth() - 1);
      return { from, to: now };
    }
    case "Quarter": {
      const from = new Date(now);
      from.setMonth(now.getMonth() - 3);
      return { from, to: now };
    }
    case "Custom": {
      const from = customFrom ? new Date(customFrom + "T00:00:00") : null;
      const to = customTo ? new Date(customTo + "T23:59:59") : null;
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

// ---------------------------------------------------------------------------
// Clustering — ported exactly from the Swift app.
// Grid key = lat.toFixed(4) + "," + lng.toFixed(4)
// ---------------------------------------------------------------------------
export function clusterBumps(bumps) {
  const groups = new Map();

  for (const b of bumps) {
    if (!b.lat || !b.lng) continue; // skip lat==0 / lng==0
    const key = b.lat.toFixed(4) + "," + b.lng.toFixed(4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const clusters = [];
  for (const [key, members] of groups.entries()) {
    const reportCount = members.length;
    let sumLat = 0, sumLng = 0, sumG = 0, maxG = 0;
    let potholeCount = 0, speedBumpCount = 0;
    const headingBuckets = new Map(); // rounded-to-45 → count

    for (const m of members) {
      sumLat += m.lat;
      sumLng += m.lng;
      sumG += m.verticalG;
      if (m.verticalG > maxG) maxG = m.verticalG;

      if (m.type === "Pothole") potholeCount++;
      else if (m.type === "Speed Bump") speedBumpCount++;

      if (m.heading != null && !Number.isNaN(m.heading)) {
        let rounded = Math.round(m.heading / 45) * 45;
        rounded = ((rounded % 360) + 360) % 360; // normalize 0–315
        headingBuckets.set(rounded, (headingBuckets.get(rounded) || 0) + 1);
      }
    }

    const avgLat = sumLat / reportCount;
    const avgLng = sumLng / reportCount;
    const avgVerticalG = sumG / reportCount;

    // Dominant heading = modal rounded value
    let dominantHeading = null, bestCount = -1;
    for (const [h, c] of headingBuckets.entries()) {
      if (c > bestCount) { bestCount = c; dominantHeading = h; }
    }

    // Dominant bump type
    let dominantBumpType = "Unknown";
    if (potholeCount > 0 || speedBumpCount > 0) {
      dominantBumpType = potholeCount >= speedBumpCount ? "Pothole" : "Speed Bump";
    }

    clusters.push({
      key,
      avgLat,
      avgLng,
      reportCount,
      avgVerticalG,
      maxVerticalG: maxG,
      dominantHeading,
      potholeCount,
      speedBumpCount,
      dominantBumpType,
      members,
      color: severityColor(avgVerticalG),
      label: severityLabel(avgVerticalG),
      radius: clusterRadius(maxG, reportCount)
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// KPI computation
// ---------------------------------------------------------------------------
export function computeKpis(filteredBumps, allTripsCount) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  let today = 0, potholes = 0, speedBumps = 0;
  const devices = new Set();

  for (const b of filteredBumps) {
    if (b.timestamp && b.timestamp.getTime() >= todayMs) today++;
    if (b.type === "Pothole") potholes++;
    else if (b.type === "Speed Bump") speedBumps++;
  }

  return {
    totalBumps: filteredBumps.length,
    today,
    trips: allTripsCount,
    devices: devices.size, // populated by caller via separate device set if needed
    potholes,
    speedBumps
  };
}

// ---------------------------------------------------------------------------
// PURE SELECTION HELPER (testable)
// Given an array of bumps and a polygon (array of [lat,lng] or {lat,lng} verts),
// return the bumps whose coordinate is inside the polygon.
// `pip` is an injectable point-in-polygon predicate:
//   pip(lng, lat, ringLngLat) -> boolean
// In production we pass a Turf-backed predicate; tests pass a ray-casting one.
// ---------------------------------------------------------------------------
export function selectBumpsInPolygon(bumps, polygon, pip) {
  if (!Array.isArray(bumps) || !Array.isArray(polygon) || polygon.length < 3) return [];

  // Normalize polygon to a closed ring of [lng, lat] pairs (GeoJSON order).
  const ring = polygon.map((v) => {
    if (Array.isArray(v)) return [v[1], v[0]];        // [lat,lng] -> [lng,lat]
    return [v.lng, v.lat];                            // {lat,lng}
  });
  if (ring.length > 0) {
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  }

  return bumps.filter((b) => pip(b.lng, b.lat, ring));
}

// Simple ray-casting point-in-polygon (no deps) — used by the test harness and
// as a fallback. ring is [[lng,lat], ...] closed.
export function rayCastPip(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
