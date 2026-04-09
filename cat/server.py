from contextlib import asynccontextmanager
from dotenv import load_dotenv
load_dotenv()  # load .env from project root (or any parent directory)

import os
# Allow rasterio/GDAL to read public GCS buckets without credentials
os.environ.setdefault("GS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff")

import hashlib
import re
import rasterio
from rasterio.crs import CRS as RioCRS
import xml.etree.ElementTree as ET

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from titiler.core.factory import TilerFactory
from starlette.middleware.cors import CORSMiddleware
from pathlib import Path
from typing import List, Optional, Dict
from datetime import datetime
import os
import tempfile
import shutil
import subprocess
import logging
import warnings

# Import coral species API
from cat.api.coral_species import router as coral_router

# Import file-based project API
from cat.api.file_projects import router as file_projects_router

# Import sites reference API
from cat.api.sites import router as sites_router

# Import Oracle DB project API (optional backend)
try:
    from cat.api.db_projects import router as db_projects_router
    DB_API_AVAILABLE = True
except Exception as e:
    print(f"⚠️ Failed to import DB projects API: {e}")
    DB_API_AVAILABLE = False

try:
    from cat.db.config import get_database_settings
except Exception:
    get_database_settings = None

try:
    from cat.db.schema import bootstrap_schema
except Exception:
    bootstrap_schema = None

# =============================================================================
# Warning Suppression Configuration
# =============================================================================
# Set to False to see TileMatrix warnings when zooming beyond standard levels
SUPPRESS_TILEMATRIX_WARNINGS = True

if SUPPRESS_TILEMATRIX_WARNINGS:
    warnings.filterwarnings(
        'ignore',
        message='TileMatrix not found for level.*',
        category=UserWarning,
        module='morecantile.models'
    )

# =============================================================================
# HARDCODED CONFIGURATION - No config files needed!
# =============================================================================

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Package directory - where this file lives (contains web/, docs/, etc.)
BASE_DIR = Path(__file__).parent

# User data directory - where COG files and projects are stored
USER_DATA_DIR = Path.home() / ".cat"
USER_DATA_DIR.mkdir(exist_ok=True)

# Data directory for COG files
DATA_DIR = USER_DATA_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# VRT cache directory for LOCAL_CS COG CRS overrides
VRT_CACHE_DIR = USER_DATA_DIR / "vrt_cache"
VRT_CACHE_DIR.mkdir(exist_ok=True)


# =============================================================================
# LOCAL_CS  →  VRT override helpers
# =============================================================================

def _gdal_path(uri: str) -> str:
    """Convert gs:// URI to /vsigs/ path for GDAL."""
    if uri.startswith("gs://"):
        return "/vsigs/" + uri[5:]
    return uri


def _vrt_cache_key(cog_url: str) -> str:
    """Deterministic cache key for a COG URL."""
    return hashlib.sha256(cog_url.encode()).hexdigest()[:16]


def _is_local_cs(crs_wkt: str) -> bool:
    return bool(crs_wkt and re.search(r"LOCAL_CS", crs_wkt, re.IGNORECASE))


def _build_vrt_xml(src_path: str, width: int, height: int,
                    geotransform: tuple, band_count: int,
                    dtype: str, nodata=None) -> str:
    """
    Build a VRT XML string that wraps *src_path* but assigns EPSG:4326
    instead of the original LOCAL_CS.
    """
    root = ET.Element("VRTDataset", rasterXSize=str(width), rasterYSize=str(height))
    ET.SubElement(root, "SRS").text = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]'
    ET.SubElement(root, "GeoTransform").text = ", ".join(str(v) for v in geotransform)

    dtype_map = {
        "uint8": "Byte", "int8": "Int16", "uint16": "UInt16",
        "int16": "Int16", "uint32": "UInt32", "int32": "Int32",
        "float32": "Float32", "float64": "Float64",
    }
    gdal_dtype = dtype_map.get(dtype, "Byte")

    for band_idx in range(1, band_count + 1):
        band_el = ET.SubElement(root, "VRTRasterBand",
                                dataType=gdal_dtype, band=str(band_idx))
        if nodata is not None:
            ET.SubElement(band_el, "NoDataValue").text = str(nodata)
        source = ET.SubElement(band_el, "SimpleSource")
        ET.SubElement(source, "SourceFilename", relativeToVRT="0").text = src_path
        ET.SubElement(source, "SourceBand").text = str(band_idx)
        src_rect = ET.SubElement(source, "SrcRect",
                                 xOff="0", yOff="0",
                                 xSize=str(width), ySize=str(height))
        dst_rect = ET.SubElement(source, "DstRect",
                                 xOff="0", yOff="0",
                                 xSize=str(width), ySize=str(height))

    return ET.tostring(root, encoding="unicode", xml_declaration=True)


