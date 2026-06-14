// workorders.js
// Create / list / status-update helpers for the `work_orders` collection.
import { db } from "./firebase-config.js";
import {
  collection, addDoc, doc, updateDoc, onSnapshot, serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const WORK_ORDER_STATUSES = ["Assigned", "In Progress", "Completed", "Verified"];
const ACTIVE_STATUSES = new Set(["Assigned", "In Progress"]);

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

export function nextStatus(status) {
  const i = WORK_ORDER_STATUSES.indexOf(status);
  if (i < 0 || i === WORK_ORDER_STATUSES.length - 1) return status;
  return WORK_ORDER_STATUSES[i + 1];
}

// Create a work order from a polygon + the snapshot of selected bumps.
// polygonLatLngs: array of {lat,lng}
// selectedBumps: array of bump objects (eventId, tripId, lat, lng, severity, type)
export async function createWorkOrder({ crewName, notes, region, polygonLatLngs, selectedBumps }) {
  const potholes = selectedBumps.map((b) => ({
    eventId: b.eventId || "",
    tripId: b.tripId || "",
    lat: b.lat,
    lng: b.lng,
    severity: b.severity || "",
    type: b.type || "Unknown"
  }));

  const docData = {
    crewName: crewName || "Unnamed crew",
    status: "Assigned",
    area: polygonLatLngs.map((p) => ({ lat: p.lat, lng: p.lng })),
    region,
    potholes,
    potholeCount: potholes.length,
    notes: notes || "",
    createdAt: serverTimestamp(),
    assignedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  return addDoc(collection(db, "work_orders"), docData);
}

// Subscribe to all work orders (newest first). callback receives an array of
// { id, ...data }.
export function subscribeWorkOrders(callback) {
  const q = query(collection(db, "work_orders"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    const orders = [];
    snap.forEach((d) => orders.push({ id: d.id, ...d.data() }));
    callback(orders);
  }, (err) => {
    // Surface index/permission errors without crashing the app.
    console.warn("[work_orders] snapshot error:", err.message);
    callback([]);
  });
}

// Update a work order's status.
export async function updateWorkOrderStatus(id, status) {
  const ref = doc(db, "work_orders", id);
  return updateDoc(ref, { status, updatedAt: serverTimestamp() });
}

// Update a work order's notes.
export async function updateWorkOrderNotes(id, notes) {
  const ref = doc(db, "work_orders", id);
  return updateDoc(ref, { notes, updatedAt: serverTimestamp() });
}
