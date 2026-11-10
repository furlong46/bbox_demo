// AI Parse Document bbox citation demo: frontend (vanilla JS + PDF.js)
const PDFJS_VER = "4.4.168";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build`;

// Static, trusted explanation content for each tab (rendered as HTML).
const EXPLAIN = {
  img: {
    title: "How Option 1 works: boxes drawn directly on the rendered page images",
    html: `
      <p class="lead">Bboxes are drawn in the <b>native coordinate space of the rendered page image</b>.
      No normalization is needed, so this is pixel-perfect by construction.</p>
      <ol class="steps">
        <li><b>Parse:</b> <code>ai_parse_document</code> renders each PDF page to an image. With
          <code>imageOutputPath</code> set, it saves those images to a UC volume. Every element's
          <code>bbox</code> is <code>[x0, y0, x1, y1]</code> in <b>pixels on that image</b>, with a 0-based <code>page_id</code>.</li>
        <li><b>Extract:</b> <code>ai_extract</code> with <code>version 2.1</code> and <code>enableCitations</code> returns
          <code>{value, citation_ids}</code> for each field. Each citation id maps to
          <code>metadata.citations[id].bbox</code>, the same shape as the parser's element bboxes.</li>
        <li><b>Render:</b> the app displays the saved page image and scales each box by the ratio of displayed width to natural width.</li>
      </ol>
      <div class="formula">s = img.clientWidth / img.naturalWidth &nbsp;→&nbsp; left = x0·s, top = y0·s, width = (x1−x0)·s, height = (y1−y0)·s</div>
      <div class="proscons">
        <div><h4>Pros</h4><ul><li>Simplest: no PDF geometry math</li><li>Same coordinate space as the model, so boxes always line up</li></ul></div>
        <div><h4>Cons</h4><ul><li>Raster image: blurry when zoomed, no text selection</li><li>Larger files to store and serve</li></ul></div>
      </div>`,
  },
  pdf: {
    title: "How Option 2 works: normalized boxes on the original PDF (PDF.js)",
    html: `
      <p class="lead">Bboxes are <b>normalized to 0–1 using the rendered page image size</b>, then scaled to the PDF.js viewport.
      This is the approach to use when your web app renders the original PDF.</p>
      <ol class="steps">
        <li><b>Find the denominator:</b> the bbox pixels are relative to the rendered page image, not the PDF. The response has no width or height,
          so at ingest the pipeline reads each saved image's header (<code>PIL.Image.open(uri).size</code>).</li>
        <li><b>Normalize once at ingest:</b> <code>rel = [x0/w, y0/h, x1/w, y1/h]</code>, stored in <code>bbox_demo_citations</code>.</li>
        <li><b>Render:</b> PDF.js draws the original PDF at any zoom (<code>page.getViewport({scale})</code>). Each box is placed at <code>rel × viewport size</code>.</li>
      </ol>
      <div class="formula">left = rel_x0·vw, top = rel_y0·vh, width = (rel_x1−rel_x0)·vw, height = (rel_y1−rel_y0)·vh</div>
      <ul class="notes">
        <li><b>No y-flip:</b> image space and the PDF.js viewport both have a top-left origin with y pointing down.
          A flip is only needed when drawing in raw PDF user space (bottom-left origin).</li>
        <li><b>Never assume a DPI:</b> the render resolution is not a documented contract and has changed before (about 120 → 200 DPI).
          Always divide by the actual image dimensions.</li>
        <li><b>Geometry check:</b> each page compares the image aspect ratio with the PDF viewport's. A difference over 1% shows a warning badge,
          which catches rotated pages (<code>/Rotate</code>) and CropBox ≠ MediaBox.</li>
        <li><b>Zoom test:</b> change the zoom (50–200%). The boxes stay aligned because they are resolution-independent.</li>
      </ul>
      <div class="proscons">
        <div><h4>Pros</h4><ul><li>Crisp at any zoom, selectable text</li><li>Shows the original document</li></ul></div>
        <div><h4>Cons</h4><ul><li>Requires page image dimensions at ingest</li><li>Rotation and crop edge cases need validation</li></ul></div>
      </div>`,
  },
};
EXPLAIN.upload = {
  title: "How Option 3 works: upload a PDF and process it entirely in the app with REST APIs",
  html: `
    <p class="lead">This tab skips the notebook entirely. The app backend handles the upload, OCR and layout, extraction, and bbox normalization by calling the
    <b>AI Functions REST API</b>. It writes results to the <b>same UC tables</b> and renders them with the <b>Option 1 technique</b> (boxes on the rendered page images).</p>
    <ol class="steps">
      <li><b>Upload:</b> the browser posts the PDF to the app, which saves it to the source volume with the Files API (<code>w.files.upload</code>).</li>
      <li><b>Parse:</b> <code>POST /api/2.0/ai-functions/ai-parse-document</code> with <code>content</code> set to the volume path and
        <code>image_output_path</code> set to the page-image volume. It returns pages, elements and pixel <code>bbox</code>es on the rendered page images.</li>
      <li><b>Extract:</b> <code>POST /api/2.0/ai-functions/ai-extract</code> with <code>content</code> set to the parse response,
        <code>enable_citations: true</code> and <code>version: "2.1"</code>. It returns <code>{value, citation_ids}</code> for each field, plus <code>metadata.citations[].bbox</code>.</li>
      <li><b>Normalize:</b> the app downloads each saved page image, reads its size with Pillow, and computes <code>rel = [x0/w, y0/h, x1/w, y1/h]</code>.
        It never assumes a DPI.</li>
      <li><b>Persist:</b> the app replaces this document's rows in <code>bbox_demo_parsed</code>, <code>bbox_demo_extracted</code>,
        <code>bbox_demo_pages</code> and <code>bbox_demo_citations</code> through the SQL warehouse. The document then also appears in Options 1 and 2.</li>
    </ol>
    <div class="formula">same response shapes as the SQL functions → same flatten / normalize logic → s = img.clientWidth / img.naturalWidth for display</div>
    <div class="proscons">
      <div><h4>When to use</h4><ul><li>Interactive or near-real-time processing of single documents</li><li>Web or backend apps that need results without a batch job</li></ul></div>
      <div><h4>When to use the notebook or job</h4><ul><li>Batch backfills of many documents</li><li>Scheduled ingestion with retries and lineage</li></ul></div>
    </div>`,
};

EXPLAIN.upload_pdf = {
  title: "How Option 4 works: upload and process in the app with REST APIs, then draw normalized boxes on the original PDF",
  html: `
    <p class="lead">This tab combines the <b>Option 3 workflow</b> (upload and in-app processing through the AI Functions REST API) with the
    <b>Option 2 rendering technique</b> (bboxes normalized to 0–1, drawn over the original PDF with PDF.js).</p>
    <ol class="steps">
      <li><b>Upload:</b> the PDF is saved to the source volume with the Files API.</li>
      <li><b>Parse:</b> <code>POST /api/2.0/ai-functions/ai-parse-document</code> with <code>image_output_path</code>. The rendered page images are
        needed even though this tab never displays them, because their size is the denominator for normalization.</li>
      <li><b>Extract:</b> <code>POST /api/2.0/ai-functions/ai-extract</code> with <code>enable_citations: true</code>. It returns pixel bboxes on those page images.</li>
      <li><b>Normalize:</b> the app reads each page image's width and height with Pillow and stores <code>rel = [x0/w, y0/h, x1/w, y1/h]</code> in <code>bbox_demo_citations</code>.</li>
      <li><b>Render:</b> PDF.js draws the original uploaded PDF (<code>page.getViewport({scale})</code>), and each box is placed at <code>rel × viewport size</code>.</li>
    </ol>
    <div class="formula">left = rel_x0·vw, top = rel_y0·vh, width = (rel_x1−rel_x0)·vw, height = (rel_y1−rel_y0)·vh</div>
    <ul class="notes">
      <li><b>No y-flip:</b> both the page image and the PDF.js viewport have a top-left origin with y pointing down.</li>
      <li><b>Never assume a DPI:</b> the denominator is the real page-image size returned by the service, not PDF points × a guessed resolution.</li>
      <li><b>Geometry check:</b> a badge appears if the image aspect ratio and the PDF viewport's differ by more than 1% (rotation or CropBox cases).</li>
      <li><b>Zoom test:</b> change the zoom (50–200%). The boxes stay aligned with the crisp, selectable-text PDF.</li>
    </ul>
    <div class="proscons">
      <div><h4>Pros</h4><ul><li>Real-time, notebook-free processing</li><li>Original document at any zoom, with no raster images in the UI</li></ul></div>
      <div><h4>Cons</h4><ul><li>Still needs the page images at ingest to get the denominator</li><li>Rotation and crop edge cases need validation</li></ul></div>
    </div>`,
};

const SHARED_NOTE = `<p class="shared"><b>Multiple sources:</b> a field can have several <code>citation_ids</code>, and a citation can have several boxes,
  possibly on different pages. All are drawn in the field's color, and the badge on each card shows the count. Citations point to whole parsed elements
  (for example a table), so several fields may share one region. Overlapping boxes are inset slightly so each color stays visible.</p>`;

function renderExplain() {
  const e = EXPLAIN[state.tab];
  $("explainTitle").textContent = e.title;
  $("explainBody").innerHTML = e.html + SHARED_NOTE;
}
function setLive(text) {
  $("liveStats").textContent = text || "";
}

const state = { docs: [], docId: null, pages: [], fields: [], tab: "img", zoom: 1, pdfCache: {}, renderToken: 0 };
const $ = (id) => document.getElementById(id);
const pagesEl = $("pages");

// ---------- helpers ----------
function status(msg) {
  const s = $("status");
  s.textContent = msg || "";
  s.classList.toggle("show", !!msg);
}
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const pretty = (n) => n.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let pdfjsLib = null;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(`${PDFJS_BASE}/pdf.min.mjs`);
  try {
    // Browsers block cross-origin workers, so wrap the CDN worker in a same-origin blob module.
    const blob = new Blob([`import "${PDFJS_BASE}/pdf.worker.min.mjs";`], { type: "text/javascript" });
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: "module" });
  } catch (e) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
  }
  return pdfjsLib;
}

// ---------- highlighting ----------
function highlight(field, on) {
  document.querySelectorAll(".box").forEach((b) => {
    b.classList.toggle("hl", on && b.dataset.field === field);
    b.classList.toggle("dim", on && b.dataset.field !== field);
  });
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("hl", on && c.dataset.field === field));
}
function focusField(field) {
  const boxes = [...document.querySelectorAll(`.box[data-field="${CSS.escape(field)}"]`)];
  if (!boxes.length) return;
  boxes[0].scrollIntoView({ behavior: "smooth", block: "center" });
  boxes.forEach((b) => {
    b.classList.remove("pulse");
    void b.offsetWidth; // restart animation
    b.classList.add("pulse");
  });
}

// ---------- field cards ----------
function renderCards() {
  const root = $("fields");
  root.innerHTML = "";
  for (const f of state.fields) {
    const card = el("div", "card");
    card.style.setProperty("--c", f.color);
    card.dataset.field = f.field_name;
    card.appendChild(el("span", "dot"));
    const body = el("div", "body");
    body.appendChild(el("div", "name", pretty(f.field_name)));
    body.appendChild(el("div", "val", f.value ?? "—"));
    if (!f.boxes.length) body.appendChild(el("div", "nocite", "no citation"));
    card.appendChild(body);
    if (f.boxes.length) card.appendChild(el("span", "count", String(f.boxes.length)));
    card.addEventListener("mouseenter", () => highlight(f.field_name, true));
    card.addEventListener("mouseleave", () => highlight(f.field_name, false));
    card.addEventListener("click", () => focusField(f.field_name));
    root.appendChild(card);
  }
}

// ---------- box placement (shared) ----------
// Several fields often cite the same element (e.g. one table). Inset duplicates slightly so each color is visible.
function boxesForPage(pageId) {
  const out = [];
  const seen = {};
  for (const f of state.fields) {
    for (const b of f.boxes) {
      if (b.page_id !== pageId) continue;
      const key = `${b.x0},${b.y0},${b.x1},${b.y1}`;
      const idx = (seen[key] = (seen[key] ?? -1) + 1);
      out.push({ field: f, box: b, inset: idx * 4 });
    }
  }
  return out;
}
function placeBoxes(overlay, pageId, rectFn) {
  overlay.innerHTML = "";
  for (const { field, box, inset } of boxesForPage(pageId)) {
    const r = rectFn(box);
    const d = el("div", "box");
    d.style.setProperty("--c", field.color);
    d.dataset.field = field.field_name;
    d.style.left = `${r.l + inset}px`;
    d.style.top = `${r.t + inset}px`;
    d.style.width = `${Math.max(r.w - 2 * inset, 4)}px`;
    d.style.height = `${Math.max(r.h - 2 * inset, 4)}px`;
    const lbl = el("span", "lbl", `${pretty(field.field_name)}: ${field.value ?? ""}`);
    d.appendChild(lbl);
    d.addEventListener("mouseenter", () => highlight(field.field_name, true));
    d.addEventListener("mouseleave", () => highlight(field.field_name, false));
    d.addEventListener("click", () => {
      const card = document.querySelector(`.card[data-field="${CSS.escape(field.field_name)}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    overlay.appendChild(d);
  }
}

