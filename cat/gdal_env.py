"""
GDAL/rasterio environment used for every COG read in the app.

Lives on its own so the TiTiler tile endpoints (cat/server.py) and the
thumbnail renderer (cat/api/thumbnails.py) read Cloud-Optimized GeoTIFFs
under identical settings. Previously this dict existed only inside
server.py; a second reader elsewhere would have had to copy it and would
then have quietly drifted -- e.g. losing GS_NO_SIGN_REQUEST and failing on
the public GCS buckets the tiles load fine from.
"""

from typing import Dict

GCS_GDAL_ENV: Dict[str, str] = {
    "GS_NO_SIGN_REQUEST": "YES",               # read public GCS buckets without credentials
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff,.geotiff",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_VERSION": "2",
}


def gdal_path(uri: str) -> str:
    """Convert a gs:// URI to the /vsigs/ path GDAL understands.

    Mirrors cat/server.py::_gdal_path. Any other scheme (https://, a local
    path, /vsi* already) is handed back untouched.
    """
    if uri.startswith("gs://"):
        return "/vsigs/" + uri[5:]
    return uri
