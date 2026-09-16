// The scanner — step 5 of docs/DESIGN.md's build order (§4.1, §9). Replaces
// ukrainian-anki-scanner's upload-photos-download-a-file flow: take/choose photos
// here, and the extracted cards land directly in the deck (D10 — no ingest review
// step; `index.html`'s Edit is the repair path for anything wrong).
//
// D8 (image prep in the browser): EXIF orientation and downscaling happen here via
// `createImageBitmap` (which applies EXIF rotation itself) and a canvas resize,
// mirroring claude_parser.py's own `optimize_image` — same target edge (1568px,
// the size the API downscales to server-side anyway) and JPEG quality (0.85).
//
// Deliberately sequential, not the Python app's ThreadPoolExecutor(3): a typical
// session is a handful of pages, each already taking several seconds of model
// time, and sequential processing means deterministic per-photo result ordering
// with no progress-bar bookkeeping to get right.

import { captureTokenFromUrl, getToken } from "./auth.js";
import { API_BASE } from "./config.js";

const MAX_IMAGE_EDGE = 1568;
const JPEG_QUALITY = 0.85;

const fileInput = document.getElementById("file-input");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const emptyHint = document.getElementById("empty-hint");

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Orients and downscales a camera photo to a base64 JPEG, entirely client-side —
 * the browser never uploads a 12MB original over mobile data (D8). */
async function toJpegBase64(file) {
  const bitmap = await createImageBitmap(file); // applies EXIF orientation itself
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1); // drop the "data:image/jpeg;base64," prefix
}

async function scanFile(file) {
  const imageBase64 = await toJpegBase64(file);
  const res = await fetch(API_BASE + "/scan/page", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ imageBase64, mediaType: "image/jpeg" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Scan failed (${res.status})`);
  return data; // { imported, rejected } — src/scan/import.ts's ImportResult
}

function renderResult(label, result) {
  emptyHint.hidden = true;
  const row = document.createElement("div");
  row.className = "scan-result";
  row.innerHTML = `
    <div class="scan-result-label">${escapeHtml(label)}</div>
    <div class="scan-result-counts">
      <span class="imported">+${result.imported.length}</span>
      ${result.rejected.length ? `<span class="rejected">${result.rejected.length} skipped</span>` : ""}
    </div>
    ${
      result.imported
        .map((c) => `<div class="scan-card">${escapeHtml(c.lemma)} — ${escapeHtml(c.lemmaTranslation)}</div>`)
        .join("")
    }
  `;
  resultsEl.prepend(row);
  return row;
}

function renderError(label, message) {
  const row = renderResult(label, { imported: [], rejected: [] });
  row.classList.add("scan-error");
  row.querySelector(".scan-result-counts").textContent = message;
}

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = ""; // lets the same file be re-selected later
  if (!files.length) return;

  statusEl.hidden = false;
  for (const [i, file] of files.entries()) {
    statusEl.textContent = `Processing photo ${i + 1} of ${files.length}…`;
    try {
      renderResult(file.name, await scanFile(file));
    } catch (e) {
      console.error(e);
      renderError(file.name, e.message);
    }
  }
  statusEl.hidden = true;
});

captureTokenFromUrl();
if (!getToken()) {
  document.body.innerHTML = `<div id="error" style="text-align:center;padding:60px 16px;color:var(--fg-muted)">No access token. Open your install link again.</div>`;
}
