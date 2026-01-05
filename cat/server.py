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

app = FastAPI(title=CONFIG['viewer']['title'])

# Include coral species routes
app.include_router(coral_router)

# Include file-based project routes
app.include_router(file_projects_router)
print("✅ File-based project API enabled at /api/file-projects/*")

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
    Also handles absolute Windows paths (C:\\...) from file-based projects.
    """
    if request.url.path.startswith(('/tiles/', '/info', '/bounds', '/statistics', '/preview')):
        # Get the 'url' query parameter
        url_param = request.query_params.get('url')
        if url_param:
            # Check if it's an absolute path (Windows: C:\ or Unix: /)
            # After URL decoding, Windows paths will have C:\, D:\, etc.
            from urllib.parse import unquote
            decoded_url = unquote(url_param)
            
            # Check if it's an absolute path
            is_absolute = (
                decoded_url.startswith('/') or  # Unix absolute path
                (len(decoded_url) > 2 and decoded_url[1] == ':')  # Windows absolute path (C:, D:, etc.)
            )
            
            # Check if it's a URL or already has data/ prefix
            is_url = decoded_url.startswith(('http://', 'https://'))
            has_data_prefix = decoded_url.startswith('data/')
            
            # Only prepend data directory if it's not absolute and not a URL
            if not is_absolute and not is_url and not has_data_prefix:
                # Prepend data directory
                data_dir = CONFIG['data']['directory']
                new_url = f"{data_dir}/{url_param}"
                
                # Rebuild query parameters with updated url
                query_params = dict(request.query_params)
                query_params['url'] = new_url
                
                # Create new scope with updated query string
                from urllib.parse import urlencode
                new_query_string = urlencode(query_params).encode()
                
                scope = request.scope.copy()
                scope['query_string'] = new_query_string
                
                # Create new request with updated scope
                from starlette.requests import Request as StarletteRequest
                request = StarletteRequest(scope, request.receive)
    
    response = await call_next(request)
    return response

# Create a TilerFactory for Cloud-Optimized GeoTIFFs
cog = TilerFactory()

# Register all the COG endpoints automatically
app.include_router(cog.router, tags=["Cloud Optimized GeoTIFF"])

# Mount static files (for any CSS, JS, images, etc.)
# This allows serving files from the data directory
data_directory = CONFIG['data']['directory']
# Create data directory if it doesn't exist
Path(data_directory).mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=data_directory), name="static")

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
    return {
        "viewer": CONFIG['viewer'],
        "data_directory": CONFIG['data']['directory']
    }

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

# Serve the file-based annotation page
@app.get("/annotate", response_class=HTMLResponse)
def read_file_annotation():
    file_annotation_file = BASE_DIR / "web" / "annotation_file_mode.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>File-Based Annotation not found</h1>"

# Serve the file-based annotation page
@app.get("/annotation_file_mode.html", response_class=HTMLResponse)
def read_file_annotation_alt():
    file_annotation_file = BASE_DIR / "web" / "annotation_file_mode.html"
    if file_annotation_file.exists():
        return file_annotation_file.read_text(encoding="utf-8")
    return "<h1>File-Based Annotation not found</h1>"

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
    
    print(f"\n� Starting CAT: Coral Annotation Tool")
    print(f"📍 Server: http://{host if host != '0.0.0.0' else 'localhost'}:{port}")
    print(f"🪸 Coral Annotation: http://localhost:{port}/annotate")
    print(f"📁 Project Creator: http://localhost:{port}/project_creator.html")
    print(f"⚙️  COG Converter: http://localhost:{port}/converter")
    print(f"📚 API Docs: http://localhost:{port}/docs")
    print(f"\n{'='*60}\n")
    
    uvicorn.run(
        "cat.server:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info"
    )
