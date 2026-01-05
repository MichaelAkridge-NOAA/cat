#!/usr/bin/env python
"""
make_cog_batch.py — Batch convert multiple GeoTIFFs to Cloud Optimized GeoTIFFs (COG).

Examples:
  # Convert all TIF files in a directory
  python make_cog_batch.py --src-dir "C:\\path\\to\\input" --dst-dir "C:\\path\\to\\output"
  
  # Convert specific files with custom settings
  python make_cog_batch.py --src-dir "./data" --dst-dir "./data/cog" --resampling cubic --profile lzw
  
  # Process only files matching a pattern
  python make_cog_batch.py --src-dir "./data" --dst-dir "./data/cog" --pattern "*_mos.tif"
  
  # Set nodata for single-band rasters
  python make_cog_batch.py --src-dir "./dems" --dst-dir "./dems_cog" --nodata -9999
"""

import argparse
import os
import sys
import warnings
from pathlib import Path
from typing import List
import glob

import rasterio
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles


def choose_profile(band_count: int, forced: str | None) -> dict:
    if forced:
        if forced not in {"jpeg", "lzw", "zstd"}:
            raise ValueError("--profile must be one of: jpeg|lzw|zstd")
        return cog_profiles.get(forced)
    # Auto: RGB(A) -> jpeg, everything else -> lzw
    return cog_profiles.get("jpeg" if band_count in (3, 4) else "lzw")


def find_tif_files(src_dir: str, pattern: str = "*.tif") -> List[Path]:
    """Find all TIF files in the source directory matching the pattern."""
    src_path = Path(src_dir)
    if not src_path.exists():
        raise FileNotFoundError(f"Source directory not found: {src_dir}")
    
    # Support both .tif and .tiff extensions
    patterns = [pattern, pattern.replace('.tif', '.tiff')]
    files = []
    for pat in patterns:
        files.extend(src_path.glob(pat))
    
    # Remove duplicates and sort
    files = sorted(set(files))
    return files


def convert_to_cog(src_path: Path, dst_path: Path, args) -> bool:
    """Convert a single GeoTIFF to COG. Returns True on success, False on failure."""
    try:
        with rasterio.open(src_path) as src:
            band_count = src.count
            dtype = src.dtypes[0]
            src_nodata = src.nodata  # Get source nodata value

        profile = choose_profile(band_count, args.profile)
        config = {"GDAL_TIFF_INTERNAL_MASK": True}

        # Handle nodata - auto-detect from source if not specified
        nodata_to_use = args.nodata if args.nodata is not None else src_nodata
        
        if nodata_to_use is not None:
            if band_count == 1:
                if "float" in dtype:
                    profile["nodata"] = nodata_to_use
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
                    else:
                        warnings.warn(f"nodata {nodata_to_use} not valid for dtype {dtype}; ignoring.")
            else:
                warnings.warn("nodata ignored for multi-band imagery; using internal mask instead.")

        overview_resampling = args.resampling

        # Create COG
        cog_translate(
            str(src_path),
            str(dst_path),
            profile,
            in_memory=False,
            web_optimized=bool(args.web_optimized),
            config=config,
            overview_resampling=overview_resampling,
        )
        
        print(f"✓ {src_path.name} -> {dst_path.name} "
              f"(bands={band_count}, dtype={dtype}, compress={profile.get('compress','none')})")
        return True
        
    except Exception as e:
        print(f"✗ Failed to convert {src_path.name}: {str(e)}", file=sys.stderr)
        return False


def parse_args():
    p = argparse.ArgumentParser(
        description="Batch convert GeoTIFF files to Cloud Optimized GeoTIFF (COG) format"
    )
    p.add_argument("--src-dir", required=True, help="Input directory containing GeoTIFF files")
    p.add_argument("--dst-dir", required=True, help="Output directory for COG files")
    p.add_argument("--pattern", default="*.tif", help="File pattern to match (default: *.tif)")
    p.add_argument("--profile", help="Force profile: jpeg|lzw|zstd")
    p.add_argument("--nodata", type=float, default=None,
                   help="Set nodata for single-band numeric rasters")
    p.add_argument("--resampling", default="bilinear",
                   help="Overview resampling: nearest|bilinear|cubic|lanczos|average|mode|max|min|med|q1|q3")
    p.add_argument("--web-optimized", action="store_true",
                   help="Write WebMercator-friendly layout")
    p.add_argument("--suffix", default="_cog",
                   help="Suffix to add to output filenames (default: _cog)")
    p.add_argument("--overwrite", action="store_true",
                   help="Overwrite existing COG files")
    p.add_argument("--recursive", "-r", action="store_true",
                   help="Search for files recursively in subdirectories")
    return p.parse_args()


def main():
    args = parse_args()
    
    # Create output directory if it doesn't exist
    dst_path = Path(args.dst_dir)
    dst_path.mkdir(parents=True, exist_ok=True)
    
    # Find all TIF files
    if args.recursive:
        pattern = f"**/{args.pattern}"
    else:
        pattern = args.pattern
    
    tif_files = find_tif_files(args.src_dir, pattern)
    
    if not tif_files:
        print(f"No files found matching pattern '{args.pattern}' in {args.src_dir}")
        sys.exit(1)
    
    print(f"Found {len(tif_files)} file(s) to convert")
    print(f"Output directory: {args.dst_dir}")
    print("-" * 60)
    
    # Process each file
    success_count = 0
    fail_count = 0
    skip_count = 0
    
    for src_file in tif_files:
        # Skip files that already have _cog suffix to avoid re-processing
        if args.suffix and args.suffix in src_file.stem:
            print(f"⊘ Skipping {src_file.name} (already appears to be a COG)")
            skip_count += 1
            continue
        
        # Build output filename
        if args.suffix:
            dst_filename = f"{src_file.stem}{args.suffix}{src_file.suffix}"
        else:
            dst_filename = src_file.name
        
        dst_file = dst_path / dst_filename
        
        # Check if output already exists
        if dst_file.exists() and not args.overwrite:
            print(f"⊘ Skipping {src_file.name} (output exists, use --overwrite to replace)")
            skip_count += 1
            continue
        
        # Convert the file
        if convert_to_cog(src_file, dst_file, args):
            success_count += 1
        else:
            fail_count += 1
    
    # Summary
    print("-" * 60)
    print(f"Conversion complete:")
    print(f"  ✓ Success: {success_count}")
    print(f"  ✗ Failed:  {fail_count}")
    print(f"  ⊘ Skipped: {skip_count}")
    
    if fail_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