def ensure_local_cs_vrt(cog_url: str) -> Optional[str]:
    """
    If *cog_url* has a LOCAL_CS CRS, create (or return cached) a VRT file
    that wraps it with EPSG:4326.  Returns the local VRT path, or None if
    the COG already has a proper CRS.
    """
    key = _vrt_cache_key(cog_url)
    vrt_path = VRT_CACHE_DIR / f"{key}.vrt"

    # Return cached VRT if it exists
    if vrt_path.exists():
        return str(vrt_path)

    gdal_p = _gdal_path(cog_url)
    env = rasterio.Env(
        GS_NO_SIGN_REQUEST="YES",
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff,.geotiff",
    )

    try:
        with env:
            with rasterio.open(gdal_p) as src:
                crs_wkt = src.crs.to_wkt() if src.crs else ""
                if not _is_local_cs(crs_wkt):
                    return None  # proper CRS, no VRT needed

                logger.info("LOCAL_CS detected for %s — generating VRT override", cog_url)

                gt = src.transform
                geotransform = (gt.c, gt.a, gt.b, gt.f, gt.d, gt.e)
                nodata = src.nodata

                xml = _build_vrt_xml(
                    src_path=gdal_p,
                    width=src.width,
                    height=src.height,
                    geotransform=geotransform,
                    band_count=src.count,
                    dtype=src.dtypes[0],
                    nodata=nodata,
                )

        vrt_path.write_text(xml, encoding="utf-8")
        logger.info("VRT written: %s", vrt_path)
        return str(vrt_path)

    except Exception as exc:
        logger.warning("Failed to create VRT for %s: %s", cog_url, exc)
        return None

# Hardcoded configuration
CONFIG = {
    'server': {
        'host': '0.0.0.0',
        'port': 8000,
        'reload': False
    },
    'data': {
        'directory': str(DATA_DIR),
        'pattern': '*cog*.tif',
        'include_extensions': ['.tif', '.tiff']
    },
    'cors': {
        'enabled': True,
        'origins': ['*'],
        'allow_credentials': True,
        'allow_methods': ['*'],
        'allow_headers': ['*']
    },
    'viewer': {
        'title': 'CAT: Coral Annotation Tool',
        'default_opacity': 1.0,
        'max_zoom': 2000,
        'show_scale': True,
        'background_color': '#2c2c2c'
    },
    'titiler': {
        'tile_size': 256,
        'max_threads': 10
    }
}

logger.info(f"Package directory: {BASE_DIR}")
logger.info(f"User data directory: {USER_DATA_DIR}")
logger.info(f"Data directory: {DATA_DIR}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ---- startup ----
    if DB_API_AVAILABLE and get_database_settings is not None and bootstrap_schema is not None:
        try:
            db_settings = get_database_settings()
            if db_settings.storage_backend == "oracle" and db_settings.auto_bootstrap:
                logger.info("Oracle auto-bootstrap enabled: ensuring CAT tables exist...")
                result = bootstrap_schema()
                tables = result.get("tables", []) if isinstance(result, dict) else []
                logger.info("Oracle schema bootstrap complete. tables=%s", ",".join(tables))
                try:
                    from cat.db.sites import count_db_sites, seed_sites_from_csv
                    seed_result = seed_sites_from_csv()
                    logger.info(
                        "Site reference data seeded (upsert): %d sites, %d visits.",
                        seed_result["sites_seeded"],
                        seed_result["visits_seeded"],
                    )
                except Exception as seed_exc:
                    logger.warning("Site auto-seed failed (non-fatal): %s", seed_exc)
        except Exception as exc:
            logger.exception("Oracle schema auto-bootstrap failed: %s", exc)
    yield
    # ---- shutdown (nothing needed) ----


app = FastAPI(title=CONFIG['viewer']['title'], lifespan=lifespan)

# Include coral species routes
app.include_router(coral_router)

# Include sites reference routes
app.include_router(sites_router)
print("âœ… Sites reference API enabled at /api/sites/*")

# Include file-based project routes
app.include_router(file_projects_router)
print("âœ… File-based project API enabled at /api/file-projects/*")

# Include DB project routes
if DB_API_AVAILABLE:
    app.include_router(db_projects_router)
    print("âœ… DB project API enabled at /api/db/*")
else:
    print("â„¹ï¸ DB project API not available")



# Add CORS middleware if enabled
if CONFIG['cors']['enabled']:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CONFIG['cors']['origins'],
        allow_credentials=CONFIG['cors']['allow_credentials'],
        allow_methods=CONFIG['cors']['allow_methods'],
        allow_headers=CONFIG['cors']['allow_headers'],
    )

