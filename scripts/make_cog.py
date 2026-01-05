#!/usr/bin/env python
"""
make_cog.py — Convert a GeoTIFF to a Cloud Optimized GeoTIFF (COG).

Examples (Windows CMD):
  python make_cog.py ^
    --src "C:\\path\\to\\2025_GUA-2838_mos.tif" ^
    --dst "C:\\path\\to\\2025_GUA-2838_mos_cog.tif" ^
    --resampling bilinear

For single-band DEMs you can set nodata (within dtype range), e.g.:
  python make_cog.py --src dem.tif --dst dem_cog.tif --nodata -9999 --resampling bilinear
"""

import argparse
import os
import sys
import warnings
import tempfile

import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles


def choose_profile(band_count: int, forced: str | None) -> dict:
    if forced:
        if forced not in {"jpeg", "lzw", "zstd"}:
            raise ValueError("--profile must be one of: jpeg|lzw|zstd")
        return cog_profiles.get(forced)
    # Auto: RGB(A) -> jpeg, everything else -> lzw
    return cog_profiles.get("jpeg" if band_count in (3, 4) else "lzw")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True, help="Input GeoTIFF")
    p.add_argument("--dst", required=True, help="Output COG path")
    p.add_argument("--profile", help="Force profile: jpeg|lzw|zstd")
    p.add_argument("--nodata", type=float, default=None,
                   help="Set nodata for single-band numeric rasters (ignored for multi-band RGB)")
    p.add_argument("--resampling", default="bilinear",
                   help="Overview resampling: nearest|bilinear|cubic|lanczos|average|mode|max|min|med|q1|q3")
    p.add_argument("--web-optimized", action="store_true",
                   help="Write WebMercator-friendly layout (usually leave off)")
    p.add_argument("--no-reproject", action="store_true",
                   help="Skip automatic reprojection to EPSG:4326 (WGS84)")
    return p.parse_args()


def main():
    args = parse_args()
    if not os.path.exists(args.src):
        print(f"ERROR: src not found: {args.src}", file=sys.stderr)
        sys.exit(1)

    # Check if reprojection to WGS84 is needed
    src_file = args.src
    needs_cleanup = False
    
    with rasterio.open(args.src) as src:
        band_count = src.count
        dtype = src.dtypes[0]  # assume all bands same dtype
        src_nodata = src.nodata  # Get source nodata value
        src_crs = src.crs
        
        # Check if reprojection is needed (not WGS84)
        if not args.no_reproject and src_crs and src_crs != rasterio.crs.CRS.from_epsg(4326):
            print(f"WARNING: Source CRS: {src_crs}")
            print(f"INFO: Reprojecting to EPSG:4326 (WGS84) for accurate web mapping...")
            
            # Create temporary reprojected file
            temp_fd, temp_path = tempfile.mkstemp(suffix='.tif')
            os.close(temp_fd)
            needs_cleanup = True
            
            # Calculate transform for WGS84
            dst_crs = rasterio.crs.CRS.from_epsg(4326)
            transform, width, height = calculate_default_transform(
                src_crs, dst_crs, src.width, src.height, *src.bounds
            )
            
            # Set up destination metadata
            kwargs = src.meta.copy()
            kwargs.update({
                'crs': dst_crs,
                'transform': transform,
                'width': width,
                'height': height
            })
            
            # Reproject to temporary file
            with rasterio.open(temp_path, 'w', **kwargs) as dst:
                for i in range(1, src.count + 1):
                    reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src_crs,
                        dst_transform=transform,
                        dst_crs=dst_crs,
                        resampling=Resampling.bilinear
                    )
            
            # Use reprojected file as source for COG conversion
            src_file = temp_path
            print(f"SUCCESS: Reprojected to WGS84")
        elif src_crs == rasterio.crs.CRS.from_epsg(4326):
            print(f"INFO: Source already in EPSG:4326 (WGS84)")
        else:
            print(f"WARNING: Source CRS: {src_crs or 'Unknown'}")

    profile = choose_profile(band_count, args.profile)

    # Internal mask is generally what we want for RGB and is safe otherwise
    config = {"GDAL_TIFF_INTERNAL_MASK": True}

    # Decide whether nodata is valid to apply
    nodata_to_use = args.nodata if args.nodata is not None else src_nodata
    
    if nodata_to_use is not None:
        if band_count == 1:
            # Only apply if nodata is sane for the dtype (or dtype is float)
            if "float" in dtype:
                profile["nodata"] = nodata_to_use
                if args.nodata is None:
                    print(f"Auto-detected nodata: {nodata_to_use}")
            else:
                ranges = {
                    "uint8": (0, 255),
                    "uint16": (0, 65535),
                    "int16": (-32768, 32767),
                    "uint32": (0, 4294967295),
                    "int32": (-2147483648, 2147483647),
                }
                lo, hi = ranges.get(dtype, (None, None))
                if lo is not None and lo <= nodata_to_use <= hi:
                    profile["nodata"] = nodata_to_use
                    if args.nodata is None:
                        print(f"Auto-detected nodata: {nodata_to_use}")
                else:
                    warnings.warn(f"nodata {nodata_to_use} not valid for dtype {dtype}; ignoring.")
        else:
            warnings.warn("nodata ignored for multi-band imagery; using internal mask instead.")

    # IMPORTANT: rio-cogeo v5 expects the *string* name for overview_resampling
    overview_resampling = args.resampling  # e.g., "bilinear", "nearest", ...

    try:
        # Create COG with overviews
        cog_translate(
            src_file,  # Use potentially reprojected file
            args.dst,
            profile,
            in_memory=False,
            web_optimized=bool(args.web_optimized),
            config=config,
            overview_resampling=overview_resampling,  # pass string name, NOT enum/int
        )
        print(
            f"SUCCESS: COG written: {args.dst} "
            f"(bands={band_count}, dtype={dtype}, compress={profile.get('compress','none')}, "
            f"resampling={overview_resampling})"
        )
    finally:
        # Clean up temporary reprojected file
        if needs_cleanup and os.path.exists(src_file):
            os.unlink(src_file)
            print(f"INFO: Cleaned up temporary file")


if __name__ == "__main__":
    main()
