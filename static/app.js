/* ═══════════════════════════════════════════════════════════════
   SQL AI & PDF RAG — APPLICATION LOGIC
   Firebase Auth + FastAPI Integration
   ═══════════════════════════════════════════════════════════════ */

const firebaseConfig = {
  apiKey: "AIzaSyCku3oRy9iRsrRsHFnGSwidH_cMsR-9N0o",
  authDomain: "sql-ai-f80c9.firebaseapp.com",
  projectId: "sql-ai-f80c9",
  storageBucket: "sql-ai-f80c9.firebasestorage.app",
  messagingSenderId: "1066390974802",
  appId: "1:1066390974802:web:5479237f902c8b221f4a8b",
  measurementId: "G-2QCPY5PWJM"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// ── Backend API URL ──────────────────────────────────────────────
// In production (GitHub Pages), replace with your Render backend URL.
// In local dev (localhost), it falls back to http://localhost:8000
const RENDER_BACKEND_URL = "https://ai-powered-sql-analysis-system.onrender.com";
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8000"
  : RENDER_BACKEND_URL;

// ── App State ────────────────────────────────────────────────────
const state = {
  user: null,
  sessionId: crypto.randomUUID(),
  uploadedData: null,
  schemaInfo: null,
  tableName: null,
  sqlChatHistory: [],
  pdfFilename: null,
  pdfChatHistory: [],
  queryCount: 0,
  sessionStart: null,
  pendingVerificationEmail: null,
  pendingVerificationPassword: null,  // needed for resend
};

// ═══════════════════════════════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════════════════════════════
(function initParticles() {
  const canvas = document.getElementById("particles-canvas");
  const ctx = canvas.getContext("2d");
  let particles = [];
  const PARTICLE_COUNT = 60;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = (Math.random() - 0.5) * 0.3;
      this.radius = Math.random() * 1.5 + 0.5;
      this.alpha = Math.random() * 0.4 + 0.1;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
      if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,181,160,${this.alpha})`;
      ctx.fill();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

  function drawLines() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0,181,160,${0.06 * (1 - dist / 150)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(); p.draw(); });
    drawLines();
    requestAnimationFrame(animate);
  }
  animate();
})();

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════
function showPage(pageId) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));

  const isAppPage = ["dashboard", "data_clean", "sql_ai", "pdf_ai", "help"].includes(pageId);
  document.getElementById("topbar").style.display = isAppPage ? "flex" : "none";

  if (isAppPage && !state.user) { showPage("login"); return; }

  const el = document.getElementById(`page-${pageId}`);
  if (el) el.classList.add("active");

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.page === pageId);
  });

  closeSidebar();
  if (pageId === "dashboard") updateDashboard();
  if (pageId === "sql_ai") updateSQLPage();
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebar-overlay").classList.toggle("active");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebar-overlay").classList.remove("active");
}

// ═══════════════════════════════════════════════════════════════
//  FIREBASE AUTH — Google Sign-In Only
// ═══════════════════════════════════════════════════════════════

function setSidebarUser(displayName, photoURL) {
  const av = document.getElementById("sidebar-avatar");
  const un = document.getElementById("sidebar-username");
  const tu = document.getElementById("topbar-username");
  const dw = document.getElementById("dash-welcome");
  if (av) {
    if (photoURL) {
      av.innerHTML = `<img src="${photoURL}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" alt="${displayName}" />`;
    } else {
      av.textContent = displayName.charAt(0).toUpperCase();
    }
  }
  if (un) un.textContent = displayName;
  if (tu) tu.textContent = displayName;
  if (dw) dw.textContent = `Welcome back, ${displayName} 👋`;
}

// Firebase auto-restores the Google session on page reload
auth.onAuthStateChanged(user => {
  if (user) {
    state.user = user;
    if (!state.sessionStart) state.sessionStart = new Date();
    const displayName = user.displayName || user.email.split("@")[0];
    setSidebarUser(displayName, user.photoURL);
    // If user lands on login/landing page while already signed in, go to dashboard
    const activePage = document.querySelector(".page.active");
    if (activePage && (activePage.id === "page-login" || activePage.id === "page-landing")) {
      showPage("dashboard");
    }
  } else {
    state.user = null;
  }
});

// ── Google Sign-In ──────────────────────────────────────────────
async function handleGoogleSignIn() {
  const btn = document.getElementById("google-signin-btn");
  const errEl = document.getElementById("login-error");

  errEl.classList.remove("visible");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Signing in…";

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    const result = await auth.signInWithPopup(provider);
    const user = result.user;

    // Extract name from Google profile
    const displayName = user.displayName || user.email.split("@")[0];
    state.user = user;
    state.sessionStart = new Date();
    setSidebarUser(displayName, user.photoURL);

    toast("Welcome, " + displayName + "! 🎉", "success");
    showPage("dashboard");
  } catch (err) {
    console.error("Google Sign-In error:", err.code, err.message);
    if (err.code === "auth/popup-closed-by-user") {
      // User closed the popup — no error shown
    } else if (err.code === "auth/popup-blocked") {
      errEl.textContent = "Popup was blocked by your browser. Please allow popups for this site.";
      errEl.classList.add("visible");
    } else {
      errEl.textContent = err.message;
      errEl.classList.add("visible");
    }
  } finally {
    btn.disabled = false;
    btn.querySelector("span").textContent = "Continue with Google";
  }
}

// ── Logout ──────────────────────────────────────────────────────
async function handleLogout() {
  try {
    await fetch(`${API_BASE}/session/${state.sessionId}`, { method: "DELETE" }).catch(() => { });
    await auth.signOut();
  } catch (e) { /* ignore */ }
  Object.assign(state, { user: null, sessionId: crypto.randomUUID(), uploadedData: null, schemaInfo: null, tableName: null, sqlChatHistory: [], pdfFilename: null, pdfChatHistory: [], queryCount: 0, sessionStart: null });
  showPage("landing");
  toast("Signed out. See you soon! 👋", "info");
}





// ═══════════════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
function toast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3500);
}

// ═══════════════════════════════════════════════════════════════
//  LOADING OVERLAY
// ═══════════════════════════════════════════════════════════════
function showLoading(text = "Processing…") {
  document.getElementById("loading-text").textContent = text;
  document.getElementById("loading-overlay").style.display = "flex";
}
function hideLoading() {
  document.getElementById("loading-overlay").style.display = "none";
}

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════
function updateDashboard() {
  const sqlStatus = state.uploadedData ? `${state.uploadedData.df.length.toLocaleString()} rows loaded` : "Not loaded";
  const pdfStatus = state.pdfFilename ? state.pdfFilename.substring(0, 22) + (state.pdfFilename.length > 22 ? '...' : '') : "Not loaded";
  document.getElementById("dash-sql-status").textContent = sqlStatus;
  document.getElementById("dash-pdf-status").textContent = pdfStatus;
  document.getElementById("dash-query-count").textContent = state.queryCount;
  if (state.sessionStart) {
    const mins = Math.floor((new Date() - state.sessionStart) / 60000);
    document.getElementById("dash-session-time").textContent = mins < 1 ? "Just started" : `${mins} min ago`;
  } else {
    document.getElementById("dash-session-time").textContent = "Just started";
  }
}

// ═══════════════════════════════════════════════════════════════
//  DATA UPLOAD & CLEAN
// ═══════════════════════════════════════════════════════════════
// Drag and drop
const dataDropzone = document.getElementById("data-dropzone");
if (dataDropzone) {
  dataDropzone.addEventListener("dragover", e => { e.preventDefault(); dataDropzone.classList.add("dragover"); });
  dataDropzone.addEventListener("dragleave", () => dataDropzone.classList.remove("dragover"));
  dataDropzone.addEventListener("drop", e => {
    e.preventDefault();
    dataDropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length) handleDataUpload(e.dataTransfer.files[0]);
  });
}

async function handleDataUpload(file) {
  if (!file) return;
  showLoading("Uploading & processing data…");

  try {
    // Parse locally for preview
    let df, columns;
    if (file.name.endsWith(".csv") || file.name.endsWith(".txt")) {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
      df = parsed.data;
      columns = parsed.meta.fields;
    } else {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      df = XLSX.utils.sheet_to_json(ws);
      columns = df.length > 0 ? Object.keys(df[0]) : [];
    }

    if (!df.length) { toast("File is empty", "error"); hideLoading(); return; }

    state.uploadedData = { df, columns, filename: file.name };

    // Upload to backend for SQL
    const formData = new FormData();
    formData.append("file", file);
    formData.append("session_id", state.sessionId);

    const res = await fetch(`${API_BASE}/sql/upload`, { method: "POST", body: formData });
    const data = await res.json();

    if (res.ok) {
      state.schemaInfo = data.schema;
      state.tableName = data.schema.table_name;
      renderDataSection();
      toast("Data uploaded successfully", "success");
    } else {
      toast(data.detail || "Upload failed", "error");
    }
  } catch (err) {
    toast("Error processing file: " + err.message, "error");
  }
  hideLoading();
}

function renderDataSection() {
  const { df, columns, filename } = state.uploadedData;
  document.getElementById("data-loaded-section").style.display = "block";
  document.getElementById("data-dropzone").style.display = "none";

  // Loaded message
  document.getElementById("data-loaded-msg").innerHTML =
    `✅ <b>${filename}</b> loaded into SQL table: <code>${state.tableName}</code>`;

  // Stat pills
  const nulls = df.reduce((sum, row) => sum + columns.filter(c => row[c] == null || row[c] === "").length, 0);
  document.getElementById("data-stat-pills").innerHTML = [
    `<b>Rows</b> ${df.length.toLocaleString()}`,
    `<b>Columns</b> ${columns.length}`,
    `<b>Missing</b> ${nulls}`,
  ].map(h => `<span class="stat-pill">${h}</span>`).join("");

  // Preview table (first 20 rows)
  document.getElementById("data-preview-table").innerHTML = buildHTMLTable(columns, df.slice(0, 20));

  // Statistics table
  const numCols = columns.filter(c => df.some(r => typeof r[c] === "number"));
  if (numCols.length) {
    const statsRows = ["count", "mean", "min", "max"].map(stat => {
      const row = { Stat: stat };
      numCols.forEach(c => {
        const vals = df.map(r => r[c]).filter(v => typeof v === "number");
        if (stat === "count") row[c] = vals.length;
        else if (stat === "mean") row[c] = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
        else if (stat === "min") row[c] = Math.min(...vals).toFixed(2);
        else if (stat === "max") row[c] = Math.max(...vals).toFixed(2);
      });
      return row;
    });
    document.getElementById("data-stats-table").innerHTML = buildHTMLTable(["Stat", ...numCols], statsRows);
  }
  updateVizOptions();
}

function buildHTMLTable(columns, rows) {
  const ths = columns.map(c => `<th>${c}</th>`).join("");
  const trs = rows.map(r => `<tr>${columns.map(c => `<td>${r[c] ?? ""}</td>`).join("")}</tr>`).join("");
  return `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function switchTab(prefix, name, btn) {
  document.querySelectorAll(`[id^="${prefix}-"]`).forEach(el => el.classList.remove("active"));
  document.getElementById(`${prefix}-${name}`).classList.add("active");
  btn.parentElement.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

function toggleGuide(header) {
  const section = header.parentElement;
  section.classList.toggle("open");
}

// ── Cleaning ──
function applyDataCleaning() {
  if (!state.uploadedData) return;
  let { df, columns } = state.uploadedData;
  df = JSON.parse(JSON.stringify(df)); // deep clone

  const numMethod = document.getElementById("clean-numeric").value;
  const catMethod = document.getElementById("clean-categorical").value;
  const dupMethod = document.getElementById("clean-duplicates").value;

  const numCols = columns.filter(c => df.some(r => typeof r[c] === "number"));
  const catCols = columns.filter(c => !numCols.includes(c));

  if (dupMethod === "Remove duplicates") {
    const seen = new Set();
    df = df.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (numMethod === "Drop rows") {
    df = df.filter(r => numCols.every(c => r[c] != null && r[c] !== ""));
  } else if (numMethod === "Fill with Mean" || numMethod === "Fill with Median") {
    numCols.forEach(c => {
      const vals = df.map(r => r[c]).filter(v => typeof v === "number");
      let fill;
      if (numMethod === "Fill with Mean") fill = vals.reduce((a, b) => a + b, 0) / vals.length;
      else { const sorted = [...vals].sort((a, b) => a - b); fill = sorted[Math.floor(sorted.length / 2)]; }
      df.forEach(r => { if (r[c] == null || r[c] === "") r[c] = fill; });
    });
  } else if (numMethod === "Fill with Zero") {
    numCols.forEach(c => { df.forEach(r => { if (r[c] == null || r[c] === "") r[c] = 0; }); });
  }
  if (catMethod === "Drop rows") {
    df = df.filter(r => catCols.every(c => r[c] != null && r[c] !== ""));
  } else if (catMethod === "Fill with Mode") {
    catCols.forEach(c => {
      const freq = {};
      df.forEach(r => { if (r[c] != null && r[c] !== "") freq[r[c]] = (freq[r[c]] || 0) + 1; });
      const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (mode) df.forEach(r => { if (r[c] == null || r[c] === "") r[c] = mode; });
    });
  } else if (catMethod === 'Fill with "Unknown"') {
    catCols.forEach(c => { df.forEach(r => { if (r[c] == null || r[c] === "") r[c] = "Unknown"; }); });
  }

  state.uploadedData.df = df;
  renderDataSection();
  toast(`Cleaned! ${df.length} rows remaining.`, "success");
}

// ── Visualization ──
function updateVizOptions() {
  if (!state.uploadedData) return;
  const { df, columns } = state.uploadedData;
  const numCols = columns.filter(c => df.some(r => typeof r[c] === "number"));
  const catCols = columns.filter(c => !numCols.includes(c));
  const type = document.getElementById("viz-chart-type").value;
  let html = "";

  if (type === "Histogram" || type === "Box Plot") {
    html = `<div class="input-group"><label>Column</label><select class="input-field" id="viz-col1">${numCols.map(c => `<option>${c}</option>`).join("")}</select></div>`;
  } else if (type === "Scatter Plot" || type === "Line Chart") {
    html = `<div class="input-group"><label>X Axis</label><select class="input-field" id="viz-col1">${numCols.map(c => `<option>${c}</option>`).join("")}</select></div>
             <div class="input-group"><label>Y Axis</label><select class="input-field" id="viz-col2">${numCols.slice(1).concat(numCols.slice(0, 1)).map(c => `<option>${c}</option>`).join("")}</select></div>`;
  } else if (type === "Bar Chart") {
    html = `<div class="input-group"><label>Category</label><select class="input-field" id="viz-col1">${catCols.map(c => `<option>${c}</option>`).join("")}</select></div>
             <div class="input-group"><label>Value</label><select class="input-field" id="viz-col2">${numCols.map(c => `<option>${c}</option>`).join("")}</select></div>`;
  } else if (type === "Pie Chart") {
    html = `<div class="input-group"><label>Column</label><select class="input-field" id="viz-col1">${catCols.map(c => `<option>${c}</option>`).join("")}</select></div>`;
  }
  document.getElementById("viz-options-container").innerHTML = html;
}

function renderChart() {
  if (!state.uploadedData) return;
  const { df } = state.uploadedData;
  const type = document.getElementById("viz-chart-type").value;
  const col1 = document.getElementById("viz-col1")?.value;
  const col2 = document.getElementById("viz-col2")?.value;
  const target = document.getElementById("plotly-chart");
  const layout = { paper_bgcolor: "transparent", plot_bgcolor: "rgba(19,240,208,0.02)", font: { color: "#8b92ab", family: "Inter" }, margin: { t: 40, r: 20, b: 40, l: 50 } };

  let traces = [];
  if (type === "Histogram") {
    traces = [{ x: df.map(r => r[col1]), type: "histogram", marker: { color: "rgba(19,240,208,0.55)" } }];
    layout.title = `Histogram — ${col1}`;
  } else if (type === "Scatter Plot") {
    traces = [{ x: df.map(r => r[col1]), y: df.map(r => r[col2]), mode: "markers", marker: { color: "rgba(155,121,240,0.65)", size: 6 } }];
    layout.title = `${col2} vs ${col1}`;
  } else if (type === "Box Plot") {
    traces = [{ y: df.map(r => r[col1]), type: "box", marker: { color: "rgba(19,240,208,0.6)" } }];
    layout.title = `Box Plot — ${col1}`;
  } else if (type === "Bar Chart") {
    const agg = {};
    df.forEach(r => { if (!agg[r[col1]]) agg[r[col1]] = []; agg[r[col1]].push(r[col2]); });
    const cats = Object.keys(agg);
    const vals = cats.map(k => agg[k].reduce((a, b) => a + (b || 0), 0) / agg[k].length);
    traces = [{ x: cats, y: vals, type: "bar", marker: { color: "rgba(19,240,208,0.55)" } }];
    layout.title = `Avg ${col2} by ${col1}`;
  } else if (type === "Line Chart") {
    const sorted = [...df].sort((a, b) => (a[col1] || 0) - (b[col1] || 0));
    traces = [{ x: sorted.map(r => r[col1]), y: sorted.map(r => r[col2]), mode: "lines+markers", line: { color: "#13f0d0", width: 2 }, marker: { color: "#13f0d0", size: 5 } }];
    layout.title = `${col2} over ${col1}`;
  } else if (type === "Pie Chart") {
    const freq = {};
    df.forEach(r => { freq[r[col1]] = (freq[r[col1]] || 0) + 1; });
    traces = [{ labels: Object.keys(freq), values: Object.values(freq), type: "pie", marker: { colors: ["#13f0d0", "#9b79f0", "#2dd773", "#f0b429", "#f1505e", "#06b6d4", "#e879f9"] } }];
    layout.title = `Distribution — ${col1}`;
  } else if (type === "Correlation Heatmap") {
    const numCols = state.uploadedData.columns.filter(c => df.some(r => typeof r[c] === "number"));
    const matrix = numCols.map(c1 => numCols.map(c2 => {
      const v1 = df.map(r => r[c1]).filter(v => typeof v === "number");
      const v2 = df.map(r => r[c2]).filter(v => typeof v === "number");
      const n = Math.min(v1.length, v2.length);
      if (n < 2) return 0;
      const m1 = v1.reduce((a, b) => a + b, 0) / n, m2 = v2.reduce((a, b) => a + b, 0) / n;
      const num = v1.slice(0, n).reduce((s, v, i) => s + (v - m1) * (v2[i] - m2), 0);
      const d1 = Math.sqrt(v1.slice(0, n).reduce((s, v) => s + (v - m1) ** 2, 0));
      const d2 = Math.sqrt(v2.slice(0, n).reduce((s, v) => s + (v - m2) ** 2, 0));
      return d1 && d2 ? num / (d1 * d2) : 0;
    }));
    traces = [{ z: matrix, x: numCols, y: numCols, type: "heatmap", colorscale: [[0, "#9b79f0"], [0.5, "#10141f"], [1, "#13f0d0"]] }];
    layout.title = "Correlation Heatmap";
  }
  Plotly.newPlot(target, traces, layout, { responsive: true });
}

// ═══════════════════════════════════════════════════════════════
//  SQL AI ANALYSIS
// ═══════════════════════════════════════════════════════════════
function updateSQLPage() {
  const hasData = !!state.schemaInfo;
  document.getElementById("sql-no-data").style.display = hasData ? "none" : "block";
  document.getElementById("sql-loaded-section").style.display = hasData ? "block" : "none";

  if (hasData) {
    const s = state.schemaInfo;
    document.getElementById("sql-schema-bar").innerHTML =
      `<div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap;">
        <div><div style="font-size:10px;color:var(--t-3);text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-bottom:3px">Table</div>
        <div style="font-size:15px;font-weight:700;color:var(--c-teal);font-family:var(--mono)">${s.table_name}</div></div>
        <div><div style="font-size:10px;color:var(--t-3);text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-bottom:3px">Rows</div>
        <div style="font-size:15px;font-weight:700;color:var(--t-1);">${s.row_count.toLocaleString()}</div></div>
        <div><div style="font-size:10px;color:var(--t-3);text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-bottom:3px">Columns</div>
        <div style="font-size:15px;font-weight:700;color:var(--t-1);">${s.columns.length}</div></div>
      </div>`;

    const suggestions = [
      "Show first 10 rows", "How many rows are there?",
      "What are all column names?", "Show summary statistics",
      "Find rows with missing values", "Which value appears most often?"
    ];
    document.getElementById("sql-suggestions").innerHTML = suggestions.map(s =>
      `<button class="suggestion-pill" onclick="sendSQLQuery('${s}')">${s}</button>`
    ).join("");
  }
}

async function sendSQLQuery(question) {
  if (!question) {
    question = document.getElementById("sql-chat-input").value.trim();
    if (!question) return;
    document.getElementById("sql-chat-input").value = "";
  }

  addChatMsg("sql", "user", question);
  showLoading("AI is analyzing your data…");

  try {
    const res = await fetch(`${API_BASE}/sql/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.sessionId, question }),
    });
    const data = await res.json();

    if (res.ok) {
      let aiHTML = "";
      if (data.sql_query) aiHTML += `<div class="sql-block">${escapeHTML(data.sql_query)}</div>`;
      if (data.results?.length) {
        const cols = data.columns || Object.keys(data.results[0]);
        aiHTML += `<div class="data-table-wrap" style="max-height:250px;overflow:auto;">${buildHTMLTable(cols, data.results.slice(0, 50))}</div>`;
      }
      if (data.ai_summary) aiHTML += `<div style="margin-top:10px;line-height:1.7;">${formatMarkdown(data.ai_summary)}</div>`;
      addChatMsg("sql", "ai", aiHTML, true);
      state.queryCount++;
    } else {
      addChatMsg("sql", "ai", `Error: ${data.detail || "Error processing query"}`);
    }
  } catch (err) {
    addChatMsg("sql", "ai", `Network error: ${err.message}`);
  }
  hideLoading();
}

function clearSQLChat() {
  state.sqlChatHistory = [];
  document.getElementById("sql-chat-container").innerHTML = "";
}

// ═══════════════════════════════════════════════════════════════
//  PDF AI ANALYSIS
// ═══════════════════════════════════════════════════════════════
const pdfDropzone = document.getElementById("pdf-dropzone");
if (pdfDropzone) {
  pdfDropzone.addEventListener("dragover", e => { e.preventDefault(); pdfDropzone.classList.add("dragover"); });
  pdfDropzone.addEventListener("dragleave", () => pdfDropzone.classList.remove("dragover"));
  pdfDropzone.addEventListener("drop", e => {
    e.preventDefault(); pdfDropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length) handlePDFUpload(e.dataTransfer.files[0]);
  });
}

async function handlePDFUpload(file) {
  if (!file) return;
  showLoading("Processing PDF…");

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("session_id", state.sessionId);

    const res = await fetch(`${API_BASE}/pdf/upload`, { method: "POST", body: formData });
    const data = await res.json();

    if (res.ok) {
      state.pdfFilename = file.name;
      document.getElementById("pdf-loaded-section").style.display = "block";
      document.getElementById("pdf-dropzone-title").textContent = file.name;
      document.getElementById("pdf-dropzone-sub").textContent = `${data.page_count} pages · ${(data.text_length / 1024).toFixed(1)} KB text extracted`;
      document.getElementById("pdf-loaded-msg").innerHTML =
        `<b>${file.name}</b> — ${data.page_count} pages, ${data.text_length.toLocaleString()} characters processed`;
      toast("PDF uploaded successfully", "success");
    } else {
      toast(data.detail || "PDF upload failed", "error");
    }
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
  hideLoading();
}

async function generatePDFSummary() {
  showLoading("Generating summary…");
  try {
    const formData = new FormData();
    formData.append("session_id", state.sessionId);
    const res = await fetch(`${API_BASE}/pdf/summarize`, { method: "POST", body: formData });
    const data = await res.json();
    if (res.ok) {
      addChatMsg("pdf", "ai", formatMarkdown(data.summary), true);
      state.queryCount++;
    } else {
      toast(data.detail || "Error", "error");
    }
  } catch (err) { toast("Error: " + err.message, "error"); }
  hideLoading();
}

async function sendPDFQuery(question) {
  if (!question) return;
  addChatMsg("pdf", "user", question);
  showLoading("Analyzing your PDF…");

  try {
    const res = await fetch(`${API_BASE}/pdf/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.sessionId, question }),
    });
    const data = await res.json();
    if (res.ok) {
      addChatMsg("pdf", "ai", formatMarkdown(data.answer), true);
      state.queryCount++;
    } else {
      addChatMsg("pdf", "ai", `Error: ${data.detail || "Error"}`);
    }
  } catch (err) {
    addChatMsg("pdf", "ai", `Error: ${err.message}`);
  }
  hideLoading();
}

function sendPDFQueryFromInput() {
  const input = document.getElementById("pdf-chat-input");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  sendPDFQuery(q);
}

function clearPDFChat() {
  state.pdfChatHistory = [];
  document.getElementById("pdf-chat-container").innerHTML = "";
}

// ═══════════════════════════════════════════════════════════════
//  CHAT HELPERS
// ═══════════════════════════════════════════════════════════════
function addChatMsg(type, role, content, isHTML = false) {
  const container = document.getElementById(`${type}-chat-container`);
  const div = document.createElement("div");
  div.className = `chat-msg chat-msg-${role === "user" ? "user" : "ai"}`;
  const label = role === "user"
    ? `<div class="chat-msg-ai-label" style="color:var(--t-3)">You</div>`
    : `<div class="chat-msg-ai-label">Sarvam AI</div>`;
  div.innerHTML = label + (isHTML ? content : escapeHTML(content));
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/`(.+?)`/g, `<code style="background:rgba(19,240,208,0.08);padding:2px 6px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--c-teal);">$1</code>`)
    .replace(/\n/g, "<br/>");
}

// (Guide accordion is now handled by toggleGuide() function called via onclick in HTML)

