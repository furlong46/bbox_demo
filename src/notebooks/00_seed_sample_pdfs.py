# Databricks notebook source
# DBTITLE 1,Overview
# MAGIC %md
# MAGIC # Seed sample PDFs
# MAGIC
# MAGIC Copies the sample invoice PDFs that ship with the bundle (`src/sample_pdfs`) into the `pdfs` UC volume, so `01_bbox_demo_pipeline` has something to parse.
# MAGIC
# MAGIC * Existing files with the same name are overwritten. Other files in the volume (for example, Option 3/4 uploads) are left alone.

# COMMAND ----------

# DBTITLE 1,Parameters
dbutils.widgets.text("sample_pdf_dir", "")
dbutils.widgets.text("source_volume", "")

SAMPLE_PDF_DIR = dbutils.widgets.get("sample_pdf_dir").rstrip("/")
SOURCE_VOLUME = dbutils.widgets.get("source_volume").rstrip("/")
assert SAMPLE_PDF_DIR and SOURCE_VOLUME, "Both sample_pdf_dir and source_volume are required"
print(SAMPLE_PDF_DIR, "->", SOURCE_VOLUME)

# COMMAND ----------

# DBTITLE 1,Copy PDFs into the volume
import os
import shutil

pdfs = sorted(f for f in os.listdir(SAMPLE_PDF_DIR) if f.lower().endswith(".pdf"))
assert pdfs, f"No PDFs found in {SAMPLE_PDF_DIR}"

for name in pdfs:
    shutil.copyfile(os.path.join(SAMPLE_PDF_DIR, name), os.path.join(SOURCE_VOLUME, name))
    print("copied", name)

display(dbutils.fs.ls(SOURCE_VOLUME))