// ---------- Tab 1: page image overlay (pixel coords) ----------
const imgLayouts = [];
function renderImgTab() {
  state.renderToken++; // cancel any in-flight PDF render
  pagesEl.innerHTML = "";
  imgLayouts.length = 0;
  for (const p of state.pages) {
    const block = el("div", "page-block img-mode");
    const label = el("div", "page-label", `Page ${p.page_id + 1} · image ${p.img_width_px}×${p.img_height_px}px`);
    const wrap = el("div", "page");
    const img = new Image();
    img.alt = `Page ${p.page_id + 1}`;
    const overlay = el("div", "overlay");
    wrap.append(img, overlay);
    block.append(label, wrap);
    pagesEl.appendChild(block);
    const layout = () => {
      if (!img.naturalWidth) return;
      const s = img.clientWidth / img.naturalWidth;
      label.textContent = `Page ${p.page_id + 1} · image ${img.naturalWidth}×${img.naturalHeight}px · displayed at ${img.clientWidth}px (s = ${s.toFixed(3)})`;
      if (p.page_id === state.pages[0].page_id) {
        setLive(`This document: page image ${img.naturalWidth}×${img.naturalHeight}px, shown at ${img.clientWidth}×${img.clientHeight}px, so every bbox pixel is multiplied by s = ${s.toFixed(3)}.`);
      }
      overlay.style.width = `${img.clientWidth}px`;
      overlay.style.height = `${img.clientHeight}px`;
      placeBoxes(overlay, p.page_id, (b) => ({ l: b.x0 * s, t: b.y0 * s, w: (b.x1 - b.x0) * s, h: (b.y1 - b.y0) * s }));
    };
    img.onload = layout;
    imgLayouts.push(layout);
    img.src = `/api/documents/${state.docId}/pages/${p.page_id}/image`;
  }
}
window.addEventListener("resize", () => {
  if (state.tab === "img") imgLayouts.forEach((f) => f());
});

