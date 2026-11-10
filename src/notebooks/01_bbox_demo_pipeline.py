# Databricks notebook source
# DBTITLE 1,Overview
# MAGIC %md
# MAGIC # AI Parse Document bounding-box demo: pipeline
# MAGIC
# MAGIC This notebook parses the PDFs in a UC volume with `ai_parse_document` and pulls out invoice fields with `ai_extract`, keeping a bbox citation for each field. It then normalizes those bboxes to 0–1 page coordinates for the Databricks App.
# MAGIC
# MAGIC * **Coordinate space**: bbox coordinates are pixels on the *rendered page image* that `imageOutputPath` writes. The image's own width and height are the denominator. The notebook never derives size from PDF points × DPI.
# MAGIC * **Output tables** (all prefixed `bbox_demo_`): `bbox_demo_parsed`, `bbox_demo_extracted`, `bbox_demo_pages`, `bbox_demo_citations`.
# MAGIC * Safe to re-run: every table is created with CREATE OR REPLACE or overwritten.

# COMMAND ----------

# DBTITLE 1,Parameters
dbutils.widgets.text("catalog", "pdf_app_demo")
dbutils.widgets.text("schema", "doc_intell_schema")
dbutils.widgets.text("source_volume", "/Volumes/pdf_app_demo/doc_intell_schema/pdfs/")
dbutils.widgets.text("image_volume_path", "/Volumes/pdf_app_demo/doc_intell_schema/bbox_demo_page_images/")

CATALOG = dbutils.widgets.get("catalog")
SCHEMA = dbutils.widgets.get("schema")
SOURCE_VOLUME = dbutils.widgets.get("source_volume")
IMAGE_VOLUME_PATH = dbutils.widgets.get("image_volume_path")
fq = lambda t: f"{CATALOG}.{SCHEMA}.{t}"
print(CATALOG, SCHEMA, SOURCE_VOLUME, IMAGE_VOLUME_PATH)

# COMMAND ----------

# DBTITLE 1,Task 1: parse PDFs with ai_parse_document
# imageOutputPath saves the rendered page images; their pixel space is the bbox coordinate space.
spark.sql(f"""
CREATE OR REPLACE TABLE {fq('bbox_demo_parsed')} AS
SELECT
  regexp_replace(path, '^dbfs:', '') AS path,
  ai_parse_document(
    content,
    map('version', '2.0',
        'imageOutputPath', '{IMAGE_VOLUME_PATH}',
        'descriptionElementTypes', '*')
  ) AS parsed
FROM READ_FILES('{SOURCE_VOLUME}', format => 'binaryFile', pathGlobFilter => '*.pdf')
""")

parse_errors = spark.sql(f"SELECT path, parsed:error_status AS error_status FROM {fq('bbox_demo_parsed')} WHERE cast(parsed:error_status AS STRING) IS NOT NULL")  # cast turns VARIANT null into SQL NULL
display(spark.sql(f"SELECT path, size(cast(parsed:document:pages AS ARRAY<VARIANT>)) AS pages, size(cast(parsed:document:elements AS ARRAY<VARIANT>)) AS elements FROM {fq('bbox_demo_parsed')}"))
if parse_errors.count() > 0:
    display(parse_errors)
    print("WARNING: some documents failed to parse")

# COMMAND ----------

# DBTITLE 1,Task 2: extract fields with citations via ai_extract
EXTRACTION_SCHEMA = """{
  "invoice_id":     {"type":"string", "description":"Invoice number"},
  "po_number":      {"type":"string", "description":"Purchase order number"},
  "invoice_date":   {"type":"string", "description":"Issue date, YYYY-MM-DD"},
  "due_date":       {"type":"string", "description":"Due date, YYYY-MM-DD"},
  "payment_terms":  {"type":"string"},
  "vendor_name":    {"type":"string"},
  "buyer_name":     {"type":"string"},
  "subtotal":       {"type":"number"},
  "total_amount":   {"type":"number"}
}"""

spark.sql(f"""
CREATE OR REPLACE TABLE {fq('bbox_demo_extracted')} AS
SELECT
  path,
  ai_extract(parsed, '{EXTRACTION_SCHEMA}',
             options => map('version','2.1','enableCitations','true')) AS extracted
FROM {fq('bbox_demo_parsed')}
WHERE cast(parsed:error_status AS STRING) IS NULL
""")

extract_errors = spark.sql(f"SELECT path, extracted:error_message AS error_message FROM {fq('bbox_demo_extracted')} WHERE cast(extracted:error_message AS STRING) IS NOT NULL")
if extract_errors.count() > 0:
    display(extract_errors)
    print("WARNING: some documents failed extraction")
