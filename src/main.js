import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import "./styles.css";

/** @type {Array<Record<string, unknown>>} */
let lastReadings = [];

const PASSWORD_STORAGE_KEY = "bacchus-report-password";
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const sessionInput = document.getElementById("session-ids");
const passwordInput = document.getElementById("access-password");
const fetchBtn = document.getElementById("btn-fetch");
const pdfBtn = document.getElementById("btn-pdf");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const previewSummary = document.getElementById("preview-summary");
const resultsBody = document.querySelector("#results-table tbody");

const savedPassword = sessionStorage.getItem(PASSWORD_STORAGE_KEY);
if (savedPassword) passwordInput.value = savedPassword;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = `status${kind ? ` is-${kind}` : ""}`;
}

function parseSessionIds(raw) {
  const ids = raw
    .split(/[\n,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function deviceInfoText(info) {
  if (!info || typeof info !== "object") return "—";
  const parts = [
    info.manufacturerName,
    info.modelNumber,
    info.serialNumber,
    info.firmwareRevision,
    info.softwareRevision,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

function deviceUid(row) {
  return row.device_uuid ?? row.device_u_id ?? row.deviceUuid;
}

function scentValue(row) {
  return row.scent ?? row.Scent;
}

function sweatValue(row) {
  return row.sweat ?? row.Sweat;
}

async function fetchReadings(sessionIds, password) {
  const res = await fetch(`${API_BASE}/api/readings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Report-Password": password,
    },
    body: JSON.stringify({ sessionIds }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || `Request failed (${res.status})`);
  }
  return payload.readings || [];
}

function renderPreview(readings, sessionIds) {
  resultsBody.innerHTML = "";

  if (!readings.length) {
    previewEl.hidden = true;
    return;
  }

  previewEl.hidden = false;
  previewSummary.textContent = `${readings.length} reading${
    readings.length === 1 ? "" : "s"
  } · ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"}`;

  const fragment = document.createDocumentFragment();
  for (const row of readings) {
    const tr = document.createElement("tr");
    const cells = [
      row.id,
      row.sessionId,
      row.sensorValue,
      row.temperature,
      row.battery,
      row.timestampEST ?? row.timestamp,
      row.drinkingStatus,
      row.smokingStatus,
    ];
    for (const cell of cells) {
      const td = document.createElement("td");
      td.textContent = formatValue(cell);
      tr.appendChild(td);
    }
    fragment.appendChild(tr);
  }
  resultsBody.appendChild(fragment);
}

function buildPdfForSession(sessionId, readings) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const generatedAt = new Date().toLocaleString();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Bacchus Session Report", 40, 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(`Generated: ${generatedAt}`, 40, 54);
  doc.text(`Session: ${sessionId}`, 40, 68, { maxWidth: 720 });
  doc.text(`Total readings: ${readings.length}`, 40, 82);
  doc.setTextColor(0);

  const head = [
    [
      "Doc ID",
      "Session",
      "Sensor",
      "Temp",
      "Battery",
      "Timestamp EST",
      "Unix ts",
      "Drinking",
      "Smoking",
      "User",
      "Device UID",
      "Device",
      "Type",
      "Scent",
      "Sweat",
    ],
  ];

  const body = readings.map((row) => [
    formatValue(row.id),
    formatValue(row.sessionId),
    formatValue(row.sensorValue),
    formatValue(row.temperature),
    formatValue(row.battery),
    formatValue(row.timestampEST),
    formatValue(row.timestamp),
    formatValue(row.drinkingStatus),
    formatValue(row.smokingStatus),
    formatValue(row.userId),
    formatValue(deviceUid(row)),
    deviceInfoText(row.deviceInfo),
    formatValue(row.type),
    formatValue(scentValue(row)),
    formatValue(sweatValue(row)),
  ]);

  autoTable(doc, {
    startY: 96,
    head,
    body,
    styles: {
      fontSize: 7,
      cellPadding: 3,
      overflow: "linebreak",
      valign: "top",
    },
    headStyles: {
      fillColor: [13, 110, 110],
      textColor: 255,
      fontStyle: "bold",
    },
    alternateRowStyles: { fillColor: [243, 246, 248] },
    margin: { left: 28, right: 28 },
  });

  return doc.output("arraybuffer");
}

async function downloadPdfsBySession(readings, sessionIds) {
  const bySession = new Map();
  for (const id of sessionIds) bySession.set(id, []);
  for (const row of readings) {
    const id = String(row.sessionId || "");
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(row);
  }

  const files = [];
  let skipped = 0;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  for (const [sessionId, rows] of bySession) {
    if (!rows.length) {
      skipped += 1;
      continue;
    }
    files.push({
      name: `bacchus-${sessionId}.pdf`,
      data: buildPdfForSession(sessionId, rows),
    });
  }

  if (!files.length) {
    return { downloaded: 0, skipped };
  }

  if (files.length === 1) {
    saveAs(
      new Blob([files[0].data], { type: "application/pdf" }),
      files[0].name.replace(/\.pdf$/, `-${stamp}.pdf`)
    );
    return { downloaded: 1, skipped };
  }

  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file.data);
  }
  const zipBlob = await zip.generateAsync({ type: "blob" });
  saveAs(zipBlob, `bacchus-sessions-${stamp}.zip`);
  return { downloaded: files.length, skipped };
}

async function onFetch() {
  const sessionIds = parseSessionIds(sessionInput.value);
  const password = passwordInput.value.trim();

  if (!sessionIds.length) {
    setStatus("Enter at least one session ID.", "error");
    return;
  }

  if (!password) {
    setStatus("Enter the access password to fetch readings.", "error");
    passwordInput.focus();
    return;
  }

  fetchBtn.disabled = true;
  pdfBtn.disabled = true;
  lastReadings = [];
  previewEl.hidden = true;
  setStatus(
    `Querying sensorReadings for ${sessionIds.length} session ID(s)…`,
    "loading"
  );

  try {
    const readings = await fetchReadings(sessionIds, password);
    sessionStorage.setItem(PASSWORD_STORAGE_KEY, password);
    lastReadings = readings;
    renderPreview(readings, sessionIds);

    if (!readings.length) {
      setStatus("No readings found for those session ID(s).", "error");
      return;
    }

    pdfBtn.disabled = false;
    const sessionCount = new Set(readings.map((r) => r.sessionId)).size;
    setStatus(
      `Found ${readings.length} reading${readings.length === 1 ? "" : "s"} across ${sessionCount} session${sessionCount === 1 ? "" : "s"}. Ready to export PDF${sessionCount === 1 ? "" : "s"}.`,
      "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus(err?.message || "Failed to fetch readings.", "error");
  } finally {
    fetchBtn.disabled = false;
  }
}

async function onDownloadPdf() {
  const sessionIds = parseSessionIds(sessionInput.value);
  if (!lastReadings.length) {
    setStatus("Fetch readings before exporting a PDF.", "error");
    return;
  }
  pdfBtn.disabled = true;
  setStatus("Building PDF(s)…", "loading");
  try {
    const { downloaded, skipped } = await downloadPdfsBySession(
      lastReadings,
      sessionIds
    );
    if (!downloaded) {
      setStatus("No sessions with readings to export.", "error");
      return;
    }
    const skipNote = skipped
      ? ` Skipped ${skipped} session${skipped === 1 ? "" : "s"} with no readings.`
      : "";
    const packNote =
      downloaded > 1
        ? ` Packaged as a ZIP with ${downloaded} separate PDFs.`
        : "";
    setStatus(`Export complete.${packNote}${skipNote}`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(err?.message || "Failed to build PDF.", "error");
  } finally {
    pdfBtn.disabled = false;
  }
}

fetchBtn.addEventListener("click", onFetch);
pdfBtn.addEventListener("click", onDownloadPdf);

sessionInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    onFetch();
  }
});

passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    onFetch();
  }
});
