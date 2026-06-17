// app.js
// Wires Firestore data, filters, map rendering, KPIs, assign mode, and work orders.
import {
  REGIONS, subscribeCompletedBumps, subscribeLiveCount,
  applyFilters, dateRangeForPreset, clusterBumps, regionForLatLng,
  selectBumpsInPolygon
} from "./data.js";
import {
  initMap, setRegion, setAssignMode, renderClusters, renderWorkOrders, clearDrawnPolygon
} from "./map.js";
import {
  createWorkOrder, subscribeWorkOrders, updateWorkOrderStatus,
  updateWorkOrderNotes, nextStatus, WORK_ORDER_STATUSES
} from "./workorders.js";

// ---- App state ----
let allBumps = [];          // all completed-trip bumps (flattened)
let tripsCount = 0;
let workOrders = [];
let liveCount = 0;
let pendingPolygon = null;  // {latlngs:[{lat,lng}], selected:[bumps]}

const state = {
  region: "Colorado",
  severity: "All",
  bumpType: "All",
  datePreset: "Custom",
  customFrom: null,
  customTo: null,
  assignMode: false
};

// Turf-backed predicate (same as map.js) for selection on draw complete.
function turfPip(lng, lat, ring) {
  try {
    const poly = turf.polygon([ring]);
    return turf.booleanPointInPolygon(turf.point([lng, lat]), poly);
  } catch (e) { return false; }
}

// ---- DOM refs ----
const $ = (id) => document.getElementById(id);

function currentFilters() {
  return {
    region: state.region,
    severity: state.severity,
    bumpType: state.bumpType,
    dateRange: dateRangeForPreset(state.datePreset, state.customFrom, state.customTo)
  };
}

function filteredBumps() {
  return applyFilters(allBumps, currentFilters());
}

function refresh() {
  const fb = filteredBumps();
  const clusters = clusterBumps(fb);
  renderWorkOrders(workOrders, state.region);
  renderClusters(clusters, fb, workOrders);
  updateKpis(fb);
}

function updateKpis(fb) {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  let today = 0, potholes = 0, speedBumps = 0;
  const devices = new Set();

  for (const b of fb) {
    if (b.timestamp && b.timestamp.getTime() >= todayMs) today++;
    if (b.type === "Pothole") potholes++;
    else if (b.type === "Speed Bump") speedBumps++;
  }
  // Devices + trips: count from all bumps in current region (not date-filtered KPI noise).
  const regionBumps = allBumps.filter((b) => regionForLatLng(b.lat, b.lng) === state.region);
  const tripSet = new Set();
  const deviceSet = new Set();
  for (const b of regionBumps) {
    tripSet.add(b.tripId);
  }

  $("kpiTotal").textContent = fb.length.toLocaleString();
  $("kpiToday").textContent = today.toLocaleString();
  $("kpiTrips").textContent = tripSet.size.toLocaleString();
  $("kpiDevices").textContent = deviceCount(regionBumps).toLocaleString();
  $("kpiPotholes").textContent = potholes.toLocaleString();
  $("kpiSpeedBumps").textContent = speedBumps.toLocaleString();
  $("kpiLive").textContent = liveCount.toLocaleString();
}

// Devices: we only have deviceId at trip level; bumps carry tripId. We approximate
// unique devices by unique tripId prefix is unreliable, so we track via a separate
// device map captured during subscription (see deviceByTrip).
const deviceByTrip = new Map();
function deviceCount(regionBumps) {
  const devices = new Set();
  for (const b of regionBumps) {
    const dev = deviceByTrip.get(b.tripId);
    if (dev) devices.add(dev);
  }
  return devices.size;
}

// ---- Assign mode / polygon selection ----
function onPolygonComplete(latlngs) {
  const fb = filteredBumps();
  const selected = selectBumpsInPolygon(fb, latlngs, turfPip);
  const potholesOnly = selected.filter((b) => b.type === "Pothole");
  pendingPolygon = { latlngs, selected };

  $("assignCount").textContent = potholesOnly.length;
  $("assignSelectedTotal").textContent = selected.length;
  $("assignPanel").classList.add("open");
  $("crewName").value = "";
  $("crewNotes").value = "";
}

async function confirmAssign() {
  if (!pendingPolygon) return;
  const crewName = $("crewName").value.trim();
  if (!crewName) { alert("Please enter a crew name."); return; }
  const notes = $("crewNotes").value.trim();

  // Snapshot only potholes per spec (potholeCount is the headline), but store all selected potholes.
  const selected = pendingPolygon.selected.filter((b) => b.type === "Pothole");

  try {
    await createWorkOrder({
      crewName,
      notes,
      region: state.region,
      polygonLatLngs: pendingPolygon.latlngs,
      selectedBumps: selected
    });
    closeAssignPanel();
  } catch (e) {
    alert("Could not create work order: " + e.message +
      "\n\nMake sure the work_orders Firestore rule is published.");
  }
}

function closeAssignPanel() {
  $("assignPanel").classList.remove("open");
  pendingPolygon = null;
  clearDrawnPolygon();
}

