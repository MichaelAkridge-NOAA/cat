"""
File-based project API for coral annotation.
Allows users to work with JSON project files instead of database.
"""

from fastapi import APIRouter, UploadFile, File, HTTPException, Body
from fastapi.responses import JSONResponse
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime
import json
import os
import subprocess
import logging
import uuid
import tempfile
import shutil

router = APIRouter(prefix="/api/file-projects", tags=["file-projects"])
logger = logging.getLogger(__name__)

# In-memory storage for active projects (session-based)
active_projects: Dict[str, dict] = {}


def create_cog_from_tif(tif_path: str, cog_path: str) -> dict:
    """
    Create a Cloud Optimized GeoTIFF from a TIF file.
    Returns status dict with success/error info.
    """
    try:
        # Validate source exists
        if not os.path.exists(tif_path):
            return {
                "success": False,
                "error": f"Source TIF not found: {tif_path}"
            }
        
        # Create output directory if it doesn't exist
        output_dir = os.path.dirname(cog_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)
        
        # Use the make_cog.py script from the package
        script_path = Path(__file__).parent.parent / "scripts" / "make_cog.py"
        
        cmd = [
            "python",
            str(script_path),
            "--src", tif_path,
            "--dst", cog_path,
            "--resampling", "bilinear"
        ]
        
        logger.info(f"Creating COG: {tif_path} -> {cog_path}")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )
        
        if result.returncode == 0:
            logger.info(f"COG created successfully: {cog_path}")
            return {
                "success": True,
                "cog_path": cog_path,
                "message": "COG created successfully"
            }
        else:
            error_msg = result.stderr or result.stdout
            logger.error(f"COG creation failed: {error_msg}")
            return {
                "success": False,
                "error": f"COG creation failed: {error_msg}"
            }
            
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "COG creation timed out (>5 minutes)"
        }
    except Exception as e:
        logger.error(f"Error creating COG: {str(e)}")
        return {
            "success": False,
            "error": f"Error creating COG: {str(e)}"
        }


def get_raster_info(file_path: str) -> dict:
    """Get bounds and EPSG from a raster file."""
    try:
        import rasterio
        with rasterio.open(file_path) as src:
            bounds = src.bounds
            epsg = src.crs.to_epsg() if src.crs else None
            return {
                "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
                "epsg": epsg
            }
    except Exception as e:
        logger.error(f"Error reading raster info: {e}")
        return {"bounds": None, "epsg": None}


@router.post("/upload-project")
async def upload_project(file: UploadFile = File(...)):
    """
    Upload and validate a project JSON file.
    Creates COGs if needed and returns project info.
    """
    try:
        # Read and parse JSON
        content = await file.read()
        project_data = json.loads(content)
        
        # Validate required fields
        required_fields = ["project_name", "tif_files"]
        for field in required_fields:
            if field not in project_data:
                raise HTTPException(
                    status_code=400,
                    detail=f"Missing required field: {field}"
                )
        
        # Generate unique project ID
        project_id = str(uuid.uuid4())
        
        # Process each TIF file
        for tif_entry in project_data["tif_files"]:
            tif_path = tif_entry.get("tif_path")
            cog_path = tif_entry.get("cog_path")
            
            if not tif_path:
                raise HTTPException(
                    status_code=400,
                    detail=f"Missing tif_path in TIF entry: {tif_entry.get('id', 'unknown')}"
                )
            
            # Check if source TIF exists
            if not os.path.exists(tif_path):
                raise HTTPException(
                    status_code=400,
                    detail=f"TIF file not found: {tif_path}"
                )
            
            # Auto-generate COG path if not provided
            if not cog_path:
                base_path = os.path.splitext(tif_path)[0]
                cog_path = f"{base_path}_cog.tif"
                tif_entry["cog_path"] = cog_path
            
            # Check if COG already exists
            if os.path.exists(cog_path):
                logger.info(f"COG already exists: {cog_path}")
                tif_entry["cog_created"] = True
                
                # Get raster info
                info = get_raster_info(cog_path)
                tif_entry.update(info)
                
                # Set tile URL (matching annotation_viewer format)
                # Use the correct endpoint format that works with titiler
                from urllib.parse import quote
                encoded_path = quote(cog_path, safe='')
                tif_entry["tile_url"] = f"/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?url={encoded_path}"
            else:
                # Create COG
                logger.info(f"Creating COG for: {tif_path}")
                result = create_cog_from_tif(tif_path, cog_path)
                
                if result["success"]:
                    tif_entry["cog_created"] = True
                    
                    # Get raster info
                    info = get_raster_info(cog_path)
                    tif_entry.update(info)
                    
                    # Set tile URL (matching annotation_viewer format)
                    from urllib.parse import quote
                    encoded_path = quote(cog_path, safe='')
                    tif_entry["tile_url"] = f"/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?url={encoded_path}"
                else:
                    tif_entry["cog_created"] = False
                    tif_entry["error"] = result["error"]
        
        # Check for annotations - either in separate file or embedded in project
        annotations_data = []
        
        # First check if annotations are embedded in the project JSON itself
        if "annotations" in project_data and isinstance(project_data["annotations"], list):
            annotations_data = project_data["annotations"]
            logger.info(f"Loaded {len(annotations_data)} embedded annotations from project file")
        else:
            # Otherwise, check for separate annotations file
            annotations_path = project_data.get("annotations_file")
            
            if annotations_path and os.path.exists(annotations_path):
                # Load existing annotations from separate file
                try:
                    with open(annotations_path, 'r') as f:
                        annotations_json = json.load(f)
                        annotations_data = annotations_json.get("annotations", [])
                    logger.info(f"Loaded {len(annotations_data)} existing annotations from separate file")
                except Exception as e:
                    logger.warning(f"Could not load annotations file: {e}")
            else:
                # Suggest annotations file path (same directory as project JSON)
                # We don't know the original path, so we'll set it in metadata
                project_name_safe = project_data["project_name"].replace(" ", "_").replace("/", "_")
                suggested_annotations_file = f"{project_name_safe}_annotations.json"
                project_data["suggested_annotations_file"] = suggested_annotations_file
        
        # Store project in memory
        project_data["project_id"] = project_id
        project_data["uploaded_at"] = datetime.now().isoformat()
        project_data["loaded_annotations"] = annotations_data
        active_projects[project_id] = project_data
        
        return JSONResponse({
            "success": True,
            "project_id": project_id,
            "project": project_data,
            "annotations": annotations_data
        })
        
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except Exception as e:
        logger.error(f"Error uploading project: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/project/{project_id}")
