// Tile request queue for CAT's own imagery tiles (TiTiler /tiles/...).
//
// Zooming or panning over a COG made Leaflet request every visible tile at
// once — plus the minimap's copy, plus the intermediate zoom levels during
// the zoom animation. Each tile is real decode/reprojection work on the
// server (cat-app hit ~140% CPU and tiles took 6-7 s in those bursts). This
// module:
//   * caps how many CAT tiles load at the same time (MAX_CONCURRENT);
//   * skips queued tiles that have already left the view (Leaflet removed
//     them after a pan/zoom) instead of requesting them anyway;
//   * stops loading tiles for intermediate zoom levels mid-animation.
// External basemaps (OSM etc.) are left alone. Load after leaflet.js.
(function () {
  'use strict';
  if (!window.L || !L.TileLayer) return;

  const MAX_CONCURRENT = 10;
  const isCatTileUrl = (url) => typeof url === 'string' && url.indexOf('/tiles/') !== -1;

  const queue = [];   // { img, url }
  let active = 0;
  const stats = { requested: 0, skipped: 0, completed: 0, maxQueue: 0 };

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      // Leaflet detaches tiles that scrolled/zoomed out of view; a tile that
      // was attached and is now detached is no longer wanted.
      if (job.img._catWasAttached && !job.img.isConnected) {
        stats.skipped++;
        job.img._catSkipped = true;
        continue;
      }
      active++;
      stats.requested++;
      job.img._catLoading = true;
      job.img.src = job.url;
    }
  }

  function release(img) {
    if (!img._catLoading) return;
    img._catLoading = false;
    active = Math.max(0, active - 1);
    stats.completed++;
    pump();
  }

  const proto = L.TileLayer.prototype;
  const originalCreateTile = proto.createTile;

  proto.createTile = function (coords, done) {
    const url = this.getTileUrl(coords);
    if (!isCatTileUrl(url)) return originalCreateTile.call(this, coords, done);

    const img = document.createElement('img');
    L.DomEvent.on(img, 'load', (e) => { release(img); this._tileOnLoad(done, img, e); });
    L.DomEvent.on(img, 'error', (e) => {
      // Leaflet aborts removed tiles by setting src to an empty image; that
      // also lands here and must free the slot.
      release(img);
      this._tileOnError(done, img, e);
    });
    if (this.options.crossOrigin || this.options.crossOrigin === '') {
      img.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
    }
    if (typeof this.options.referrerPolicy === 'string') img.referrerPolicy = this.options.referrerPolicy;
    img.alt = '';
    img.setAttribute('role', 'presentation');

    queue.push({ img, url });
    stats.maxQueue = Math.max(stats.maxQueue, queue.length);
    // Leaflet appends the tile right after createTile returns; mark it so a
    // later detach can be recognised, then let the queue run.
    setTimeout(() => {
      if (img.isConnected) img._catWasAttached = true;
      pump();
    }, 0);
    return img;
  };

  // A tile Leaflet removes before its request finished: free the slot now
  // rather than waiting for the (aborted) load/error event.
  const originalRemoveTile = L.GridLayer.prototype._removeTile;
  L.GridLayer.prototype._removeTile = function (key) {
    const tile = this._tiles && this._tiles[key];
    if (tile && tile.el && tile.el._catLoading) release(tile.el);
    return originalRemoveTile.call(this, key);
  };

  // Don't fetch tiles for the in-between zoom levels while a zoom animation
  // runs; load once the zoom settles.
  L.TileLayer.mergeOptions({ updateWhenZooming: false });

  window.catTileQueueStats = function () {
    return Object.assign({ active, queued: queue.length, maxConcurrent: MAX_CONCURRENT }, stats);
  };
})();
