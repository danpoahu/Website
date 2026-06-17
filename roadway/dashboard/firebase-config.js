// firebase-config.js
// Initializes the Firebase modular SDK (v10, CDN ESM) and exports the Firestore db.
// Project: roadway-bcf99. appId intentionally omitted (not needed for Firestore reads/writes).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDKIXo_ResI8sow5Py5Es0FHZeDyJ3fDSI",
  authDomain: "roadway-bcf99.firebaseapp.com",
  projectId: "roadway-bcf99",
  storageBucket: "roadway-bcf99.firebasestorage.app",
  messagingSenderId: "171650743860"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