// ---------- Tab 2: PDF.js overlay (normalized coords) ----------
async function renderPdfTab() {
  const token = ++state.renderToken;
  pagesEl.innerHTML = "";
  status("Loading PDF…");
  const lib = await loadPdfJs();
  if (!state.pdfCache[state.docId]) {
    state.pdfCache[state.docId] = lib.getDocument({ url: `/api/documents/${state.docId}/pdf` }).promise;
  }
  const pdf = await state.pdfCache[state.docId];
  if (token !== state.renderToken) return;
  const dims = Object.fromEntries(state.pages.map((p) => [p.page_id, p]));
  const paneW = Math.min($("docPane").clientWidth - 48, 900);
  const dpr = window.devicePixelRatio || 1;

  for (let i = 1; i <= pdf.numPages; i++) {
    if (token !== state.renderToken) return; // a newer render started
    const page = await pdf.getPage(i);
    if (token !== state.renderToken) return;
    const pageId = i - 1;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (paneW / base.width) * state.zoom });
    const vw = viewport.width, vh = viewport.height;

    const block = el("div", "page-block");
    block.style.width = `${vw}px`;
    const label = el("div", "page-label",
      `Page ${i} · PDF ${Math.round(base.width)}×${Math.round(base.height)}pt · viewport ${Math.round(vw)}×${Math.round(vh)}px @ ${Math.round(state.zoom * 100)}%`);
    const wrap = el("div", "page");
    wrap.style.width = `${vw}px`;
    wrap.style.height = `${vh}px`;
    block.append(label, wrap);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    const overlay = el("div", "overlay");
    overlay.style.width = `${vw}px`;
    overlay.style.height = `${vh}px`;
    wrap.append(canvas, overlay);

    // Aspect-ratio check: saved page image vs PDF viewport (catches /Rotate or CropBox != MediaBox cases)
    const d = dims[pageId];
    if (i === 1 && d && d.img_width_px) {
      setLive(`This document: page image ${d.img_width_px}×${d.img_height_px}px (aspect ${(d.img_width_px / d.img_height_px).toFixed(3)}) `
        + `vs PDF page ${Math.round(base.width)}×${Math.round(base.height)}pt (aspect ${(base.width / base.height).toFixed(3)}). `
        + `Viewport ${Math.round(vw)}×${Math.round(vh)}px, so a box at rel_x0 = 0.5 is drawn at x = ${Math.round(0.5 * vw)}px.`);
    }
    if (d && d.img_width_px && d.img_height_px) {
      const diff = Math.abs(d.img_width_px / d.img_height_px - vw / vh) / (vw / vh);
      if (diff > 0.01) {
        wrap.appendChild(el("span", "warn", `Aspect mismatch ${(diff * 100).toFixed(1)}%: check rotation/crop`));
        console.warn(`Page ${i}: image/viewport aspect differs by ${(diff * 100).toFixed(2)}%`);
      }
    }
    pagesEl.appendChild(block);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    placeBoxes(overlay, pageId, (b) => ({
      l: b.rel_x0 * vw, t: b.rel_y0 * vh, w: (b.rel_x1 - b.rel_x0) * vw, h: (b.rel_y1 - b.rel_y0) * vh,
    }));
  }
  status("");
}

