// selection.test.js
// Standalone browser-console tests for the pure point-in-polygon selection helper.
// No framework — logs PASS/FAIL. Open test/index.html and check the console.
import { selectBumpsInPolygon, rayCastPip } from "../data.js";

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log("PASS:", name); }
  else { failed++; console.error("FAIL:", name); }
}

// A square around (0,0): lat/lng from -1 to 1.
const square = [
  { lat: -1, lng: -1 },
  { lat: -1, lng: 1 },
  { lat: 1, lng: 1 },
  { lat: 1, lng: -1 }
];

const bumps = [
  { eventId: "inside-center", lat: 0, lng: 0, type: "Pothole" },
  { eventId: "inside-near-edge", lat: 0.9, lng: 0.9, type: "Pothole" },
  { eventId: "outside-right", lat: 0, lng: 2, type: "Pothole" },
  { eventId: "outside-far", lat: 5, lng: 5, type: "Speed Bump" },
  { eventId: "outside-neg", lat: -1.5, lng: 0, type: "Pothole" }
];

// Test 1: selects only the two inside points.
const selected = selectBumpsInPolygon(bumps, square, rayCastPip);
const ids = selected.map((b) => b.eventId).sort();
assert("selects exactly the two interior points",
  ids.length === 2 && ids[0] === "inside-center" && ids[1] === "inside-near-edge");

// Test 2: accepts [lat,lng] array polygon form too.
const squareArr = square.map((p) => [p.lat, p.lng]);
const selected2 = selectBumpsInPolygon(bumps, squareArr, rayCastPip);
assert("works with [lat,lng] array polygon form", selected2.length === 2);

// Test 3: degenerate polygon (<3 verts) returns empty.
assert("returns empty for degenerate polygon",
  selectBumpsInPolygon(bumps, [{ lat: 0, lng: 0 }], rayCastPip).length === 0);

// Test 4: empty bumps returns empty.
assert("returns empty for no bumps",
  selectBumpsInPolygon([], square, rayCastPip).length === 0);

// Test 5: a tiny polygon excludes everything.
const tiny = [
  { lat: 10, lng: 10 }, { lat: 10, lng: 10.001 }, { lat: 10.001, lng: 10.001 }
];
assert("tiny far-away polygon selects nothing",
  selectBumpsInPolygon(bumps, tiny, rayCastPip).length === 0);

// Test 6 (if turf is loaded on the page): turf predicate agrees with ray-casting.
if (typeof turf !== "undefined") {
  const turfPip = (lng, lat, ring) =>
    turf.booleanPointInPolygon(turf.point([lng, lat]), turf.polygon([ring]));
  const selT = selectBumpsInPolygon(bumps, square, turfPip);
  assert("turf predicate matches ray-casting result", selT.length === selected.length);
} else {
  console.log("(turf not loaded — skipping turf cross-check)");
}

console.log(`\n=== Selection tests: ${passed} passed, ${failed} failed ===`);