// ---- Work orders list ----
function renderWorkOrderList() {
  const list = $("woList");
  list.innerHTML = "";
  const visible = workOrders; // show all regions in list
  if (visible.length === 0) {
    list.innerHTML = `<p class="empty">No work orders yet.</p>`;
    return;
  }
  for (const wo of visible) {
    const row = document.createElement("div");
    row.className = "wo-row";
    const created = wo.createdAt && wo.createdAt.toDate ? wo.createdAt.toDate().toLocaleString() : "—";
    const count = wo.potholeCount != null ? wo.potholeCount : (wo.potholes ? wo.potholes.length : 0);

    const opts = WORK_ORDER_STATUSES.map((s) =>
      `<option value="${s}" ${s === wo.status ? "selected" : ""}>${s}</option>`
    ).join("");

    row.innerHTML =
      `<div class="wo-head">` +
        `<span class="wo-crew">${esc(wo.crewName || "Crew")}</span>` +
        `<span class="wo-badge ${badgeClass(wo.status)}">${esc(wo.status || "")}</span>` +
      `</div>` +
      `<div class="wo-meta">${count} potholes &middot; ${esc(wo.region || "—")} &middot; ${esc(created)}</div>` +
      (wo.notes ? `<div class="wo-notes">${esc(wo.notes)}</div>` : "") +
      `<div class="wo-actions"><label>Status: <select data-id="${wo.id}">${opts}</select></label></div>` +
      `<button class="btn wo-open">Open</button>`;

    const sel = row.querySelector("select");
    sel.addEventListener("change", async (e) => {
      try {
        await updateWorkOrderStatus(wo.id, e.target.value);
      } catch (err) {
        alert("Status update failed: " + err.message);
      }
    });

    row.querySelector(".wo-open").addEventListener("click", () => openWorkOrderModal(wo.id));

    list.appendChild(row);
  }
}

function badgeClass(status) {
  if (status === "Completed" || status === "Verified") return "done";
  if (status === "In Progress") return "progress";
  return "assigned";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---- Work order detail modal ----
let modalWoId = null;

function woById(id) {
  return workOrders.find((w) => w.id === id) || null;
}

function fmtDate(ts) {
  return ts && ts.toDate ? ts.toDate().toLocaleString() : "—";
}

function openWorkOrderModal(id) {
  const wo = woById(id);
  if (!wo) return;
  modalWoId = id;

  const count = wo.potholeCount != null ? wo.potholeCount : (wo.potholes ? wo.potholes.length : 0);

  $("woModalTitle").textContent = wo.crewName || "Crew";
  const badge = $("woModalBadge");
  badge.textContent = wo.status || "";
  badge.className = "wo-badge " + badgeClass(wo.status);

  $("woModalMeta").innerHTML =
    `${count} potholes &middot; ${esc(wo.region || "—")}<br>` +
    `Created: ${esc(fmtDate(wo.createdAt))}<br>` +
    `Last updated: ${esc(fmtDate(wo.updatedAt))}`;

  // Status select
  const statusSel = $("woModalStatus");
  statusSel.innerHTML = WORK_ORDER_STATUSES.map((s) =>
    `<option value="${s}" ${s === wo.status ? "selected" : ""}>${s}</option>`
  ).join("");
  statusSel.onchange = async (e) => {
    try {
      await updateWorkOrderStatus(id, e.target.value);
      badge.textContent = e.target.value;
      badge.className = "wo-badge " + badgeClass(e.target.value);
    } catch (err) {
      alert("Status update failed: " + err.message);
    }
  };

  // Potholes table
  const tbody = $("woModalPotholes").querySelector("tbody");
  const potholes = wo.potholes || [];
  if (potholes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">—</td></tr>`;
  } else {
    tbody.innerHTML = potholes.map((p, i) =>
      `<tr><td>${i + 1}</td><td>${esc(fmtCoord(p.lat))}</td><td>${esc(fmtCoord(p.lng))}</td>` +
      `<td>${esc(p.severity || "—")}</td><td>${esc(p.type || "—")}</td></tr>`
    ).join("");
  }

  // Notes
  const notesEl = $("woModalNotes");
  notesEl.value = wo.notes || "";
  const saveBtn = $("woModalSave");
  saveBtn.textContent = "Save Notes";

  populatePrintArea(wo, count);

  $("woModalBackdrop").classList.add("open");
  $("woModalBackdrop").setAttribute("aria-hidden", "false");
}

function fmtCoord(n) {
  return typeof n === "number" ? n.toFixed(6) : (n != null ? n : "—");
}

function closeWorkOrderModal() {
  $("woModalBackdrop").classList.remove("open");
  $("woModalBackdrop").setAttribute("aria-hidden", "true");
  modalWoId = null;
}

async function saveModalNotes() {
  if (!modalWoId) return;
  const saveBtn = $("woModalSave");
  const notes = $("woModalNotes").value;
  try {
    await updateWorkOrderNotes(modalWoId, notes);
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => { saveBtn.textContent = "Save Notes"; }, 1500);
  } catch (err) {
    alert("Could not save notes: " + err.message);
  }
}