// ---------- Tab 3: upload & process in the app (REST APIs), rendered with the Option 1 technique ----------
const TAB3_STEPS = [
  ["upload", "Save PDF to UC volume"],
  ["parse", "ai_parse_document – REST API"],
  ["extract", "ai_extract with citations – REST API"],
  ["normalize", "Read page image sizes & normalize bboxes"],
  ["write", "Write results to UC tables"],
];
const tab3 = { file: null, job: null, docId: null, busy: false };
const tab3Layouts = [];

function renderUploadTab() {
  state.renderToken++; // cancel any in-flight PDF render
  pagesEl.innerHTML = "";
  tab3Layouts.length = 0;

  const panel = el("div", "upload-panel");
  panel.innerHTML = `
    <div class="dropzone" id="dropzone">
      <input type="file" id="fileInput" accept="application/pdf,.pdf" hidden />
      <div class="dz-text"><b>Drop a PDF here</b> or <button type="button" class="linkbtn" id="browseBtn">browse</button></div>
      <div class="dz-hint">Saved to the source volume, then processed by the app (max 20 MB)</div>
      <div class="dz-file" id="dzFile"></div>
    </div>
    <div class="upload-actions"><button type="button" class="primary" id="processBtn">Upload &amp; process</button>
      <span class="job-summary" id="jobSummary"></span></div>
    <ol class="steps-track" id="stepsTrack"></ol>
    <details class="api-io" id="apiIo"><summary>REST API calls made by the app (request / trimmed response)</summary><div id="apiBody"></div></details>`;
  pagesEl.appendChild(panel);
  const result = el("div", "tab3-result");
  pagesEl.appendChild(result);

  const input = $("fileInput"), dz = $("dropzone");
  const pick = (f) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { status("Please choose a PDF file"); setTimeout(() => status(""), 2500); return; }
    tab3.file = f;
    updateTab3Panel();
  };
  $("browseBtn").addEventListener("click", () => input.click());
  dz.addEventListener("click", (e) => { if (e.target === dz) input.click(); });
  input.addEventListener("change", () => pick(input.files[0]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));
  $("processBtn").addEventListener("click", startTab3Job);

  updateTab3Panel();
  renderTab3Result(result);
}