# Middleware to prepend data directory to TiTiler URL parameters
@app.middleware("http")
async def prepend_data_path_middleware(request: Request, call_next):
    """
    Middleware to automatically prepend 'data/' to file paths in TiTiler requests.
    This allows frontends to pass just filenames while TiTiler gets full paths.
    Also handles absolute Windows paths (C:\\\\...) from file-based projects.
    """
    if request.url.path.startswith(('/tiles/', '/info', '/bounds', '/statistics', '/preview')):
        # Get the 'url' query parameter
        url_param = request.query_params.get('url')
        if url_param:
            from urllib.parse import unquote
            decoded_url = unquote(url_param)
            # Check if it's an absolute path
            is_absolute = (
                decoded_url.startswith('/') or  # Unix absolute path
                (len(decoded_url) > 2 and decoded_url[1] == ':')  # Windows absolute path
            )
            # Check if it's a URL or already has data/ prefix
            is_url = decoded_url.startswith(('http://', 'https://'))
            has_data_prefix = decoded_url.startswith('data/')
            # Only prepend data directory if it's not absolute and not a URL
            if not is_absolute and not is_url and not has_data_prefix:
                data_dir = CONFIG['data']['directory']
                new_url = f"{data_dir}/{url_param}"
                query_params = dict(request.query_params)
                query_params['url'] = new_url
                from urllib.parse import urlencode
                new_query_string = urlencode(query_params).encode()
                scope = request.scope.copy()
                scope['query_string'] = new_query_string
                from starlette.requests import Request as StarletteRequest
                request = StarletteRequest(scope, request.receive)
    response = await call_next(request)
    return response

# Create a TilerFactory for Cloud-Optimized GeoTIFFs
# Pass GDAL settings via environment_dependency so they are active inside
# every rasterio.Env() context that titiler creates per-request.
_GCS_GDAL_ENV = {
    "GS_NO_SIGN_REQUEST": "YES",               # read public GCS buckets without credentials
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff,.geotiff",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_VERSION": "2",
}

cog = TilerFactory(environment_dependency=lambda: _GCS_GDAL_ENV)

# Register all the COG endpoints automatically
app.include_router(cog.router, tags=["Cloud Optimized GeoTIFF"])

# Mount static files (for any CSS, JS, images, etc.)
# This allows serving files from the data directory
data_directory = CONFIG['data']['directory']
# Create data directory if it doesn't exist
Path(data_directory).mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=data_directory), name="static")

# Mount web directory for JS, CSS, and other web assets
web_directory = str(BASE_DIR / "web")
app.mount("/js", StaticFiles(directory=str(Path(web_directory) / "js")), name="js")
app.mount("/css", StaticFiles(directory=str(Path(web_directory) / "css")), name="css")

# Health check endpoint for Docker/Kubernetes
@app.get("/health")
def health_check():
    """Simple health check endpoint for container orchestration."""
    return {"status": "healthy", "service": "cat"}


# API endpoint to list available COG files in the data directory
@app.get("/api/cog-files")
def list_cog_files():
    data_dir = Path(CONFIG['data']['directory'])
    if not data_dir.exists():
        return {"files": []}

    # Find all files matching the configured extensions
    cog_files = []
    extensions = CONFIG['data']['include_extensions']
    pattern_keyword = "cog"  # Look for 'cog' in filename

    for ext in extensions:
        for file in data_dir.glob(f"*{ext}"):
            if pattern_keyword in file.name.lower():
                # Return just filename - frontend/database will handle path prefixing
                cog_files.append(str(file.name))

    return {"files": sorted(cog_files)}

# API endpoint to get configuration
@app.get("/api/config")
def get_config():
    """Return viewer configuration for client"""
    storage_backend = "file"
    if get_database_settings is not None:
        try:
            storage_backend = get_database_settings().storage_backend
        except Exception:
            storage_backend = "file"

    return {
        "viewer": CONFIG['viewer'],
        "data_directory": CONFIG['data']['directory'],
        "storage_backend": storage_backend,
        "db_api_available": DB_API_AVAILABLE,
    }


