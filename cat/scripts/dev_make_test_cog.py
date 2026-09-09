"""Generate a synthetic RGB COG for QA (no real imagery needed)."""
import argparse
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rio_cogeo.cogeo import cog_translate
from rio_cogeo.profiles import cog_profiles


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/app/data/test_reef_cog.tif")
    args = ap.parse_args()

    w = h = 2048
    # ~40 m square patch on a Hawaiian reef, EPSG:4326
    bounds = (-156.6600, 20.7500, -156.6596, 20.7504)
    transform = from_bounds(*bounds, w, h)

    rng = np.random.default_rng(42)
    yy, xx = np.mgrid[0:h, 0:w]
    base = (128 + 60 * np.sin(xx / 90.0) * np.cos(yy / 70.0)).astype(np.uint8)
    speckle = rng.integers(0, 40, (h, w), dtype=np.uint8)
    r = np.clip(base * 0.4 + speckle, 0, 255).astype(np.uint8)
    g = np.clip(base * 0.8 + speckle, 0, 255).astype(np.uint8)
    b = np.clip(base * 1.0 + speckle // 2, 0, 255).astype(np.uint8)

    tmp = args.out + ".tmp.tif"
    profile = {
        "driver": "GTiff", "width": w, "height": h, "count": 3,
        "dtype": "uint8", "crs": "EPSG:4326", "transform": transform,
    }
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(np.stack([r, g, b]))

    cog_translate(tmp, args.out, cog_profiles.get("deflate"), quiet=True)
    Path(tmp).unlink(missing_ok=True)
    print(f"COG written: {args.out}")


if __name__ == "__main__":
    main()