function updateTab3Panel() {
  if (state.tab !== "upload" || !$("stepsTrack")) return;
  $("dzFile").textContent = tab3.file ? `Selected: ${tab3.file.name} (${(tab3.file.size / 1024).toFixed(1)} KB)` : "";
  $("processBtn").disabled = !tab3.file || tab3.busy;
  $("processBtn").textContent = tab3.busy ? "Processing…" : "Upload & process";

  const job = tab3.job;
  const steps = job ? job.steps : TAB3_STEPS.map(([key, label]) => ({ key, label, status: "pending", seconds: null, detail: "" }));
  const track = $("stepsTrack");
  track.innerHTML = "";
  for (const s of steps) {
    const li = el("li", `step ${s.status}`);
    li.appendChild(el("span", "step-icon", { pending: "○", running: "◔", done: "✓", error: "✕" }[s.status] || "○"));
    const body = el("div", "step-body");
    const head = el("div", "step-head", s.label);
    if (s.seconds != null) head.appendChild(el("span", "step-time", `${s.seconds}s`));
    body.appendChild(head);
    if (s.detail) body.appendChild(el("div", "step-detail", s.detail));
    li.appendChild(body);
    track.appendChild(li);
  }
  $("jobSummary").textContent = !job ? "" : job.status === "done" ? `Done in ${job.seconds}s · ${job.file}`
    : job.status === "error" ? `Failed after ${job.seconds ?? "?"}s` : `Processing ${job.file}…`;

  const apiBody = $("apiBody");
  apiBody.innerHTML = "";
  const calls = job ? Object.values(job.api || {}) : [];
  if (!calls.length) apiBody.appendChild(el("p", "hint", "Calls appear here once processing starts."));
  for (const c of calls) {
    apiBody.appendChild(el("div", "api-endpoint", c.endpoint));
    apiBody.appendChild(el("div", "api-label", "Request"));
    apiBody.appendChild(el("pre", "api-json", JSON.stringify(c.request, null, 2)));
    apiBody.appendChild(el("div", "api-label", "Response (trimmed)"));
    apiBody.appendChild(el("pre", "api-json", JSON.stringify(c.response, null, 2)));
  }
}

