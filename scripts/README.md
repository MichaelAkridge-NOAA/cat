# CAT Conversion Scripts

Batch conversion utilities for converting GCS-hosted GeoTIFFs to Cloud Optimized GeoTIFF (COG) format.

---

## Compression Options

| Profile | Type | Quality | Best for |
|---|---|---|---|
| `zstd` | Lossless | Perfect | RGB orthomosaics (default) |
| `lzw` | Lossless | Perfect | DEMs, single-band (default) |
| `deflate` | Lossless | Perfect | Alternative to lzw |
| `jpeg` | Lossy | Configurable (default 90) | Smallest file size |

Tile-serving speed is the same regardless of compression — the COG structure (tiled blocks + overviews) is what makes loading fast, not the compression type.

---

## convert_gcs_mos_to_cog.py

Batch convert orthomosaic GeoTIFFs from one GCS bucket/prefix to another.

**Default compression:** `zstd` (lossless)

### Basic usage

```bash
python -m cat.scripts.convert_gcs_mos_to_cog \
  --source-prefix gs://your-bucket/orthomosaic/2025 \
  --dest-prefix   gs://your-bucket/orthomosaic_cog/2025
```

### Dry run first (recommended)

```bash
python -m cat.scripts.convert_gcs_mos_to_cog \
  --source-prefix gs://your-bucket/orthomosaic/2025 \
  --dest-prefix   gs://your-bucket/orthomosaic_cog/2025 \
  --dry-run
```

### Lossless with parallel workers

```bash
python -m cat.scripts.convert_gcs_mos_to_cog \
  --source-prefix gs://your-bucket/orthomosaic/2025 \
  --dest-prefix   gs://your-bucket/orthomosaic_cog/2025 \
  --workers 4
```

### Near-lossless JPEG (smaller files)

```bash
python -m cat.scripts.convert_gcs_mos_to_cog \
  --source-prefix gs://your-bucket/orthomosaic/2025 \
  --dest-prefix   gs://your-bucket/orthomosaic_cog/2025 \
  --profile jpeg --quality 95
```
# TEST
### Pilot run — process only 3 files

```bash
python -m cat.scripts.convert_gcs_mos_to_cog \
  --source-prefix gs://bucket1/SFM02/StRS_Sites_02/2025/SE2503_MARI/AGR \
  --dest-prefix   gs://bucket2/PIFSC/ESD/ARP/_shared_sandbox/temp/2025 \
  --max-files 3 --dry-run --profile jpeg --quality 95 --pattern '*mos*.tif'
```

### Flat output — all files in one folder (no subdirectories)

```bash
python -m cat.scripts.convert_gcs_mos_to_cog \
  --source-prefix gs://your-bucket/orthomosaic/2025 \
  --dest-prefix   gs://your-bucket/orthomosaic_cog/2025 \
  --flat
```

### All options

| Flag | Default | Description |
|---|---|---|
| `--source-prefix` | *(required)* | Source GCS prefix |
| `--dest-prefix` | *(required)* | Destination GCS prefix |
| `--pattern` | `*mos*.tif` | Filename glob filter |
| `--suffix` | `_cog` | Appended to output filenames |
| `--workers` | `1` | Parallel download/convert/upload workers |
| `--max-files` | *(all)* | Limit to N files (useful for pilots) |
| `--profile` | auto | `jpeg\|lzw\|zstd\|deflate` |
| `--quality` | `90` | JPEG quality 1–100 (JPEG only) |
| `--resampling` | `bilinear` | Overview resampling method |
| `--nodata` | auto | Nodata value for single-band rasters |
| `--dry-run` | false | Plan only, no downloads or uploads |
| `--overwrite` | false | Overwrite existing destination files |
| `--keep-temp` | false | Keep local temp files for debugging |
| `--no-reproject` | false | Skip auto reprojection to EPSG:4326 |
| `--flat` | false | Drop subdirectory structure — place all output files directly in dest-prefix |
| `--report-file` | auto | JSON report output path |

---

## convert_gcs_dem_to_cog.py

Batch convert DEM GeoTIFFs from one GCS bucket/prefix to another.

**Default compression:** `lzw` (lossless, best for single-band elevation data)

### Basic usage

```bash
python -m cat.scripts.convert_gcs_dem_to_cog \
  --source-prefix gs://your-bucket/dem/2025 \
  --dest-prefix   gs://your-bucket/dem_cog/2025
```

### Dry run first (recommended)

```bash
python -m cat.scripts.convert_gcs_dem_to_cog \
  --source-prefix gs://your-bucket/dem/2025 \
  --dest-prefix   gs://your-bucket/dem_cog/2025 \
  --dry-run
```

### With nodata value

```bash
python -m cat.scripts.convert_gcs_dem_to_cog \
  --source-prefix gs://your-bucket/dem/2025 \
  --dest-prefix   gs://your-bucket/dem_cog/2025 \
  --nodata -9999
```

### Lossless zstd (better compression than lzw)

```bash
python -m cat.scripts.convert_gcs_dem_to_cog \
  --source-prefix gs://your-bucket/dem/2025 \
  --dest-prefix   gs://your-bucket/dem_cog/2025 \
  --profile zstd
```

### Parallel workers with custom pattern

```bash
python -m cat.scripts.convert_gcs_dem_to_cog \
  --source-prefix gs://your-bucket/dem/2025 \
  --dest-prefix   gs://your-bucket/dem_cog/2025 \
  --pattern "*dsm*.tif" \
  --workers 4
```

### All options

| Flag | Default | Description |
|---|---|---|
| `--source-prefix` | *(see script)* | Source GCS prefix |
| `--dest-prefix` | *(see script)* | Destination GCS prefix |
| `--pattern` | `*dem*.tif` | Filename glob filter |
| `--suffix` | `_cog` | Appended to output filenames |
| `--workers` | `1` | Parallel workers |
| `--max-files` | *(all)* | Limit to N files |
| `--profile` | `lzw` | `jpeg\|lzw\|zstd\|deflate` |
| `--quality` | `90` | JPEG quality 1–100 (JPEG only) |
| `--resampling` | `bilinear` | Overview resampling method |
| `--nodata` | auto | Nodata override |
| `--dry-run` | false | Plan only |
| `--overwrite` | false | Overwrite existing destination files |
| `--keep-temp` | false | Keep local temp files |
| `--no-reproject` | false | Skip auto reprojection to EPSG:4326 |
| `--report-file` | auto | JSON report output path |

---

## Single file conversion (make_cog.py)

For converting a single local GeoTIFF:

```bash
# Lossless (default)
python -m cat.scripts.make_cog \
  --src input.tif \
  --dst output_cog.tif

# Near-lossless JPEG
python -m cat.scripts.make_cog \
  --src input.tif \
  --dst output_cog.tif \
  --profile jpeg --quality 95

# DEM with nodata
python -m cat.scripts.make_cog \
  --src dem.tif \
  --dst dem_cog.tif \
  --nodata -9999
```

---

## Prerequisites

- Python 3.9+
- `rasterio`, `rio-cogeo` Python packages
- Google Cloud SDK (`gsutil`) installed and authenticated:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```
