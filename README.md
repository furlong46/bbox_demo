# AI Parse Document – Bounding Box Citation Demo

This end-to-end demo runs **`ai_parse_document`** and **`ai_extract`** (with bbox citations) on invoice PDFs. It turns the returned pixel bounding boxes into page-relative (0–1) coordinates and renders the extracted fields as color-coded highlights in a **Databricks App**, using four different approaches (tabs).

**The core idea:** the bbox coordinates from both functions are **pixels on the rendered page image** that `ai_parse_document` writes when `imageOutputPath` / `image_output_path` is set. The response has no page width or height. The correct denominator for normalization is therefore the **actual pixel size of that saved image** (read from the image header). Never derive it from PDF points × an assumed DPI, because the render resolution is not a documented contract.

```
rel = [x0 / img_width, y0 / img_height, x1 / img_width, y1 / img_height]      # 0–1, top-left origin, y down
```

---

## 1. Solution inventory

### 1.1 Databricks App

| Item | Value |
| --- | --- |
| App name | `bbox-citation-demo` |
| URL | https://bbox-citation-demo-5343834423590926.6.azure.databricksapps.com |
| Framework | FastAPI (uvicorn) backend + static HTML/JS frontend; PDF.js 4.4.168 loaded from the jsDelivr CDN |
| Source code | `/Workspace/Users/leo.furlong@databricks.com/bbox_demo/app` |
| Service principal | `app-2vy12r bbox-citation-demo` (client id `fbae30cf-c0a4-4302-9b84-84d9116ef5a1`) |
| App resources | `sql-warehouse` → `bbox_demo_wh` (CAN_USE); `pdf-volume` → `pdfs` (READ_VOLUME); `image-volume` → `bbox_demo_page_images` (READ_VOLUME) |
| UC privileges for the SP | Currently **ALL PRIVILEGES on catalog `pdf_app_demo`**. Minimum needed: USE CATALOG, USE SCHEMA, SELECT + MODIFY on the 4 tables, READ VOLUME + WRITE VOLUME on both volumes (the write privileges are only needed for Options 3 and 4) |

**App source files**

| File | Purpose |
| --- | --- |
| `app/app.yaml` | Start command (`uvicorn app:app`); env: `DATABRICKS_WAREHOUSE_ID` (valueFrom `sql-warehouse`), `BBOX_CATALOG`, `BBOX_SCHEMA`. **In the bundle this lives in the `config:` block of `resources/bbox_citation_demo.app.yml`, not in `src/app/app.yaml`** |
| `app/requirements.txt` | `databricks-sql-connector`, `databricks-sdk`, `python-multipart`, `pillow` |
| `app/app.py` | Backend: document, page, citation, PDF and page-image endpoints; Option 3/4 upload + REST processing job; no-cache middleware for static files |
| `app/static/index.html` | Page shell, 4 tabs, explanation panel, field pane (assets are cache-busted with `?v=N`) |
| `app/static/app.js` | All frontend logic: field cards, box placement, and the 4 tab renderers |
| `app/static/style.css` | Styles |

**Backend API**

| Endpoint | Used by | What it does |
| --- | --- | --- |
| `GET /api/documents` | all tabs | Lists distinct documents in `bbox_demo_pages`. `doc_id` is the first 16 hex characters of sha1(path), and only paths in the table can be served |
| `GET /api/documents/{doc_id}/pages` | all tabs | `page_id, img_width_px, img_height_px` |
| `GET /api/documents/{doc_id}/citations` | all tabs | Fields with value, color, and boxes (pixel + relative coords) |
| `GET /api/documents/{doc_id}/pages/{page_id}/image` | Options 1, 3 | Streams the saved page image from `image_uri` (Files API) |
| `GET /api/documents/{doc_id}/pdf` | Options 2, 4 | Streams the original PDF from the `pdfs` volume (Files API) |
| `POST /api/tab3/upload` | Options 3, 4 | Accepts a PDF (max 20 MB, `%PDF` magic check) and starts a background processing job |
| `GET /api/tab3/jobs/{job_id}` | Options 3, 4 | Per-step status, timings, details and trimmed REST request/response |
| `GET /api/health` | – | Health check |