async function startTab3Job() {
  if (!tab3.file || tab3.busy) return;
  tab3.busy = true;
  tab3.job = null;
  tab3.docId = null;
  updateTab3Panel();
  try {
    const fd = new FormData();
    fd.append("file", tab3.file);
    const r = await fetch("/api/tab3/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const { job_id } = await r.json();
    while (true) {
      await new Promise((res) => setTimeout(res, 1000));
      tab3.job = await api(`/api/tab3/jobs/${job_id}`);
      updateTab3Panel();
      if (tab3.job.status !== "running") break;
    }
    if (tab3.job.status === "done") {
      tab3.docId = tab3.job.doc_id;
      await refreshDocList(tab3.docId);
      await selectDoc(tab3.docId); // loads pages + citations from UC tables and re-renders this tab
    }
  } catch (e) {
    console.error(e);
    status(`Error: ${e.message}`);
  } finally {
    tab3.busy = false;
    updateTab3Panel();
  }
}

async function refreshDocList(selectId) {
  state.docs = await api("/api/documents");
  const sel = $("docSelect");
  sel.innerHTML = "";
  for (const d of state.docs) {
    const o = el("option", null, d.name);
    o.value = d.doc_id;
    sel.appendChild(o);
  }
  if (selectId) sel.value = selectId;
}

// Same display technique as Option 1: pixel bboxes scaled by displayed/natural image width
function renderTab3Result(container) {
  if (!tab3.docId || state.docId !== tab3.docId) {
    container.appendChild(el("p", "hint", tab3.docId
      ? "Select the uploaded document in the Document menu to view its result here."
      : "Upload a PDF to see the extracted fields drawn on the rendered page images."));
    return;
  }
  const name = state.docs.find((d) => d.doc_id === tab3.docId)?.name || "";
  container.appendChild(el("h3", "result-title", `Result: ${name}, read back from UC tables`));
  for (const p of state.pages) {
    const block = el("div", "page-block img-mode");
    const label = el("div", "page-label", `Page ${p.page_id + 1} · image ${p.img_width_px}×${p.img_height_px}px`);
    const wrap = el("div", "page");
    const img = new Image();
    img.alt = `Page ${p.page_id + 1}`;
    const overlay = el("div", "overlay");
    wrap.append(img, overlay);
    block.append(label, wrap);
    container.appendChild(block);
    const layout = () => {
      if (!img.naturalWidth) return;
      const s = img.clientWidth / img.naturalWidth;
      label.textContent = `Page ${p.page_id + 1} · image ${img.naturalWidth}×${img.naturalHeight}px · displayed at ${img.clientWidth}px (s = ${s.toFixed(3)})`;
      if (p.page_id === state.pages[0].page_id && tab3.job) {
        setLive(`Processed in the app in ${tab3.job.seconds}s: `
          + tab3.job.steps.map((st) => `${st.key} ${st.seconds}s`).join(" · ")
          + `. Page image ${img.naturalWidth}×${img.naturalHeight}px shown at s = ${s.toFixed(3)}.`);
      }
      overlay.style.width = `${img.clientWidth}px`;
      overlay.style.height = `${img.clientHeight}px`;
      placeBoxes(overlay, p.page_id, (b) => ({ l: b.x0 * s, t: b.y0 * s, w: (b.x1 - b.x0) * s, h: (b.y1 - b.y0) * s }));
    };
    img.onload = layout;
    tab3Layouts.push(layout);
    img.src = `/api/documents/${state.docId}/pages/${p.page_id}/image`;
  }
}
window.addEventListener("resize", () => {
  if (state.tab === "upload") tab3Layouts.forEach((f) => f());
});

// ---------- Tab 4: Option 3 workflow (upload + REST APIs) rendered with the Option 2 technique (PDF.js + normalized bboxes) ----------
const tab4 = { file: null, job: null, docId: null, busy: false };

async function renderUploadPdfTab() {
  const token = ++state.renderToken; // cancel any in-flight PDF render
  pagesEl.innerHTML = "";

  const panel = el("div", "upload-panel");
  panel.innerHTML = `
    <div class="dropzone" id="t4Dropzone">
      <input type="file" id="t4FileInput" accept="application/pdf,.pdf" hidden />
      <div class="dz-text"><b>Drop a PDF here</b> or <button type="button" class="linkbtn" id="t4BrowseBtn">browse</button></div>
      <div class="dz-hint">Saved to the source volume, processed by the app, then rendered with PDF.js (max 20 MB)</div>
      <div class="dz-file" id="t4DzFile"></div>
    </div>
    <div class="upload-actions"><button type="button" class="primary" id="t4ProcessBtn">Upload &amp; process</button>
      <span class="job-summary" id="t4JobSummary"></span></div>
    <ol class="steps-track" id="t4StepsTrack"></ol>
    <details class="api-io"><summary>REST API calls made by the app (request / trimmed response)</summary><div id="t4ApiBody"></div></details>`;
  pagesEl.appendChild(panel);
  const result = el("div", "tab3-result");
  pagesEl.appendChild(result);

  const input = $("t4FileInput"), dz = $("t4Dropzone");
  const pick = (f) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { status("Please choose a PDF file"); setTimeout(() => status(""), 2500); return; }
    tab4.file = f;
    updateTab4Panel();
  };
  $("t4BrowseBtn").addEventListener("click", () => input.click());
  dz.addEventListener("click", (e) => { if (e.target === dz) input.click(); });
  input.addEventListener("change", () => pick(input.files[0]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));
  $("t4ProcessBtn").addEventListener("click", startTab4Job);

  updateTab4Panel();
  await renderTab4Result(result, token);
}

