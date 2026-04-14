"""Batch convert GCS orthomosaic files to COG and upload to a destination GCS prefix.

Workflow per file:
1) Download source GeoTIFF from GCS to local temp directory
2) Convert using existing CAT COG converter (cat.scripts.make_cog)
3) Upload converted COG to destination GCS prefix
4) Remove local temporary files (unless --keep-temp)

Example:
    python -m cat.scripts.convert_gcs_mos_to_cog \
      --source-prefix gs://nmfs_odp_pifsc/PIFSC/ESD/ARP/StRS_Sites_Products/orthomosaic/2025 \
      --dest-prefix gs://nmfs_odp_pifsc/PIFSC/ESD/ARP/StRS_Sites_Products/orthomosaic_cog/2025 \
      --pattern "*mos*.tif" \
      --workers 2 \
      --dry-run
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import fnmatch
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class JobResult:
    source_uri: str
    destination_uri: str
    status: str
    detail: str = ""
    output_local: Optional[str] = None


def _normalize_gs_prefix(prefix: str) -> str:
    p = prefix.strip()
    if not p.startswith("gs://"):
        raise ValueError(f"Expected gs:// prefix, got: {prefix}")
    return p.rstrip("/")


def _run_cmd(cmd: List[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def _resolve_gsutil() -> Optional[str]:
    # On Windows, gsutil is typically exposed as gsutil.cmd
    return shutil.which("gsutil") or shutil.which("gsutil.cmd")


def _list_gcs_objects(source_prefix: str) -> List[str]:
    # gsutil recursive listing using **
    list_target = f"{source_prefix}/**"
    gsutil = _resolve_gsutil()
    if not gsutil:
        raise RuntimeError("gsutil not found in PATH")

    proc = _run_cmd([gsutil, "ls", list_target], check=False)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        if "One or more URLs matched no objects" in stderr:
            return []
        raise RuntimeError(f"Failed to list objects under {source_prefix}: {stderr}")

    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    return [ln for ln in lines if ln.startswith("gs://") and not ln.endswith("/")]


def _object_exists(uri: str) -> bool:
    # -q for quiet; non-zero return code means missing
    gsutil = _resolve_gsutil()
    if not gsutil:
        return False

    proc = _run_cmd([gsutil, "-q", "stat", uri], check=False)
    return proc.returncode == 0


def _make_destination_uri(source_uri: str, source_prefix: str, dest_prefix: str, suffix: str, flat: bool = False) -> str:
    rel = source_uri[len(source_prefix):].lstrip("/")
    rel_path = Path(rel)

    stem = rel_path.stem
    if suffix and not stem.endswith(suffix):
        out_name = f"{stem}{suffix}{rel_path.suffix}"
    else:
        out_name = rel_path.name

    if flat:
        # Drop all subdirectory structure — place file directly in dest_prefix
        return f"{dest_prefix}/{out_name}"

    out_rel = str(rel_path.with_name(out_name)).replace("\\", "/")
    return f"{dest_prefix}/{out_rel}"


def _build_conversion_cmd(src_local: Path, dst_local: Path, args: argparse.Namespace) -> List[str]:
    cmd = [
        sys.executable,
        "-m",
        "cat.scripts.make_cog",
        "--src",
        str(src_local),
        "--dst",
        str(dst_local),
        "--resampling",
        args.resampling,
    ]

    if args.profile:
        cmd.extend(["--profile", args.profile])
    if args.quality is not None:
        cmd.extend(["--quality", str(args.quality)])
    if args.nodata is not None:
        cmd.extend(["--nodata", str(args.nodata)])
    if args.web_optimized:
        cmd.append("--web-optimized")
    if args.no_reproject:
        cmd.append("--no-reproject")

    return cmd


def _run_conversion_with_fallback(src_local: Path, dst_local: Path, args: argparse.Namespace) -> subprocess.CompletedProcess:
    """Run conversion and retry without reprojection for unsupported CRS transforms."""
    convert_cmd = _build_conversion_cmd(src_local, dst_local, args)
    conv = _run_cmd(convert_cmd, check=False)
    if conv.returncode == 0:
        return conv

    # Retry only when reprojection failure is detected and we didn't already disable reprojection.
    combined_output = f"{conv.stdout or ''}\n{conv.stderr or ''}"
    reproj_error_markers = [
        "Cannot find coordinate operations",
        "rasterio.errors.CRSError",
        "EngineeringCRS",
    ]
    should_retry_no_reproject = (not args.no_reproject) and any(m in combined_output for m in reproj_error_markers)

    if not should_retry_no_reproject:
        return conv

    retry_cmd = list(convert_cmd)
    if "--no-reproject" not in retry_cmd:
        retry_cmd.append("--no-reproject")

    retry = _run_cmd(retry_cmd, check=False)
    if retry.returncode == 0:
        # Preserve context that fallback was used
        retry.stdout = (retry.stdout or "") + "\nINFO: Retried conversion with --no-reproject due to unsupported CRS transform.\n"
    return retry


def _process_one(source_uri: str, source_prefix: str, dest_prefix: str, args: argparse.Namespace, temp_root: Path) -> JobResult:
    destination_uri = _make_destination_uri(source_uri, source_prefix, dest_prefix, args.suffix, flat=args.flat)

    if (not args.overwrite) and _object_exists(destination_uri):
        return JobResult(source_uri, destination_uri, "skipped_exists", "Destination object already exists")

    if args.dry_run:
        return JobResult(source_uri, destination_uri, "planned", "Dry-run")

    # Create per-file temp workspace
    safe_name = source_uri.replace("gs://", "").replace("/", "_")
    work_dir = temp_root / safe_name
    work_dir.mkdir(parents=True, exist_ok=True)

    src_local = work_dir / Path(source_uri).name
    dst_local = work_dir / (src_local.stem + args.suffix + src_local.suffix)

    try:
        gsutil = _resolve_gsutil()
        if not gsutil:
            return JobResult(source_uri, destination_uri, "failed", "gsutil not found in PATH")

        # Download
        dl = _run_cmd([gsutil, "cp", source_uri, str(src_local)], check=False)
        if dl.returncode != 0:
            return JobResult(source_uri, destination_uri, "failed", f"Download failed: {(dl.stderr or '').strip()}")

        # Convert
        conv = _run_conversion_with_fallback(src_local, dst_local, args)
        if conv.returncode != 0:
            detail = (conv.stderr or conv.stdout or "").strip()
            return JobResult(source_uri, destination_uri, "failed", f"Conversion failed: {detail}")

        # Upload
        ul = _run_cmd([gsutil, "cp", str(dst_local), destination_uri], check=False)
        if ul.returncode != 0:
            return JobResult(source_uri, destination_uri, "failed", f"Upload failed: {(ul.stderr or '').strip()}")

        return JobResult(source_uri, destination_uri, "converted", output_local=str(dst_local))
    finally:
        if not args.keep_temp:
            shutil.rmtree(work_dir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert GCS orthomosaics to COG and upload to GCS destination")
    p.add_argument("--source-prefix", required=True, help="Source GCS prefix (gs://.../orthomosaic/2025)")
    p.add_argument("--dest-prefix", required=True, help="Destination GCS prefix (gs://.../orthomosaic_cog/2025)")
    p.add_argument("--pattern", default="*mos*.tif", help="Filename glob filter (default: *mos*.tif)")
    p.add_argument("--suffix", default="_cog", help="Suffix for output files (default: _cog)")
    p.add_argument("--workers", type=int, default=1, help="Parallel workers (default: 1)")
    p.add_argument("--max-files", type=int, default=None, help="Process at most N matched files (useful for pilot runs)")
    p.add_argument("--tmp-dir", default=None, help="Optional temp root directory")
    p.add_argument("--report-file", default=None, help="Output JSON report path")
    p.add_argument("--dry-run", action="store_true", help="Plan only, do not download/convert/upload")
    p.add_argument("--overwrite", action="store_true", help="Overwrite destination files if they exist")
    p.add_argument("--keep-temp", action="store_true", help="Keep local temp files for debugging")
    p.add_argument("--flat", action="store_true", help="Drop subdirectory structure — place all output files directly in dest-prefix")

    # Forwarded to make_cog.py
    p.add_argument("--profile", default=None, help="COG profile: jpeg|lzw|zstd|deflate  (default: zstd for RGB, lzw for single-band)")
    p.add_argument("--quality", type=int, default=None, help="JPEG quality 1-100 (default: 90). Only applies with --profile jpeg.")
    p.add_argument("--nodata", type=float, default=None, help="Nodata for single-band rasters")
    p.add_argument("--resampling", default="bilinear", help="Overview resampling")
    p.add_argument("--web-optimized", action="store_true", help="Use web-optimized layout")
    p.add_argument("--no-reproject", action="store_true", help="Disable auto reprojection to EPSG:4326")

    return p.parse_args()


def main() -> None:
    args = parse_args()

    if not _resolve_gsutil():
        raise SystemExit("gsutil not found in PATH. Install Google Cloud SDK and run `gcloud auth login` / `gcloud auth application-default login` as needed.")

    source_prefix = _normalize_gs_prefix(args.source_prefix)
    dest_prefix = _normalize_gs_prefix(args.dest_prefix)

    all_objects = _list_gcs_objects(source_prefix)
    tif_candidates = [
        uri for uri in all_objects
        if uri.lower().endswith((".tif", ".tiff")) and fnmatch.fnmatch(Path(uri).name.lower(), args.pattern.lower())
    ]

    if args.max_files is not None:
        tif_candidates = tif_candidates[: max(0, args.max_files)]

    if not tif_candidates:
        print("No matching TIFF files found.")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_file = Path(args.report_file) if args.report_file else Path(f"gcs_cog_conversion_report_{timestamp}.json")

    temp_root_path = Path(args.tmp_dir) if args.tmp_dir else Path(tempfile.mkdtemp(prefix="cat_gcs_cog_"))
    temp_root_path.mkdir(parents=True, exist_ok=True)

    print(f"Found {len(tif_candidates)} matching files")
    print(f"Source: {source_prefix}")
    print(f"Destination: {dest_prefix}")
    print(f"Workers: {max(1, args.workers)}")
    print(f"Dry run: {args.dry_run}")

    results: List[JobResult] = []

    try:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = [
                pool.submit(_process_one, src, source_prefix, dest_prefix, args, temp_root_path)
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
            shutil.rmtree(temp_root_path, ignore_errors=True)

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