function populatePrintArea(wo, count) {
  const potholes = wo.potholes || [];
  const rows = potholes.length === 0
    ? `<tr><td colspan="5">—</td></tr>`
    : potholes.map((p, i) =>
        `<tr><td>${i + 1}</td><td>${esc(fmtCoord(p.lat))}</td><td>${esc(fmtCoord(p.lng))}</td>` +
        `<td>${esc(p.severity || "—")}</td><td>${esc(p.type || "—")}</td></tr>`
      ).join("");

  $("printBody").innerHTML =
    `<h2>${esc(wo.crewName || "Crew")}</h2>` +
    `<div class="print-meta">` +
      `<div><strong>Status:</strong> ${esc(wo.status || "—")}</div>` +
      `<div><strong>Region:</strong> ${esc(wo.region || "—")}</div>` +
      `<div><strong>Potholes:</strong> ${count}</div>` +
      `<div><strong>Created:</strong> ${esc(fmtDate(wo.createdAt))}</div>` +
    `</div>` +
    `<h3 class="print-subhead">Potholes</h3>` +
    `<table><thead><tr><th>#</th><th>Lat</th><th>Lng</th><th>Severity</th><th>Type</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<h3 class="print-subhead">Notes</h3>` +
    `<div class="print-notes">${esc(wo.notes || "")}</div>`;
}

function setupModal() {
  $("woModalClose").addEventListener("click", closeWorkOrderModal);
  $("woModalSave").addEventListener("click", saveModalNotes);
  $("woModalPrint").addEventListener("click", () => window.print());
  $("woModalBackdrop").addEventListener("click", (e) => {
    if (e.target === $("woModalBackdrop")) closeWorkOrderModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("woModalBackdrop").classList.contains("open")) {
      closeWorkOrderModal();
    }
  });
}

// ---- Init ----
function setupControls() {
  $("regionSelect").value = state.region;
  $("severitySelect").value = state.severity;
  $("typeSelect").value = state.bumpType;
  $("dateSelect").value = state.datePreset;

  // Default the custom range to the current calendar year so all of this year's
  // bumps render on open (the rolling presets would hide older data).
  if (state.datePreset === "Custom" && !state.customFrom && !state.customTo) {
    const yr = new Date().getFullYear();
    state.customFrom = `${yr}-01-01`;
    state.customTo = `${yr}-12-31`;
  }
  $("customFrom").value = state.customFrom || "";
  $("customTo").value = state.customTo || "";
  $("customDates").style.display = state.datePreset === "Custom" ? "flex" : "none";

  $("regionSelect").addEventListener("change", (e) => {
    state.region = e.target.value;
    setRegion(state.region);
    refresh();
  });
  $("severitySelect").addEventListener("change", (e) => { state.severity = e.target.value; refresh(); });
  $("typeSelect").addEventListener("change", (e) => { state.bumpType = e.target.value; refresh(); });
  $("dateSelect").addEventListener("change", (e) => {
    state.datePreset = e.target.value;
    $("customDates").style.display = state.datePreset === "Custom" ? "flex" : "none";
    refresh();
  });
  $("customFrom").addEventListener("change", (e) => { state.customFrom = e.target.value; refresh(); });
  $("customTo").addEventListener("change", (e) => { state.customTo = e.target.value; refresh(); });

  $("assignToggle").addEventListener("change", (e) => {
    state.assignMode = e.target.checked;
    setAssignMode(state.assignMode);
    $("assignHint").style.display = state.assignMode ? "block" : "none";
    if (!state.assignMode) closeAssignPanel();
  });

  $("assignCreate").addEventListener("click", confirmAssign);
  $("assignCancel").addEventListener("click", closeAssignPanel);

  $("woToggle").addEventListener("click", () => {
    $("woPanel").classList.toggle("open");
  });
  $("woClose").addEventListener("click", () => $("woPanel").classList.remove("open"));
}

function start() {
  setupControls();
  setupModal();
  initMap("map", state.region, onPolygonComplete);

  subscribeCompletedBumps((bumps) => {
    allBumps = bumps;
    // rebuild deviceByTrip from the raw trip read — we re-derive here from bumps,
    // but deviceId lives on trips, so we capture it in the data layer instead.
    refresh();
  });

  // Capture deviceId per trip for the Devices KPI.
  captureDevices();

  subscribeLiveCount((n) => { liveCount = n; const el = $("kpiLive"); if (el) el.textContent = n.toLocaleString(); });

  subscribeWorkOrders((orders) => {
    workOrders = orders;
    renderWorkOrderList();
    refresh();
  });
}

// Separate lightweight subscription to map tripId -> deviceId for the Devices KPI.
import { db } from "./firebase-config.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
function captureDevices() {
  const q = query(collection(db, "trips"), where("status", "==", "complete"));
  onSnapshot(q, (snap) => {
    deviceByTrip.clear();
    snap.forEach((d) => {
      const t = d.data();
      if (t.deviceId) deviceByTrip.set(d.id, t.deviceId);
    });
    refresh();
  });
}

start();