function updateTab4Panel() {
  if (state.tab !== "upload_pdf" || !$("t4StepsTrack")) return;
  $("t4DzFile").textContent = tab4.file ? `Selected: ${tab4.file.name} (${(tab4.file.size / 1024).toFixed(1)} KB)` : "";
  $("t4ProcessBtn").disabled = !tab4.file || tab4.busy;
  $("t4ProcessBtn").textContent = tab4.busy ? "Processing…" : "Upload & process";

  const job = tab4.job;
  const steps = job ? job.steps : TAB3_STEPS.map(([key, label]) => ({ key, label, status: "pending", seconds: null, detail: "" }));
  const track = $("t4StepsTrack");
  track.innerHTML = "";
  for (const s of steps) {
    const li = el("li", `step ${s.status}`);
    li.appendChild(el("span", "step-icon", { pending: "○", running: "◔", done: "✓", error: "✕" }[s.status] || "○"));
    const body = el("div", "step-body");
    const head = el("div", "step-head", s.label);
    if (s.seconds != null) head.appendChild(el("span", "step-time", `${s.seconds}s`));
    body.appendChild(head);
    if (s.detail) body.appendChild(el("div", "step-detail", s.detail));
    li.appendChild(body);
    track.appendChild(li);
  }
  $("t4JobSummary").textContent = !job ? "" : job.status === "done" ? `Done in ${job.seconds}s · ${job.file}`
    : job.status === "error" ? `Failed after ${job.seconds ?? "?"}s` : `Processing ${job.file}…`;

  const apiBody = $("t4ApiBody");
  apiBody.innerHTML = "";
  const calls = job ? Object.values(job.api || {}) : [];
  if (!calls.length) apiBody.appendChild(el("p", "hint", "Calls appear here once processing starts."));
  for (const c of calls) {
    apiBody.appendChild(el("div", "api-endpoint", c.endpoint));
    apiBody.appendChild(el("div", "api-label", "Request"));
    apiBody.appendChild(el("pre", "api-json", JSON.stringify(c.request, null, 2)));
    apiBody.appendChild(el("div", "api-label", "Response (trimmed)"));
    apiBody.appendChild(el("pre", "api-json", JSON.stringify(c.response, null, 2)));
  }
}

async function startTab4Job() {
  if (!tab4.file || tab4.busy) return;
  tab4.busy = true;
  tab4.job = null;
  tab4.docId = null;
  updateTab4Panel();
  try {
    const fd = new FormData();
    fd.append("file", tab4.file);
    const r = await fetch("/api/tab3/upload", { method: "POST", body: fd }); // same backend workflow as Option 3
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const { job_id } = await r.json();
    while (true) {
      await new Promise((res) => setTimeout(res, 1000));
      tab4.job = await api(`/api/tab3/jobs/${job_id}`);
      updateTab4Panel();
      if (tab4.job.status !== "running") break;
    }
    if (tab4.job.status === "done") {
      tab4.docId = tab4.job.doc_id;
      delete state.pdfCache[tab4.docId]; // a re-upload with the same name must not reuse a cached PDF
      await refreshDocList(tab4.docId);
      await selectDoc(tab4.docId); // loads pages + citations from UC tables and re-renders this tab
    }
  } catch (e) {
    console.error(e);
    status(`Error: ${e.message}`);
  } finally {
    tab4.busy = false;
    updateTab4Panel();
  }
}