async def get_project(project_id: str):
    """Get project data by ID."""
    if project_id not in active_projects:
        raise HTTPException(status_code=404, detail="Project not found")
    
    return JSONResponse({
        "success": True,
        "project": active_projects[project_id]
    })


@router.post("/project/{project_id}/annotations")
async def save_annotations(
    project_id: str,
    data: Dict = Body(...)
):
    """
    Save annotations for a project.
    Returns the complete project + annotations for download.
    """
    try:
        if project_id not in active_projects:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project = active_projects[project_id]
        annotations_list = data.get("annotations", [])
        
        # Get project file name suggestion
        project_name_safe = project.get("project_name", "project").replace(" ", "_").replace("/", "_")
        
        # Determine base path from first TIF file
        base_path = None
        if project.get("tif_files") and len(project["tif_files"]) > 0:
            first_tif = project["tif_files"][0].get("tif_path", "")
            if first_tif:
                base_path = os.path.dirname(first_tif)
        
        # Use existing annotations_file path, or create a new one in base_path
        annotations_file_path = project.get("annotations_file")
        if not annotations_file_path and base_path:
            # Create path in base directory
            annotations_file_path = os.path.join(base_path, f"{project_name_safe}_annotations.json")
        elif not annotations_file_path:
            # Just use filename if no base path
            annotations_file_path = f"{project_name_safe}_annotations.json"
        
        annotations_file_name = os.path.basename(annotations_file_path)
        
        # Create annotations structure
        annotations_data = {
            "project_name": project.get("project_name"),
            "project_id": project_id,
            "site": project.get("site"),
            "cruise": project.get("cruise"),
            "year": project.get("year"),
            "region": project.get("region"),
            "last_modified": datetime.now().isoformat(),
            "annotation_count": len(annotations_list),
            "annotations": annotations_list
        }
        
        # Prepare project file (cleaned up for re-use)
        project_export = {
            "project_name": project.get("project_name"),
            "site": project.get("site"),
            "cruise": project.get("cruise"),
            "year": project.get("year"),
            "region": project.get("region"),
            "tif_files": project.get("tif_files"),
            "shapefiles": project.get("shapefiles", []),
            "metadata": project.get("metadata", {}),
            "annotations_file": annotations_file_path  # Use full path
        }
        
        return JSONResponse({
            "success": True,
            "project_file": project_export,
            "annotations_file": annotations_data,
            "suggested_project_name": f"{project_name_safe}_project.json",
            "suggested_annotations_name": annotations_file_name,
            "annotations_file_path": annotations_file_path,  # Full path for display
            "base_path": base_path
        })
        
    except Exception as e:
        logger.error(f"Error saving annotations: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/project/{project_id}/save-combined")