display(spark.sql(f"SELECT path, extracted:response FROM {fq('bbox_demo_extracted')}"))

# COMMAND ----------

# DBTITLE 1,Task 3: flatten citations and normalize bboxes
import json
from PIL import Image

PALETTE = ["#1f77b4","#e6194b","#3cb44b","#911eb4","#f58231","#42d4f4","#f032e6","#bfef45","#469990"]

def leaves(node, prefix=""):
    """Yield (dot_path, value, citation_ids) for every leaf field; handles nested objects and arrays."""
    if isinstance(node, dict) and "value" in node and set(node) <= {"value", "citation_ids"}:
        v = node.get("value")
        if isinstance(v, (dict, list)):
            yield from leaves(v, prefix)
        else:
            yield prefix, v, node.get("citation_ids") or []
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from leaves(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from leaves(v, f"{prefix}[{i}]")

rows = spark.sql(f"SELECT path, to_json(extracted) AS j FROM {fq('bbox_demo_extracted')} WHERE cast(extracted:error_message AS STRING) IS NULL").collect()

page_rows, cit_rows, field_order = [], [], []
for r in rows:
    d = json.loads(r.j)
    md = d.get("metadata") or {}

    # Page pixel dims come from the saved image itself (header read only), never from DPI.
    dims = {}
    for p in md.get("pages") or []:
        w = h = None
        if p.get("image_uri"):
            with Image.open(p["image_uri"]) as im:
                w, h = im.size
        dims[p["id"]] = (w, h)
        page_rows.append((r.path, int(p["id"]), p.get("image_uri"), w, h))

    cits = {c["id"]: c.get("bbox") or [] for c in md.get("citations") or []}
    for fname, val, cids in leaves(d.get("response") or {}):
        if fname not in field_order:
            field_order.append(fname)
        color = PALETTE[field_order.index(fname) % len(PALETTE)]
        sval = None if val is None else str(val)
        # A field may have many citation_ids, and a citation may have many bboxes (even on different pages)
        boxes = [(cid, b) for cid in cids for b in cits.get(cid, [])]
        if val is None or not boxes:
            cit_rows.append((r.path, fname, sval, None, None, None, None, None, None, None, None, None, None, color))
            continue
        for cid, b in boxes:
            x0, y0, x1, y1 = b["coord"]
            pid = b["page_id"]
            w, h = dims.get(pid, (None, None))
            rel = (x0 / w, y0 / h, x1 / w, y1 / h) if w and h else (None,) * 4
            cit_rows.append((r.path, fname, sval, int(cid), int(pid), x0, y0, x1, y1, *rel, color))

pages_df = spark.createDataFrame(page_rows, "path string, page_id int, image_uri string, img_width_px int, img_height_px int")
cit_df = spark.createDataFrame(cit_rows, "path string, field_name string, field_value string, citation_id int, page_id int, "
                               "x0 int, y0 int, x1 int, y1 int, rel_x0 double, rel_y0 double, rel_x1 double, rel_y1 double, color string")

pages_df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("bbox_demo_pages"))
cit_df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(fq("bbox_demo_citations"))
display(pages_df)
display(cit_df)

# COMMAND ----------

# DBTITLE 1,Validate outputs
counts = {t: spark.table(fq(t)).count() for t in ["bbox_demo_parsed", "bbox_demo_extracted", "bbox_demo_pages", "bbox_demo_citations"]}
print(counts)

missing = spark.sql(f"""
  SELECT path, field_name FROM {fq('bbox_demo_citations')}
  GROUP BY path, field_name
  HAVING max(field_value) IS NOT NULL AND count(x0) = 0
""")
bad_rel = spark.sql(f"""
  SELECT * FROM {fq('bbox_demo_citations')}
  WHERE rel_x0 IS NOT NULL AND (rel_x0 < 0 OR rel_y0 < 0 OR rel_x1 > 1 OR rel_y1 > 1 OR rel_x0 >= rel_x1 OR rel_y0 >= rel_y1)
""")
assert all(v > 0 for v in counts.values()), f"Empty table: {counts}"
print("Non-null fields without a box:", missing.count())
print("Boxes outside 0-1 or inverted:", bad_rel.count())
display(spark.sql(f"SELECT field_name, field_value, color, count(x0) AS boxes FROM {fq('bbox_demo_citations')} GROUP BY ALL ORDER BY field_name"))

# COMMAND ----------