// Same display technique as Option 2: normalized bboxes scaled to the PDF.js viewport
async function renderTab4Result(container, token) {
  if (!tab4.docId || state.docId !== tab4.docId) {
    container.appendChild(el("p", "hint", tab4.docId
      ? "Select the uploaded document in the Document menu to view its result here."
      : "Upload a PDF to see the extracted fields drawn on the original PDF with normalized coordinates."));
    return;
  }
  const name = state.docs.find((d) => d.doc_id === tab4.docId)?.name || "";
  container.appendChild(el("h3", "result-title", `Result: ${name}, read back from UC tables and drawn on the original PDF`));
  status("Loading PDF…");
  const lib = await loadPdfJs();
  if (!state.pdfCache[state.docId]) {
    state.pdfCache[state.docId] = lib.getDocument({ url: `/api/documents/${state.docId}/pdf` }).promise;
  }
  const pdf = await state.pdfCache[state.docId];
  if (token !== state.renderToken) return;
  const dims = Object.fromEntries(state.pages.map((p) => [p.page_id, p]));
  const paneW = Math.min($("docPane").clientWidth - 48, 900);
  const dpr = window.devicePixelRatio || 1;

  for (let i = 1; i <= pdf.numPages; i++) {
    if (token !== state.renderToken) return;
    const page = await pdf.getPage(i);
    if (token !== state.renderToken) return;
    const pageId = i - 1;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (paneW / base.width) * state.zoom });
    const vw = viewport.width, vh = viewport.height;

    const block = el("div", "page-block");
    block.style.width = `${vw}px`;
    const label = el("div", "page-label",
      `Page ${i} · PDF ${Math.round(base.width)}×${Math.round(base.height)}pt · viewport ${Math.round(vw)}×${Math.round(vh)}px @ ${Math.round(state.zoom * 100)}%`);
    const wrap = el("div", "page");
    wrap.style.width = `${vw}px`;
    wrap.style.height = `${vh}px`;
    block.append(label, wrap);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    const overlay = el("div", "overlay");
    overlay.style.width = `${vw}px`;
    overlay.style.height = `${vh}px`;
    wrap.append(canvas, overlay);

    const d = dims[pageId];
    if (i === 1 && d && d.img_width_px) {
      const timing = tab4.job ? `Processed in the app in ${tab4.job.seconds}s (${tab4.job.steps.map((st) => `${st.key} ${st.seconds}s`).join(" · ")}). ` : "";
      setLive(timing + `Page image ${d.img_width_px}×${d.img_height_px}px (aspect ${(d.img_width_px / d.img_height_px).toFixed(3)}) `
        + `vs PDF page ${Math.round(base.width)}×${Math.round(base.height)}pt (aspect ${(base.width / base.height).toFixed(3)}). `
        + `Viewport ${Math.round(vw)}×${Math.round(vh)}px, so a box at rel_x0 = 0.5 is drawn at x = ${Math.round(0.5 * vw)}px.`);
    }
    if (d && d.img_width_px && d.img_height_px) {
      const diff = Math.abs(d.img_width_px / d.img_height_px - vw / vh) / (vw / vh);
      if (diff > 0.01) {
        wrap.appendChild(el("span", "warn", `Aspect mismatch ${(diff * 100).toFixed(1)}%: check rotation/crop`));
        console.warn(`Page ${i}: image/viewport aspect differs by ${(diff * 100).toFixed(2)}%`);
      }
    }
    container.appendChild(block);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    placeBoxes(overlay, pageId, (b) => ({
      l: b.rel_x0 * vw, t: b.rel_y0 * vh, w: (b.rel_x1 - b.rel_x0) * vw, h: (b.rel_y1 - b.rel_y0) * vh,
    }));
  }
  status("");
}

// ---------- wiring ----------
async function render() {
  renderExplain();
  setLive("");
  $("zoomCtl").classList.toggle("hidden", state.tab !== "pdf" && state.tab !== "upload_pdf");
  try {
    if (state.tab === "img") renderImgTab();
    else if (state.tab === "upload") renderUploadTab();
    else if (state.tab === "upload_pdf") await renderUploadPdfTab();
    else await renderPdfTab();
  } catch (e) {
    console.error(e);
    status(`Error: ${e.message}`);
  }
}

async function selectDoc(docId) {
  state.docId = docId;
  status("Loading document…");
  const [pages, fields] = await Promise.all([
    api(`/api/documents/${docId}/pages`),
    api(`/api/documents/${docId}/citations`),
  ]);
  state.pages = pages;
  state.fields = fields;
  status("");
  renderCards();
  await render();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    state.tab = t.dataset.tab;
    render();
  })
);
$("zoom").addEventListener("change", (e) => {
  state.zoom = parseFloat(e.target.value);
  render();
});
$("docSelect").addEventListener("change", (e) => selectDoc(e.target.value));

(async function init() {
  try {
    status("Loading documents…");
    state.docs = await api("/api/documents");
    const sel = $("docSelect");
    for (const d of state.docs) {
      const o = el("option", null, d.name);
      o.value = d.doc_id;
      sel.appendChild(o);
    }
    if (state.docs.length) await selectDoc(state.docs[0].doc_id);
    else status("No documents found. Run the pipeline notebook first.");
  } catch (e) {
    console.error(e);
    status(`Error: ${e.message}`);
  }
})();