async def save_combined(
    project_id: str,
    data: Dict = Body(...)
):
    """
    Save project and annotations in a single combined JSON file.
    Simpler workflow - one file contains everything.
    """
    try:
        if project_id not in active_projects:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project = active_projects[project_id]
        annotations_list = data.get("annotations", [])
        
        # Get project file name suggestion
        project_name_safe = project.get("project_name", "project").replace(" ", "_").replace("/", "_")
        
        # Determine base path from first TIF file
        base_path = None
        if project.get("tif_files") and len(project["tif_files"]) > 0:
            first_tif = project["tif_files"][0].get("tif_path", "")
            if first_tif:
                base_path = os.path.dirname(first_tif)
        
        # Create combined structure
        combined_data = {
            "project_name": project.get("project_name"),
            "site": project.get("site"),
            "cruise": project.get("cruise"),
            "year": project.get("year"),
            "region": project.get("region"),
            "tif_files": project.get("tif_files"),
            "shapefiles": project.get("shapefiles", []),
            "metadata": project.get("metadata", {}),
            "last_modified": datetime.now().isoformat(),
            "annotation_count": len(annotations_list),
            "annotations": annotations_list
        }
        
        # Create filename with project name and timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        suggested_filename = f"{project_name_safe}_{timestamp}.json"
        
        return JSONResponse({
            "success": True,
            "combined_file": combined_data,
            "suggested_filename": suggested_filename,
            "base_path": base_path
        })
        
    except Exception as e:
        logger.error(f"Error saving combined file: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/project/{project_id}/upload-annotations")
async def upload_annotations(
    project_id: str,
    file: UploadFile = File(...)
):
    """
    Upload existing annotations JSON to continue work.
    """
    try:
        if project_id not in active_projects:
            raise HTTPException(status_code=404, detail="Project not found")
        
        # Read and parse annotations JSON
        content = await file.read()
        annotations_data = json.loads(content)
        
        return JSONResponse({
            "success": True,
            "annotations": annotations_data
        })
        
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except Exception as e:
        logger.error(f"Error uploading annotations: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/project/{project_id}")
async def delete_project(project_id: str):
    """Remove project from active session."""
    if project_id in active_projects:
        del active_projects[project_id]
        return JSONResponse({
            "success": True,
            "message": "Project removed from session"
        })
    else:
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("/list")
async def list_active_projects():
    """List all active projects in current session."""
    projects = [
        {
            "project_id": pid,
            "project_name": proj.get("project_name"),
            "site": proj.get("site"),
            "uploaded_at": proj.get("uploaded_at")
        }
        for pid, proj in active_projects.items()
    ]
    
    return JSONResponse({
        "success": True,
        "projects": projects,
        "count": len(projects)
    })


@router.get("/shapefile")
async def get_shapefile_geojson(path: str):
    """
    Convert shapefile to GeoJSON on-the-fly.
    Geopandas automatically finds all associated files (.shx, .dbf, .prj, etc.)
    when you provide the .shp path.
    """
    try:
        import geopandas as gpd
        
        logger.info(f"📂 Reading shapefile: {path}")
        
        # Validate path
        if not os.path.exists(path):
            logger.error(f"❌ Shapefile not found: {path}")
            raise HTTPException(status_code=404, detail=f"Shapefile not found: {path}")
        
        # Check if associated files exist
        base_path = os.path.splitext(path)[0]
        shx_exists = os.path.exists(f"{base_path}.shx")
        dbf_exists = os.path.exists(f"{base_path}.dbf")
        prj_exists = os.path.exists(f"{base_path}.prj")
        
        logger.info(f"📋 Shapefile components - .shx: {shx_exists}, .dbf: {dbf_exists}, .prj: {prj_exists}")
        
        if not shx_exists:
            logger.warning(f"⚠️ Missing .shx file: {base_path}.shx")
        if not dbf_exists:
            logger.warning(f"⚠️ Missing .dbf file: {base_path}.dbf")
        
        # Read shapefile (geopandas automatically reads all associated files)
        gdf = gpd.read_file(path)
        
        logger.info(f"✅ Read {len(gdf)} features from shapefile")
        logger.info(f"📊 Original CRS: {gdf.crs}")
        logger.info(f"📏 Original Bounds: {gdf.total_bounds}")
        
        # IMPORTANT: Reproject to WGS84 (EPSG:4326) if not already
        # Leaflet maps use WGS84 by default, so we need to ensure coordinates match
        if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
            logger.info(f"🔄 Reprojecting from {gdf.crs} to EPSG:4326 (WGS84)")
            gdf = gdf.to_crs(epsg=4326)
            logger.info(f"✅ Reprojected bounds: {gdf.total_bounds}")
        elif gdf.crs is None:
            logger.warning("⚠️ Shapefile has no CRS defined - assuming it's already WGS84")
        else:
            logger.info("✅ Shapefile already in WGS84 (EPSG:4326)")
        
        # Convert to GeoJSON
        geojson = json.loads(gdf.to_json())
        
        logger.info(f"✅ Converted to GeoJSON with {len(geojson.get('features', []))} features")
        
        return geojson
        
    except ImportError:
        logger.error("❌ geopandas not installed")
        raise HTTPException(status_code=500, detail="geopandas not installed. Run: pip install geopandas")
    except Exception as e:
        logger.error(f"❌ Error reading shapefile {path}: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Error reading shapefile: {str(e)}")


