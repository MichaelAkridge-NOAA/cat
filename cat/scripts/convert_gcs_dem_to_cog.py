"""Standalone GCS DEM -> COG converter.

This script is intentionally standalone so it can be used in cloud batch jobs
without depending on the orthomosaic conversion wrapper.

Workflow per file:
1) list source DEM TIFFs from GCS prefix
2) download to local temp
3) convert to COG (DEM defaults: LZW profile, nodata if provided/detected)
4) upload COG to destination GCS prefix
5) cleanup temp files (unless --keep-temp)

Example dry run:
    python -m cat.scripts.convert_gcs_dem_to_cog --dry-run --max-files 5
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import fnmatch
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import warnings
from typing import Any, Dict, List, Optional


DEFAULT_SOURCE = "gs://nmfs_odp_pifsc/PIFSC/ESD/ARP/StRS_Sites_Products/dem/2025"
DEFAULT_DEST = "gs://nmfs_odp_pifsc/PIFSC/ESD/ARP/StRS_Sites_Products/dem_cog/2025"
DEFAULT_PATTERN = "*dem*.tif"


@dataclass
class JobResult:
    source_uri: str
    destination_uri: str
    status: str
    detail: str = ""
    output_local: Optional[str] = None


@dataclass
class ConversionResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


def _normalize_gs_prefix(prefix: str) -> str:
    p = prefix.strip()
    if not p.startswith("gs://"):
        raise ValueError(f"Expected gs:// prefix, got: {prefix}")
    return p.rstrip("/")


def _run_cmd(cmd: List[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def _resolve_gsutil() -> Optional[str]:
    return shutil.which("gsutil") or shutil.which("gsutil.cmd")


def _list_gcs_objects(source_prefix: str) -> List[str]:
    gsutil = _resolve_gsutil()
    if not gsutil:
        raise RuntimeError("gsutil not found in PATH")

    list_target = f"{source_prefix}/**"
    proc = _run_cmd([gsutil, "ls", list_target], check=False)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        if "One or more URLs matched no objects" in stderr:
            return []
        raise RuntimeError(f"Failed to list objects under {source_prefix}: {stderr}")

    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    return [ln for ln in lines if ln.startswith("gs://") and not ln.endswith("/")]


def _object_exists(uri: str) -> bool:
    gsutil = _resolve_gsutil()
    if not gsutil:
        return False
    proc = _run_cmd([gsutil, "-q", "stat", uri], check=False)
    return proc.returncode == 0


def _make_destination_uri(source_uri: str, source_prefix: str, dest_prefix: str, suffix: str) -> str:
    rel = source_uri[len(source_prefix):].lstrip("/")
    rel_path = Path(rel)

    stem = rel_path.stem
    if suffix and not stem.endswith(suffix):
        out_name = f"{stem}{suffix}{rel_path.suffix}"
    else:
        out_name = rel_path.name

    out_rel = str(rel_path.with_name(out_name)).replace("\\", "/")
    return f"{dest_prefix}/{out_rel}"


def _choose_profile(band_count: int, forced: Optional[str]) -> str:
    if forced:
        normalized = forced.lower()
        if normalized not in {"jpeg", "lzw", "zstd", "deflate"}:
            raise ValueError("--profile must be one of: jpeg|lzw|zstd|deflate")
        return normalized
    # Auto: RGB(A) -> zstd (lossless, good compression), single-band -> lzw
    return "zstd" if band_count in (3, 4) else "lzw"


def _convert_local_to_cog(src_local: Path, dst_local: Path, args: argparse.Namespace, force_no_reproject: bool = False) -> ConversionResult:
    try:
        import rasterio
        from rasterio.warp import calculate_default_transform, reproject, Resampling
        from rio_cogeo.cogeo import cog_translate
        from rio_cogeo.profiles import cog_profiles
    except Exception as e:
        return ConversionResult(
            returncode=1,
            stderr=(
                "Missing conversion dependencies. Install rasterio and rio-cogeo. "
                f"Import error: {e}"
            ),
        )

    src_file = str(src_local)
    temp_reprojected: Optional[str] = None

    try:
        with rasterio.open(src_file) as src:
            band_count = src.count
            dtype = src.dtypes[0]
            src_nodata = src.nodata
            src_crs = src.crs

            disable_reproject = args.no_reproject or force_no_reproject
            if (not disable_reproject) and src_crs and src_crs != rasterio.crs.CRS.from_epsg(4326):
                temp_fd, temp_path = tempfile.mkstemp(suffix=".tif")
                os.close(temp_fd)
                temp_reprojected = temp_path

                dst_crs = rasterio.crs.CRS.from_epsg(4326)
                transform, width, height = calculate_default_transform(
                    src_crs,
                    dst_crs,
                    src.width,
                    src.height,
                    *src.bounds,
                )

                kwargs = src.meta.copy()
                kwargs.update({
                    "crs": dst_crs,
                    "transform": transform,
                    "width": width,
                    "height": height,
                })

                with rasterio.open(temp_path, "w", **kwargs) as dst:
                    for idx in range(1, src.count + 1):
                        reproject(
                            source=rasterio.band(src, idx),
                            destination=rasterio.band(dst, idx),
                            src_transform=src.transform,
                            src_crs=src_crs,
                            dst_transform=transform,
                            dst_crs=dst_crs,
                            resampling=Resampling.bilinear,
                        )

                src_file = temp_path

        profile_name = _choose_profile(band_count, args.profile)
        profile = dict(cog_profiles.get(profile_name))
        config = {"GDAL_TIFF_INTERNAL_MASK": True}

        # Apply quality for JPEG; warn if quality set on lossless profile
        if profile.get("compress", "").lower() == "jpeg":
            profile["quality"] = args.quality if args.quality is not None else 90
        elif args.quality is not None:
            warnings.warn("--quality only applies to JPEG compression; ignored for lossless profiles.")

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

        cog_translate(
            src_file,
            str(dst_local),
            profile,
            in_memory=False,
            web_optimized=bool(args.web_optimized),
            config=config,
            overview_resampling=args.resampling,
        )

        compress = profile.get("compress", "none")
        quality_str = f", quality={profile['quality']}" if "quality" in profile else " (lossless)"
        msg = (
            f"SUCCESS: COG written: {dst_local} "
            f"(bands={band_count}, dtype={dtype}, compress={compress}{quality_str}, "
            f"resampling={args.resampling})"
        )
        return ConversionResult(returncode=0, stdout=msg)

    except Exception as e:
        return ConversionResult(returncode=1, stderr=str(e))
    finally:
        if temp_reprojected and os.path.exists(temp_reprojected):
            os.unlink(temp_reprojected)


def _run_conversion_with_fallback(src_local: Path, dst_local: Path, args: argparse.Namespace) -> ConversionResult:
    conv = _convert_local_to_cog(src_local, dst_local, args, force_no_reproject=False)
    if conv.returncode == 0:
        return conv

    output = f"{conv.stdout or ''}\n{conv.stderr or ''}"
    markers = ["Cannot find coordinate operations", "rasterio.errors.CRSError", "EngineeringCRS"]
    should_retry = (not args.no_reproject) and any(m in output for m in markers)
    if not should_retry:
        return conv

    retry = _convert_local_to_cog(src_local, dst_local, args, force_no_reproject=True)
    if retry.returncode == 0:
        retry.stdout = (retry.stdout or "") + "\nINFO: Retried conversion with --no-reproject due to unsupported CRS transform.\n"
    return retry


def _process_one(source_uri: str, source_prefix: str, dest_prefix: str, args: argparse.Namespace, temp_root: Path) -> JobResult:
    destination_uri = _make_destination_uri(source_uri, source_prefix, dest_prefix, args.suffix)

    if (not args.overwrite) and _object_exists(destination_uri):
        return JobResult(source_uri, destination_uri, "skipped_exists", "Destination object already exists")

    if args.dry_run:
        return JobResult(source_uri, destination_uri, "planned", "Dry-run")

    gsutil = _resolve_gsutil()
    if not gsutil:
        return JobResult(source_uri, destination_uri, "failed", "gsutil not found in PATH")

    safe_name = source_uri.replace("gs://", "").replace("/", "_")
    work_dir = temp_root / safe_name
    work_dir.mkdir(parents=True, exist_ok=True)

    src_local = work_dir / Path(source_uri).name
    dst_local = work_dir / (src_local.stem + args.suffix + src_local.suffix)

    try:
        dl = _run_cmd([gsutil, "cp", source_uri, str(src_local)], check=False)
        if dl.returncode != 0:
            return JobResult(source_uri, destination_uri, "failed", f"Download failed: {(dl.stderr or '').strip()}")

        conv = _run_conversion_with_fallback(src_local, dst_local, args)
        if conv.returncode != 0:
            detail = (conv.stderr or conv.stdout or "").strip()
            return JobResult(source_uri, destination_uri, "failed", f"Conversion failed: {detail}")

        ul = _run_cmd([gsutil, "cp", str(dst_local), destination_uri], check=False)
        if ul.returncode != 0:
            return JobResult(source_uri, destination_uri, "failed", f"Upload failed: {(ul.stderr or '').strip()}")

        return JobResult(source_uri, destination_uri, "converted", output_local=str(dst_local))
    finally:
        if not args.keep_temp:
            shutil.rmtree(work_dir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert GCS DEM TIFFs to COG and upload to DEM COG prefix")
    p.add_argument("--source-prefix", default=DEFAULT_SOURCE, help="Source GCS prefix")
    p.add_argument("--dest-prefix", default=DEFAULT_DEST, help="Destination GCS prefix")
    p.add_argument("--pattern", default=DEFAULT_PATTERN, help="Filename glob filter")
    p.add_argument("--suffix", default="_cog", help="Suffix for output files")
    p.add_argument("--workers", type=int, default=1, help="Parallel workers")
    p.add_argument("--max-files", type=int, default=None, help="Process at most N matched files")
    p.add_argument("--tmp-dir", default=None, help="Optional temp root directory")
    p.add_argument("--report-file", default=None, help="Output JSON report path")
    p.add_argument("--dry-run", action="store_true", help="Plan only")
    p.add_argument("--overwrite", action="store_true", help="Overwrite destination files")
    p.add_argument("--keep-temp", action="store_true", help="Keep temp files")

    # DEM-oriented conversion defaults
    p.add_argument("--profile", default="lzw", help="COG profile: jpeg|lzw|zstd|deflate  (default: lzw for DEM)")
    p.add_argument("--quality", type=int, default=None, help="JPEG quality 1-100 (default: 90). Only applies with --profile jpeg.")
    p.add_argument("--nodata", type=float, default=None, help="Optional nodata override")
    p.add_argument("--resampling", default="bilinear", help="Overview resampling")
    p.add_argument("--web-optimized", action="store_true", help="Use web-optimized layout")
    p.add_argument("--no-reproject", action="store_true", help="Disable reprojection")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if not _resolve_gsutil():
        raise SystemExit("gsutil not found in PATH. Install Google Cloud SDK and authenticate first.")

    source_prefix = _normalize_gs_prefix(args.source_prefix)
    dest_prefix = _normalize_gs_prefix(args.dest_prefix)

    all_objects = _list_gcs_objects(source_prefix)
    tif_candidates = [
        uri
        for uri in all_objects
        if uri.lower().endswith((".tif", ".tiff")) and fnmatch.fnmatch(Path(uri).name.lower(), args.pattern.lower())
    ]

    if args.max_files is not None:
        tif_candidates = tif_candidates[: max(0, args.max_files)]

    if not tif_candidates:
        print("No matching DEM TIFF files found.")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_file = Path(args.report_file) if args.report_file else Path(f"gcs_dem_cog_conversion_report_{timestamp}.json")

    temp_root = Path(args.tmp_dir) if args.tmp_dir else Path(tempfile.mkdtemp(prefix="cat_gcs_dem_cog_"))
    temp_root.mkdir(parents=True, exist_ok=True)

    print(f"Found {len(tif_candidates)} matching files")
    print(f"Source: {source_prefix}")
    print(f"Destination: {dest_prefix}")
    print(f"Workers: {max(1, args.workers)}")
    print(f"Dry run: {args.dry_run}")

    results: List[JobResult] = []

    try:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = [
                pool.submit(_process_one, src, source_prefix, dest_prefix, args, temp_root)
                for src in tif_candidates
            ]
            for fut in as_completed(futures):
                res = fut.result()
                results.append(res)
                print(f"[{res.status}] {res.source_uri} -> {res.destination_uri}")
                if res.detail:
                    print(f"  {res.detail}")
    finally:
        if not args.keep_temp and args.tmp_dir is None:
            shutil.rmtree(temp_root, ignore_errors=True)

    summary: Dict[str, Any] = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_prefix": source_prefix,
        "dest_prefix": dest_prefix,
        "pattern": args.pattern,
        "dry_run": args.dry_run,
        "overwrite": args.overwrite,
        "workers": max(1, args.workers),
        "max_files": args.max_files,
        "counts": {
            "total_candidates": len(tif_candidates),
            "converted": sum(1 for r in results if r.status == "converted"),
            "planned": sum(1 for r in results if r.status == "planned"),
            "skipped_exists": sum(1 for r in results if r.status == "skipped_exists"),
            "failed": sum(1 for r in results if r.status == "failed"),
        },
        "results": [asdict(r) for r in sorted(results, key=lambda x: x.source_uri)],
    }

    report_file.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Report written: {report_file}")

    if summary["counts"]["failed"] > 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