# ---------- LOCAL_CS CRS check & VRT override endpoint ----------
@app.get("/api/check-cog-crs")
def check_cog_crs(url: str = Query(..., description="COG URL (gs:// or /vsigs/)")):
    """
    Inspect a COG's CRS.  If it is LOCAL_CS, create a cached VRT that
    assigns EPSG:4326 so TiTiler can serve tiles.

    Returns { crs, is_local_cs, vrt_path, bounds_native }.
    The frontend should use *vrt_path* for all TiTiler tile/info requests
    when is_local_cs is true.
    """
    gdal_p = _gdal_path(url)
    env = rasterio.Env(
        GS_NO_SIGN_REQUEST="YES",
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff,.geotiff",
    )
    try:
        with env:
            with rasterio.open(gdal_p) as src:
                crs_wkt = src.crs.to_wkt() if src.crs else ""
                is_local = _is_local_cs(crs_wkt)
                bounds = list(src.bounds)  # [left, bottom, right, top]

        vrt_path = None
        if is_local:
            vrt_path = ensure_local_cs_vrt(url)

        return {
            "url": url,
            "crs": crs_wkt[:120] + ("…" if len(crs_wkt) > 120 else ""),
            "is_local_cs": is_local,
            "vrt_path": vrt_path,
            "bounds_native": bounds,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"CRS check failed: {exc}")


# Debug endpoint to check file existence
@app.get("/api/debug/file-exists")
def check_file_exists(path: str):
    """Debug: Check if a file exists and return its absolute path"""
    import os
    file_path = Path(path)
    abs_path = file_path.resolve()

    return {
        "input_path": path,
        "absolute_path": str(abs_path),
        "exists": file_path.exists(),
        "is_file": file_path.is_file() if file_path.exists() else False,
        "cwd": os.getcwd(),
        "data_dir_exists": Path(CONFIG['data']['directory']).exists(),
        "data_dir_contents": [str(f.name) for f in Path(CONFIG['data']['directory']).glob('*')] if Path(CONFIG['data']['directory']).exists() else []
    }

# Serve the landing page at root
@app.get("/", response_class=HTMLResponse)
def read_index():
    index_file = BASE_DIR / "web" / "index.html"
    if index_file.exists():
        return index_file.read_text(encoding="utf-8")
    return "<h1>Welcome to CAT: Coral Annotation Tool</h1>"

# Serve the logos from docs folder
@app.get("/logo.png")
def read_logo():
    logo_file = BASE_DIR / "docs" / "logo.png"
    if logo_file.exists():
        return FileResponse(logo_file, media_type="image/png")
    raise HTTPException(status_code=404, detail="Logo not found")

@app.get("/logo2.png")
def read_logo2():
    logo_file = BASE_DIR / "docs" / "logo2.png"
    if logo_file.exists():
        return FileResponse(logo_file, media_type="image/png")
    raise HTTPException(status_code=404, detail="Logo2 not found")

@app.get("/logo_banner.png")
def read_logo_banner():
    logo_file = BASE_DIR / "docs" / "logo_banner.png"
    if logo_file.exists():
        return FileResponse(logo_file, media_type="image/png")
    raise HTTPException(status_code=404, detail="Logo banner not found")

@app.get("/logo_wide.png")
def read_logo_wide():
    logo_file = BASE_DIR / "docs" / "logo_wide.png"
    if logo_file.exists():
        return FileResponse(logo_file, media_type="image/png")
    raise HTTPException(status_code=404, detail="Logo wide not found")

# Serve the viewer page
@app.get("/viewer", response_class=HTMLResponse)
def read_viewer():
    viewer_file = BASE_DIR / "web" / "viewer.html"
    if viewer_file.exists():
        return viewer_file.read_text(encoding="utf-8")
    return "<h1>Viewer not found</h1>"

# Serve the converter page
@app.get("/converter", response_class=HTMLResponse)
def read_converter():
    converter_file = BASE_DIR / "web" / "converter.html"
    if converter_file.exists():
        return converter_file.read_text(encoding="utf-8")
    return "<h1>Converter not found</h1>"

# Serve the annotation page
@app.get("/annotate", response_class=HTMLResponse)
def read_file_annotation():
    file_annotation_file = BASE_DIR / "web" / "annotation.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>Annotation not found</h1>"

# Serve the annotation page (canonical URL)
@app.get("/annotation.html", response_class=HTMLResponse)
def read_annotation_page():
    file_annotation_file = BASE_DIR / "web" / "annotation.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>Annotation not found</h1>"

# Backward-compat redirect for old /annotation_file_mode.html URLs
@app.get("/annotation_file_mode.html", response_class=HTMLResponse)
def read_file_annotation_alt():
    file_annotation_file = BASE_DIR / "web" / "annotation.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>Annotation not found</h1>"

