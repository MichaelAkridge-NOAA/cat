# Vendored geographic basemap

## world-land-110m.geojson

- **What:** Natural Earth 1:110m land polygons (world coastlines/landmasses), 127 features, WGS84 (CRS84 lon/lat).
- **Use:** offline basemap layer for the `/sites` survey-sites map (rendered as a Leaflet `L.geoJSON` layer beneath the site markers), so the page has geographic context with zero external tile/network requests at runtime.
- **Source:** Natural Earth via the nvkelso/natural-earth-vector repository
  (`geojson/ne_110m_land.geojson`), https://github.com/nvkelso/natural-earth-vector
- **License:** Public domain (Natural Earth). Free to use, modify, redistribute.