@router.post("/export-shapefile")
async def export_shapefile(data: Dict = Body(...)):
    """
    Export annotations to shapefile format (as a zip file).
    Converts GeoJSON annotations to shapefile using geopandas.
    """
    try:
        import geopandas as gpd
        from shapely.geometry import shape
        from fastapi.responses import StreamingResponse
        import zipfile
        import io
        
        annotations = data.get("annotations", [])
        project_name = data.get("project_name", "annotations")
        site = data.get("site", "unknown")
        
        if not annotations:
            raise HTTPException(status_code=400, detail="No annotations provided")
        
        logger.info(f"📦 Exporting {len(annotations)} annotations to shapefile")
        
        # Convert annotations to GeoDataFrame
        features = []
        for ann in annotations:
            if "geometry" in ann:
                # Create shapely geometry from GeoJSON
                geom = shape(ann["geometry"])
                
                # Prepare properties (flatten the annotation data)
                props = {
                    "ANALYST": ann.get("analyst", ""),
                    "OBS_YEAR": ann.get("obs_year", None),
                    "MISSION_ID": ann.get("mission_id", ""),
                    "SITE": ann.get("site", ""),
                    "TRANSECT": ann.get("transect", ""),
                    "SEGMENT": ann.get("segment", None),
                    "SEGLENGTH": ann.get("seglength", None),
                    "SEGWIDTH": ann.get("segwidth", None),
                    "NO_COLONY": ann.get("no_colony", 0),
                    "SPCODE": ann.get("spcode", ""),
                    "JUVENILE": ann.get("juvenile", 0),
                    "REMNANT": ann.get("remnant", 0),
                    "FRAGMENT": ann.get("fragment", 0),
                    "MORPH_CODE": ann.get("morph_code", ""),
                    "EX_BOUND": ann.get("ex_bound", 0),
                    "OLD_DEAD": ann.get("old_dead", None),
                    "RDCAUSE1": ann.get("rdcause1", ""),
                    "RD_1": ann.get("rd_1", None),
                    "RDCAUSE2": ann.get("rdcause2", ""),
                    "RD_2": ann.get("rd_2", None),
                    "RDCAUSE3": ann.get("rdcause3", ""),
                    "RD_3": ann.get("rd_3", None),
                    "CON_1": ann.get("con_1", ""),
                    "EXTENT_1": ann.get("extent_1", None),
                    "SEV_1": ann.get("sev_1", None),
                    "CON_2": ann.get("con_2", ""),
                    "EXTENT_2": ann.get("extent_2", None),
                    "SEV_2": ann.get("sev_2", None),
                    "CON_3": ann.get("con_3", ""),
                    "EXTENT_3": ann.get("extent_3", None),
                    "SEV_3": ann.get("sev_3", None),
                    "CREATED": ann.get("created_at", "")[:10]  # Date only
                }
                
                features.append({
                    "geometry": geom,
                    "properties": props
                })
        
        # Create GeoDataFrame
        gdf = gpd.GeoDataFrame([f["properties"] for f in features], 
                               geometry=[f["geometry"] for f in features],
                               crs="EPSG:4326")
        
        logger.info(f"✅ Created GeoDataFrame with {len(gdf)} features")
        
        # Create a temporary directory for shapefile components
        with tempfile.TemporaryDirectory() as tmpdir:
            shapefile_base = os.path.join(tmpdir, f"{project_name}_{site}_annotations")
            
            # Write shapefile
            gdf.to_file(shapefile_base + ".shp", driver="ESRI Shapefile")
            logger.info(f"✅ Wrote shapefile to {shapefile_base}.shp")
            
            # Create zip file in memory
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zipf:
                # Add all shapefile components (.shp, .shx, .dbf, .prj, .cpg)
                for ext in ['.shp', '.shx', '.dbf', '.prj', '.cpg']:
                    filepath = shapefile_base + ext
                    if os.path.exists(filepath):
                        zipf.write(filepath, os.path.basename(filepath))
                        logger.info(f"  Added {ext} to zip")
            
            zip_buffer.seek(0)
            
            logger.info(f"✅ Created zip file with shapefile components")
            
            # Return zip file as download
            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f"attachment; filename={project_name}_{site}_annotations_shapefile.zip"
                }
            )
    
    except ImportError as e:
        logger.error(f"❌ Missing required package: {e}")
        raise HTTPException(status_code=500, detail=f"Missing required package. Run: pip install geopandas shapely")
    except Exception as e:
        logger.error(f"❌ Error exporting shapefile: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Error exporting shapefile: {str(e)}")