# Serve the deprecated refactored annotation page
@app.get("/annotation_file_mode_REFACTORED.html", response_class=HTMLResponse)
def read_file_annotation_refactored():
    file_annotation_file = BASE_DIR / "web" / "deprecated" / "annotation_file_mode_REFACTORED.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>Refactored Annotation not found</h1>"

# Serve the unified annotation page (v2 features merged into v1)
@app.get("/annotate/v2", response_class=HTMLResponse)
def read_annotation_v2():
    file_annotation_file = BASE_DIR / "web" / "annotation.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>Annotation not found</h1>"

# Backward-compat redirect for old /annotation_v2.html URLs
@app.get("/annotation_v2.html", response_class=HTMLResponse)
def read_annotation_v2_alt():
    file_annotation_file = BASE_DIR / "web" / "annotation.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>Annotation not found</h1>"

# Serve the project creator page
@app.get("/project_creator.html", response_class=HTMLResponse)
def read_project_creator():
    creator_file = BASE_DIR / "web" / "project_creator.html"
    if creator_file.exists():
        return creator_file.read_text(encoding="utf-8")
    return "<h1>Project Creator not found</h1>"

# API endpoint for COG conversion
@app.post("/api/convert")
async def convert_to_cog(
    file: UploadFile = File(...),
    resampling: str = Form("bilinear"),
    compression: str = Form("auto"),
    output_name: str = Form(None),
    nodata: str = Form(None)
):
    """Convert uploaded GeoTIFF to COG format"""

    # Validate file type
    if not file.filename.lower().endswith(('.tif', '.tiff')):
        raise HTTPException(status_code=400, detail="Only .tif and .tiff files are supported")

    # Create temp directory for processing
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_dir_path = Path(temp_dir)

        # Save uploaded file
        input_path = temp_dir_path / file.filename
        with open(input_path, 'wb') as f:
            shutil.copyfileobj(file.file, f)

        # Generate output filename
        if output_name:
            if not output_name.lower().endswith(('.tif', '.tiff')):
                output_name += '.tif'
        else:
            # Auto-generate with _cog suffix
            stem = Path(file.filename).stem
            output_name = f"{stem}_cog.tif"

        # Ensure output goes to data directory
        output_dir = Path(CONFIG['data']['directory'])
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / output_name

        # Get the path to the script in the package
        script_path = Path(__file__).parent / 'scripts' / 'make_cog.py'

        # Build conversion command
        cmd = [
            'python', str(script_path),
            '--src', str(input_path),
            '--dst', str(output_path),
            '--resampling', resampling
        ]

        # Add compression if not auto
        if compression != 'auto':
            cmd.extend(['--profile', compression])

        # Add nodata value if provided (for DEMs)
        if nodata:
            try:
                cmd.extend(['--nodata', str(float(nodata))])
            except ValueError:
                pass  # Invalid nodata value, skip it

        try:
            # Run conversion
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )

            if result.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"Conversion failed: {result.stderr}"
                )

            # Check if output file was created
            if not output_path.exists():
                raise HTTPException(
                    status_code=500,
                    detail="Conversion completed but output file not found"
                )

            # Parse output for reprojection info
            conversion_log = result.stdout
            reprojected = "Reprojecting to EPSG:4326" in conversion_log

            return JSONResponse({
                "success": True,
                "output_file": output_name,
                "message": "Conversion successful" + (" (reprojected to WGS84)" if reprojected else ""),
                "size_mb": round(output_path.stat().st_size / (1024 * 1024), 2),
                "reprojected_to_wgs84": reprojected,
                "log": conversion_log
            })

        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=500, detail="Conversion timeout (file too large)")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Conversion error: {str(e)}")

# Run the application
if __name__ == "__main__":
    import uvicorn

    host = CONFIG['server'].get('host', '0.0.0.0')
    port = CONFIG['server'].get('port', 8000)
    reload = CONFIG['server'].get('reload', False)

    print(f"\n\U0001f41f Starting CAT: Coral Annotation Tool")
    print(f"\U0001f4cc Server: http://{host if host != '0.0.0.0' else 'localhost'}:{port}")
    print(f"\U0001f9b8 Coral Annotation: http://localhost:{port}/annotate")
    print(f"\U0001f9ea v2 Dev Preview:   http://localhost:{port}/annotate/v2")
    print(f"\U0001f4c1 Project Creator: http://localhost:{port}/project_creator.html")
    print(f"\u2699\ufe0f  COG Converter: http://localhost:{port}/converter")
    print(f"\U0001f4da API Docs: http://localhost:{port}/docs")
    print(f"\n{'='*60}\n")

    uvicorn.run(
        "cat.server:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info"
    )
