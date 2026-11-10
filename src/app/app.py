"""AI Parse Document bbox citation demo: FastAPI backend.

Serves document metadata and citations from Unity Catalog tables (via SQL warehouse) and
streams the original PDFs and saved page images from UC volumes (via the Files API).
"""
import hashlib
import io
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from databricks import sql
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

CATALOG = os.getenv("BBOX_CATALOG", "pdf_app_demo")
SCHEMA = os.getenv("BBOX_SCHEMA", "doc_intell_schema")
WAREHOUSE_ID = os.getenv("DATABRICKS_WAREHOUSE_ID")
PAGES_T = f"`{CATALOG}`.`{SCHEMA}`.bbox_demo_pages"
CITES_T = f"`{CATALOG}`.`{SCHEMA}`.bbox_demo_citations"

cfg = Config()
w = WorkspaceClient()
app = FastAPI(title="bbox citation demo")
STATIC = Path(__file__).parent / "static"


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    """Force browsers to revalidate the page and its JS/CSS so a redeploy is picked up immediately."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def query(stmt: str, params: dict | None = None) -> list[dict]:
    with sql.connect(
        server_hostname=cfg.host,
        http_path=f"/sql/1.0/warehouses/{WAREHOUSE_ID}",
        credentials_provider=lambda: cfg.authenticate,
    ) as conn, conn.cursor() as cur:
        cur.execute(stmt, params or {})
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def doc_id_for(path: str) -> str:
    return hashlib.sha1(path.encode()).hexdigest()[:16]


_docs_cache: dict = {"ts": 0.0, "docs": {}}


def known_docs() -> dict[str, str]:
    """Map opaque doc_id -> volume path. Only paths present in the tables can be served."""
    if time.time() - _docs_cache["ts"] > 60 or not _docs_cache["docs"]:
        rows = query(f"SELECT DISTINCT path FROM {PAGES_T} ORDER BY path")
        _docs_cache["docs"] = {doc_id_for(r["path"]): r["path"] for r in rows}
        _docs_cache["ts"] = time.time()
    return _docs_cache["docs"]


def resolve(doc_id: str) -> str:
    path = known_docs().get(doc_id)
    if not path:
        raise HTTPException(404, "Unknown document")
    return path


def download(volume_path: str) -> bytes:
    return w.files.download(volume_path).contents.read()


@app.get("/api/documents")
def documents():
    return [{"doc_id": d, "name": p.rsplit("/", 1)[-1]} for d, p in known_docs().items()]


@app.get("/api/documents/{doc_id}/pages")
def pages(doc_id: str):
    path = resolve(doc_id)
    rows = query(
        f"SELECT page_id, img_width_px, img_height_px FROM {PAGES_T} WHERE path = :p ORDER BY page_id",
        {"p": path},
    )
    return rows


@app.get("/api/documents/{doc_id}/citations")
def citations(doc_id: str):
    path = resolve(doc_id)
    rows = query(
        f"""SELECT field_name, field_value, color, citation_id, page_id, x0, y0, x1, y1,
                   rel_x0, rel_y0, rel_x1, rel_y1
            FROM {CITES_T} WHERE path = :p ORDER BY field_name, citation_id, page_id""",
        {"p": path},
    )
    fields: dict[str, dict] = {}
    for r in rows:
        f = fields.setdefault(
            r["field_name"],
            {"field_name": r["field_name"], "value": r["field_value"], "color": r["color"], "boxes": []},
        )
        if r["x0"] is not None:
            f["boxes"].append({k: r[k] for k in ("citation_id", "page_id", "x0", "y0", "x1", "y1",
                                                 "rel_x0", "rel_y0", "rel_x1", "rel_y1")})
    return list(fields.values())


@app.get("/api/documents/{doc_id}/pdf")
def pdf(doc_id: str):
    return Response(download(resolve(doc_id)), media_type="application/pdf")


@app.get("/api/documents/{doc_id}/pages/{page_id}/image")
def page_image(doc_id: str, page_id: int):
    path = resolve(doc_id)
    rows = query(f"SELECT image_uri FROM {PAGES_T} WHERE path = :p AND page_id = :i", {"p": path, "i": page_id})
    if not rows or not rows[0]["image_uri"]:
        raise HTTPException(404, "No page image")
    uri = rows[0]["image_uri"]
    media = "image/png" if uri.lower().endswith(".png") else "image/jpeg"
    return Response(download(uri), media_type=media, headers={"Cache-Control": "max-age=3600"})


@app.get("/api/health")
def health():
    return {"ok": True, "catalog": CATALOG, "schema": SCHEMA}


# =====================================================================================
# Tab 3: upload a PDF and process it entirely in the app via the AI Functions REST API
#   POST /api/2.0/ai-functions/ai-parse-document  -> OCR/layout + rendered page images
#   POST /api/2.0/ai-functions/ai-extract         -> fields + bbox citations
# Then the app reads page-image sizes, normalizes bboxes and writes the same UC tables
# the notebook writes (bbox_demo_parsed / _extracted / _pages / _citations).
# =====================================================================================
from PIL import Image  # noqa: E402

SOURCE_VOLUME = os.getenv("BBOX_SOURCE_VOLUME", f"/Volumes/{CATALOG}/{SCHEMA}/pdfs").rstrip("/")
IMAGE_VOLUME = os.getenv("BBOX_IMAGE_VOLUME", f"/Volumes/{CATALOG}/{SCHEMA}/bbox_demo_page_images").rstrip("/")
PARSED_T = f"`{CATALOG}`.`{SCHEMA}`.bbox_demo_parsed"
EXTRACTED_T = f"`{CATALOG}`.`{SCHEMA}`.bbox_demo_extracted"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
PALETTE = ["#1f77b4", "#e6194b", "#3cb44b", "#911eb4", "#f58231", "#42d4f4", "#f032e6", "#bfef45", "#469990"]

# Same extraction schema as the pipeline notebook
EXTRACTION_SCHEMA = {
    "invoice_id": {"type": "string", "description": "Invoice number"},
    "po_number": {"type": "string", "description": "Purchase order number"},
    "invoice_date": {"type": "string", "description": "Issue date, YYYY-MM-DD"},
    "due_date": {"type": "string", "description": "Due date, YYYY-MM-DD"},
    "payment_terms": {"type": "string"},
    "vendor_name": {"type": "string"},
    "buyer_name": {"type": "string"},
    "subtotal": {"type": "number"},
    "total_amount": {"type": "number"},
}

STEP_DEFS = [
    ("upload", "Save PDF to UC volume"),
    ("parse", "ai_parse_document – REST API"),
    ("extract", "ai_extract with citations – REST API"),
    ("normalize", "Read page image sizes & normalize bboxes"),
    ("write", "Write results to UC tables"),
]
JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


def execute(statements: list[tuple[str, dict]]) -> None:
    """Run write statements on the SQL warehouse in one session."""
    with sql.connect(
        server_hostname=cfg.host,
        http_path=f"/sql/1.0/warehouses/{WAREHOUSE_ID}",
        credentials_provider=lambda: cfg.authenticate,
    ) as conn, conn.cursor() as cur:
        for stmt, params in statements:
            cur.execute(stmt, params)


def _leaves(node, prefix=""):
    """Yield (dot_path, value, citation_ids) for every leaf field (same logic as the notebook)."""
    if isinstance(node, dict) and "value" in node and set(node) <= {"value", "citation_ids", "confidence"}:
        v = node.get("value")
        if isinstance(v, (dict, list)):
            yield from _leaves(v, prefix)
        else:
            yield prefix, v, node.get("citation_ids") or []
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _leaves(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _leaves(v, f"{prefix}[{i}]")


def _fmt(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _safe_name(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(name or "upload.pdf").name).strip(" .") or "upload"
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    return base[-120:]


def _trim_parse(parsed: dict) -> dict:
    doc = parsed.get("document") or {}
    els = doc.get("elements") or []
    return {
        "document": {"pages": doc.get("pages"), "elements": els[:2] + ([f"… {len(els) - 2} more elements"] if len(els) > 2 else [])},
        "error_status": parsed.get("error_status"),
        "metadata": parsed.get("metadata"),
    }


def _trim_extract(ext: dict) -> dict:
    md = dict(ext.get("metadata") or {})
    cits = md.get("citations") or []
    md["citations"] = cits[:4] + ([f"… {len(cits) - 4} more citations"] if len(cits) > 4 else [])
    return {"response": ext.get("response"), "metadata": md}


def _run_job(job_id: str, filename: str, data: bytes) -> None:
    job = JOBS[job_id]
    steps = {s["key"]: s for s in job["steps"]}
    t_all = time.time()

    def run(key, fn):
        s = steps[key]
        s["status"] = "running"
        t = time.time()
        try:
            out = fn(s)
            s["status"] = "done"
            return out
        except Exception as e:  # surface the failure to the UI
            s["status"] = "error"
            s["detail"] = f"{type(e).__name__}: {e}"[:800]
            raise
        finally:
            s["seconds"] = round(time.time() - t, 1)

    path = f"{SOURCE_VOLUME}/{filename}"
    try:
        # 1. Save the upload to the source volume (same place the notebook reads from)
        def do_upload(s):
            w.files.upload(path, io.BytesIO(data), overwrite=True)
            s["detail"] = f"{len(data) / 1024:.1f} KB → {path}"
        run("upload", do_upload)

        # 2. OCR / layout via REST. image_output_path makes the service save rendered page images.
        def do_parse(s):
            body = {"content": path,
                    "options": {"version": "2.0", "image_output_path": IMAGE_VOLUME + "/",
                                "description_element_types": "*"}}
            parsed = w.api_client.do("POST", "/api/2.0/ai-functions/ai-parse-document", body=body)
            job["api"]["parse"] = {"endpoint": "POST /api/2.0/ai-functions/ai-parse-document",
                                   "request": body, "response": _trim_parse(parsed)}
            doc = parsed.get("document") or {}
            if not doc.get("pages"):
                raise RuntimeError(f"Parse returned no pages: {parsed.get('error_status')}")
            errs = parsed.get("error_status") or []
            s["detail"] = (f"{len(doc['pages'])} page(s), {len(doc.get('elements') or [])} elements"
                           + (f" · {len(errs)} page error(s)" if errs else ""))
            return parsed
        parsed = run("parse", do_parse)

        # 3. Field extraction with bbox citations via REST, fed the parse response directly
        def do_extract(s):
            body = {"content": parsed, "schema": EXTRACTION_SCHEMA,
                    "options": {"version": "2.1", "enable_citations": True}}
            ext = w.api_client.do("POST", "/api/2.0/ai-functions/ai-extract", body=body)
            job["api"]["extract"] = {"endpoint": "POST /api/2.0/ai-functions/ai-extract",
                                     "request": {**body, "content": "<ai-parse-document response from step 2>"},
                                     "response": _trim_extract(ext)}
            n_f = sum(1 for _ in _leaves(ext.get("response") or {}))
            n_c = len((ext.get("metadata") or {}).get("citations") or [])
            s["detail"] = f"{n_f} fields, {n_c} citations"
            return ext
        ext = run("extract", do_extract)

        # 4. Page pixel dims from the saved image header (never from DPI), then normalize bboxes
        def do_normalize(s):
            pages = (ext.get("metadata") or {}).get("pages") or (parsed.get("document") or {}).get("pages") or []
            dims, page_rows = {}, []
            for p in pages:
                wpx = hpx = None
                if p.get("image_uri"):
                    with Image.open(io.BytesIO(download(p["image_uri"]))) as im:
                        wpx, hpx = im.size
                dims[p["id"]] = (wpx, hpx)
                page_rows.append({"path": path, "page_id": int(p["id"]), "image_uri": p.get("image_uri"),
                                  "img_width_px": wpx, "img_height_px": hpx})
            cits = {c["id"]: c.get("bbox") or [] for c in (ext.get("metadata") or {}).get("citations") or []}
            leaves = sorted(_leaves(ext.get("response") or {}), key=lambda x: x[0])  # stable colors, like the notebook
            cit_rows = []
            for idx, (fname, val, cids) in enumerate(leaves):
                color = PALETTE[idx % len(PALETTE)]
                base = {"path": path, "field_name": fname, "field_value": _fmt(val), "color": color}
                boxes = [(cid, b) for cid in cids for b in cits.get(cid, [])]
                if val is None or not boxes:
                    cit_rows.append({**base, "citation_id": None, "page_id": None})
                    continue
                for cid, b in boxes:
                    x0, y0, x1, y1 = b["coord"]
                    wpx, hpx = dims.get(b["page_id"], (None, None))
                    rel = dict(rel_x0=x0 / wpx, rel_y0=y0 / hpx, rel_x1=x1 / wpx, rel_y1=y1 / hpx) if wpx and hpx else {}
                    cit_rows.append({**base, "citation_id": int(cid), "page_id": int(b["page_id"]),
                                     "x0": x0, "y0": y0, "x1": x1, "y1": y1, **rel})
            s["detail"] = "; ".join(f"page {k}: {v[0]}×{v[1]} px" for k, v in dims.items()) + f" · {len(cit_rows)} box rows"
            return page_rows, cit_rows
        page_rows, cit_rows = run("normalize", do_normalize)

        # 5. Replace this document's rows in the shared UC tables
        def do_write(s):
            p = {"p": path}
            execute([
                (f"DELETE FROM {PARSED_T} WHERE path = :p", p),
                (f"INSERT INTO {PARSED_T} (path, parsed) VALUES (:p, parse_json(:j))", {**p, "j": json.dumps(parsed)}),
                (f"DELETE FROM {EXTRACTED_T} WHERE path = :p", p),
                (f"INSERT INTO {EXTRACTED_T} (path, extracted) VALUES (:p, parse_json(:j))", {**p, "j": json.dumps(ext)}),
                (f"DELETE FROM {PAGES_T} WHERE path = :p", p),
                (f"""INSERT INTO {PAGES_T} SELECT r.path, r.page_id, r.image_uri, r.img_width_px, r.img_height_px
                     FROM (SELECT explode(from_json(:j, 'array<struct<path:string,page_id:int,image_uri:string,
                           img_width_px:int,img_height_px:int>>')) AS r)""", {"j": json.dumps(page_rows)}),
                (f"DELETE FROM {CITES_T} WHERE path = :p", p),
                (f"""INSERT INTO {CITES_T} SELECT r.path, r.field_name, r.field_value, r.citation_id, r.page_id,
                       r.x0, r.y0, r.x1, r.y1, r.rel_x0, r.rel_y0, r.rel_x1, r.rel_y1, r.color
                     FROM (SELECT explode(from_json(:j, 'array<struct<path:string,field_name:string,field_value:string,
                           citation_id:int,page_id:int,x0:int,y0:int,x1:int,y1:int,rel_x0:double,rel_y0:double,
                           rel_x1:double,rel_y1:double,color:string>>')) AS r)""", {"j": json.dumps(cit_rows)}),
            ])
            s["detail"] = f"bbox_demo_parsed, bbox_demo_extracted, bbox_demo_pages ({len(page_rows)}), bbox_demo_citations ({len(cit_rows)})"
        run("write", do_write)

        _docs_cache["ts"] = 0.0  # make the new document visible immediately
        job.update(status="done", doc_id=doc_id_for(path), path=path)
    except Exception:
        job["status"] = "error"
    finally:
        job["seconds"] = round(time.time() - t_all, 1)


@app.post("/api/tab3/upload")
async def tab3_upload(file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 20 MB)")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "Only PDF files are supported")
    name = _safe_name(file.filename)
    job_id = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        JOBS[job_id] = {"job_id": job_id, "file": name, "status": "running", "doc_id": None, "api": {},
                        "steps": [{"key": k, "label": l, "status": "pending", "seconds": None, "detail": ""}
                                  for k, l in STEP_DEFS]}
        for old in list(JOBS)[:-50]:  # keep memory bounded
            JOBS.pop(old, None)
    threading.Thread(target=_run_job, args=(job_id, name, data), daemon=True).start()
    return {"job_id": job_id, "file": name}


@app.get("/api/tab3/jobs/{job_id}")
def tab3_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return job


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