### 1.2 Notebook

| Notebook | Path | Purpose |
| --- | --- | --- |
| [01_bbox_demo_pipeline](#notebook-4229271970242221) | `/Workspace/Users/leo.furlong@databricks.com/bbox_demo/01_bbox_demo_pipeline` | Batch pipeline: parse → extract with citations → flatten + normalize → validate. Widgets: `catalog`, `schema`, `source_volume`, `image_volume_path`. Re-runnable (CREATE OR REPLACE / overwrite) |

Notebook cells: **Parameters** → **Task 1** `ai_parse_document` → **Task 2** `ai_extract` (version 2.1, enableCitations) → **Task 3** flatten + normalize (PIL reads the image size) → **Validate outputs** (row counts, every non-null field has ≥ 1 box, all rel coords within 0–1).

### 1.3 Unity Catalog objects (`pdf_app_demo.doc_intell_schema`)

**Tables** (all managed)

| Table | Grain | Columns | Written by |
| --- | --- | --- | --- |
| `bbox_demo_parsed` | 1 row per document | `path STRING, parsed VARIANT` (full `ai_parse_document` output) | Notebook Task 1, Options 3/4 |
| `bbox_demo_extracted` | 1 row per document | `path STRING, extracted VARIANT` (full `ai_extract` output incl. `metadata.citations`) | Notebook Task 2, Options 3/4 |
| `bbox_demo_pages` | 1 row per (path, page_id) | `path, page_id, image_uri, img_width_px, img_height_px` | Notebook Task 3, Options 3/4 |
| `bbox_demo_citations` | 1 row per (path, field, citation, bbox) | `path, field_name, field_value, citation_id, page_id, x0, y0, x1, y1, rel_x0, rel_y0, rel_x1, rel_y1, color` | Notebook Task 3, Options 3/4 |

Current contents: 4 documents, 4 pages and 36 citation rows.

**Volumes** (all managed)

| Volume | Purpose | Current files |
| --- | --- | --- |
| `pdfs` | Source PDFs (read by the notebook; Options 3/4 uploads land here) | `Synthetic Invoice.pdf` (3.1 KB), `Synthetic Invoice - Alternate Style _1_.pdf` (3.5 KB), `Synthetic Invoice - Drury Lane.pdf` (3.6 KB), `upload_test_invoice.pdf` (3.1 KB, a test copy of `Synthetic Invoice.pdf` that can be deleted) |
| `bbox_demo_page_images` | Page images rendered by `ai_parse_document` (`imageOutputPath`); file names are content hashes, so identical pages share one image | `ac092e7b….jpg` (164 KB), `b71c61a9….jpg` (163 KB), `37e6705e….jpg` (154 KB); each is 1700×2200 px for US Letter pages |

### 1.4 Compute

| Item | Value |
| --- | --- |
| SQL warehouse | `bbox_demo_wh` (id `3bf66a342e884131`), serverless PRO, 2X-Small, 1 cluster, auto-stop after 10 min. Used by the app for reads and Option 3/4 writes |
| Notebook compute | Serverless |
| App compute | Medium (default) |

---

## 2. The four tabs

All four tabs share the same right-hand **field pane**: one card per extracted field with its value, color and source count. Hovering a card highlights its boxes, and clicking it scrolls to and pulses the box. Boxes from several fields that cite the same element are inset by 4 px so each color stays visible. Citations point to whole parsed elements, such as the invoice-header table, so several fields often share one region.

### Option 1 – Page images (notebook-processed, pixel overlay)

* **Processing:** the [01_bbox_demo_pipeline](#notebook-4229271970242221) notebook (SQL `ai_parse_document` → SQL `ai_extract` → Python flatten/normalize) writes the 4 tables.
* **Display:** the browser shows the **saved page image** (`/api/documents/{id}/pages/{n}/image`). Each pixel bbox is scaled by the ratio of displayed width to natural width:
  `s = img.clientWidth / img.naturalWidth → left = x0·s, top = y0·s, width = (x1−x0)·s, height = (y1−y0)·s`
* **Why it's exact:** the image and the bboxes share one coordinate space, so no normalization is needed.
* **Trade-off:** it's a raster image (no text selection, blurry when zoomed) and needs larger files.
* **Code:** `renderImgTab()` in `app.js`; `page_image()` in `app.py`.

### Option 2 – PDF (normalized coordinates, PDF.js)

* **Processing:** the same notebook. Task 3 reads each page image's size with PIL and stores `rel_x0..rel_y1` in `bbox_demo_citations`.
* **Display:** PDF.js renders the **original PDF** (`/api/documents/{id}/pdf`) at any zoom (50–200%). Boxes are placed at `rel × viewport size`:
  `left = rel_x0·vw, top = rel_y0·vh, width = (rel_x1−rel_x0)·vw, height = (rel_y1−rel_y0)·vh`
* **No y-flip:** image space and the PDF.js viewport are both top-left origin, y down.
* **Geometry check:** a badge appears if the image and viewport aspect ratios differ by more than 1% (rotated pages or CropBox ≠ MediaBox).
* **Trade-off:** crisp, selectable original document, but the page image dimensions are still required at ingest.
* **Code:** `renderPdfTab()` in `app.js`; `pdf()` in `app.py`.

### Option 3 – Upload & process in the app (REST APIs, pixel overlay)

* **Processing (no notebook):** the app backend's `_run_job()` in `app.py` runs a 5-step background job:
  1. **Upload:** the PDF goes to the `pdfs` volume through `w.files.upload`.
  2. **Parse:** `POST /api/2.0/ai-functions/ai-parse-document` with `{content: <volume path>, options: {version: "2.0", image_output_path: <page-image volume>, description_element_types: "*"}}`.
  3. **Extract:** `POST /api/2.0/ai-functions/ai-extract` with `{content: <parse response>, schema: <invoice schema>, options: {version: "2.1", enable_citations: true}}`.
  4. **Normalize:** the app downloads each page image, reads its size with Pillow, and computes `rel_*` (same logic as the notebook).
  5. **Persist:** for that document's path, DELETE + INSERT into all 4 tables through the SQL warehouse (`parse_json` for VARIANT, `explode(from_json(...))` for row sets).
* **Display:** same technique as Option 1, using the saved page image plus a pixel overlay.
* **UI extras:** drag-and-drop upload, a live 5-step tracker with timings, and a collapsible panel with the actual REST requests and trimmed responses.
* **Typical timing:** about 30 s end to end (parse ~5 s, extract ~3–7 s; the write step depends on whether the warehouse is warm).
* **Code:** `renderUploadTab()`, `startTab3Job()`, `renderTab3Result()` in `app.js`; `tab3_upload()`, `_run_job()` in `app.py`.

### Option 4 – Upload & process in the app (REST APIs, normalized PDF.js overlay)

* **Processing:** identical to Option 3 (same `/api/tab3/upload` and `/api/tab3/jobs` endpoints and the same REST calls). The page images are still generated, because their size is the normalization denominator.
* **Display:** same technique as Option 2. PDF.js renders the uploaded original PDF and boxes are placed with `rel_*` from `bbox_demo_citations`; the zoom control and aspect-ratio check are included. After a job finishes, the cached PDF for that document is cleared so a re-upload under the same name shows the new file.
* **Code:** `renderUploadPdfTab()`, `startTab4Job()`, `renderTab4Result()` in `app.js`.

| | Option 1 | Option 2 | Option 3 | Option 4 |
| --- | --- | --- | --- | --- |
| Processing | Notebook (SQL AI functions) | Notebook (SQL AI functions) | App backend (REST AI Functions API) | App backend (REST AI Functions API) |
| Rendered surface | Saved page image | Original PDF (PDF.js) | Saved page image | Original PDF (PDF.js) |
| Coordinates used | Pixel `x0..y1` | Normalized `rel_*` | Pixel `x0..y1` | Normalized `rel_*` |
| Best for | Simplest exact overlay | Production PDF viewers | Interactive single-doc demo | Interactive + production-style viewer |

---

## 3. Deploying to another workspace

The recommended packaging is a **Declarative Automation Bundle** stored in a Git folder. It contains:

* `databricks.yml` with variables `catalog`, `schema` and `warehouse_id` (or a bundled warehouse), plus a target for the destination workspace.
* Resources for the **schema** and both **volumes** (with grants), the **pipeline job** wrapping `01_bbox_demo_pipeline` (serverless), and the **app** (`source_code_path: ../src/app`, with warehouse and volume resources).
* `src/notebooks/01_bbox_demo_pipeline`, `src/app/**`, and optionally `src/sample_pdfs/*.pdf` with a seed task that copies them into the `pdfs` volume.

Tables are created by the pipeline job, so they don't need to be bundle resources.

**Prerequisites in the target workspace**

* Unity Catalog and serverless compute (jobs, SQL warehouse, apps).
* AI Functions available in the region (`ai_parse_document`, `ai_extract` v2.1, and the `/api/2.0/ai-functions/*` REST endpoints for Options 3/4).
* Databricks Apps enabled. The app's browser must reach `cdn.jsdelivr.net` for PDF.js, or PDF.js must be vendored into `app/static`.
* A deployer with privileges to create the schema, volumes, job and app.

**After deploy:** run the pipeline job once, then grant the app's new service principal the UC privileges listed in section 1.1 (or declare them as grants in the bundle).

### 3.1 This repo's bundle

```
databricks.yml                                  # variables: catalog, schema, app_name, warehouse_name; targets: dev, prod
resources/
  bbox_demo.schema.yml                          # schema + grants (app SP: USE_SCHEMA, SELECT, MODIFY)
  pdfs.volume.yml                               # volume + grants (app SP: READ_VOLUME, WRITE_VOLUME)
  bbox_demo_page_images.volume.yml              # volume + grants (app SP: READ_VOLUME, WRITE_VOLUME)
  bbox_demo_wh.sql_warehouse.yml                # serverless PRO 2X-Small, 1 cluster, auto-stop 10 min
  bbox_demo_pipeline.job.yml                    # serverless job: seed_sample_pdfs -> bbox_demo_pipeline
  bbox_citation_demo.app.yml                    # app + config (command/env) + warehouse/volume resources
src/
  notebooks/00_seed_sample_pdfs.py              # copies src/sample_pdfs/*.pdf into the pdfs volume
  notebooks/01_bbox_demo_pipeline.py
  app/**
  sample_pdfs/*.pdf
```

* **`dev`** (default) targets the source workspace in development mode. The schema becomes `dev_<user>_doc_intell_schema`, and the job and warehouse names get a `[dev <user>]` prefix. The app is `bbox-citation-demo-dev`, so nothing collides with the hand-built assets.
* **`prod`**: set `workspace.host` (and the `catalog` variable if it differs) before deploying.
* The target catalog must already exist. The bundle does not create it, so it cannot grant `USE CATALOG` to the app's service principal. If the app gets permission errors, run `GRANT USE CATALOG ON CATALOG <catalog> TO \`<app SP client id>\``.

```bash
databricks bundle validate --strict -t dev
databricks bundle deploy -t dev
databricks bundle run bbox_demo_pipeline -t dev     # seed PDFs + build the 4 tables
databricks bundle run bbox_citation_demo -t dev     # start the app and deploy its source
```

---

## 4. Known notes

* VARIANT null is not SQL NULL. Filter errors with `cast(parsed:error_status AS STRING) IS NULL`.
* Re-running the notebook rebuilds all 4 tables from every PDF in `pdfs`, including files uploaded through Options 3/4.
* `upload_test_invoice.pdf` was left behind by testing and can be removed (its rows from all 4 tables plus the PDF). Keep the page image `ac092e7b….jpg`, which `Synthetic Invoice.pdf` also uses.
* Parse output can vary by a few pixels between runs, which is expected service behavior.
