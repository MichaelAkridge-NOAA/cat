// Bookmarks: save/restore named map views (center + zoom) per project.
// Stashed directly in the existing free-form currentProject.metadata JSON
// blob — same field and same DB-persist pattern already used by
// saveSpeciesFilters() in annotation-runtime-settings-species.js — so no new
// table or migration is needed for either storage backend.
(function () {
  'use strict';

  function getBookmarks() {
    if (typeof currentProject === 'undefined' || !currentProject) return [];
    return (currentProject.metadata && Array.isArray(currentProject.metadata.bookmarks))
      ? currentProject.metadata.bookmarks
      : [];
  }

  function renderList() {
    const container = document.getElementById('bookmarksListContainer');
    if (!container) return;
    const bookmarks = getBookmarks();
    if (bookmarks.length === 0) {
      container.innerHTML = '<div style="color:#9ca3af; font-size:12px; padding:8px 0;">No bookmarks yet.</div>';
      return;
    }
    container.innerHTML = bookmarks.map((b, i) => `
      <div style="display:flex; align-items:center; gap:8px; padding:7px 4px; border-bottom:1px solid #f1f5f9;">
        <button onclick="if(typeof catGoToBookmark==='function') catGoToBookmark(${i});"
          style="flex:1; text-align:left; background:none; border:none; cursor:pointer; font-size:13px; color:#1e293b; padding:2px 0;"
          title="Zoom: ${Number(b.zoom).toFixed(1)}">📍 ${_escape(b.name)}</button>
        <button onclick="if(typeof catDeleteBookmark==='function') catDeleteBookmark(${i});"
          style="background:none; border:none; color:#dc2626; cursor:pointer; font-size:13px; padding:2px 6px;" title="Delete">✕</button>
      </div>
    `).join('');
  }

  function _escape(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function persist() {
    if (typeof currentProject === 'undefined' || !currentProject) return;
    if (currentProject.project_id && typeof storageBackend !== 'undefined' && storageBackend === 'oracle') {
      try {
        await catFetch(`/api/db/projects/${currentProject.project_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: currentProject.metadata }),
        }, 'Saving bookmarks');
      } catch (e) {
        console.warn('Could not persist bookmarks to DB:', e);
      }
    }
    // File-mode projects are written out through the normal saveProject() flow.
    if (typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = true;
  }

  window.openBookmarksModal = function () {
    renderList();
    const input = document.getElementById('bookmarkNameInput');
    if (input) input.value = '';
    document.getElementById('bookmarksModal').style.display = 'flex';
  };

  window.closeBookmarksModal = function () {
    document.getElementById('bookmarksModal').style.display = 'none';
  };

  window.catSaveBookmark = function () {
    if (typeof map === 'undefined' || !map) return;
    const input = document.getElementById('bookmarkNameInput');
    const name = (input && input.value.trim()) || `View ${getBookmarks().length + 1}`;
    if (typeof currentProject === 'undefined' || !currentProject) {
      if (typeof showStatus === 'function') showStatus('Open a project before saving a bookmark.', 'warning');
      return;
    }
    if (!currentProject.metadata) currentProject.metadata = {};
    if (!Array.isArray(currentProject.metadata.bookmarks)) currentProject.metadata.bookmarks = [];

    const center = map.getCenter();
    currentProject.metadata.bookmarks.push({
      name,
      lat: center.lat,
      lng: center.lng,
      zoom: map.getZoom(),
      created_at: new Date().toISOString()
    });

    renderList();
    if (input) input.value = '';
    persist();
    if (typeof showStatus === 'function') showStatus(`📍 Bookmark "${name}" saved`, 'success');
  };

  window.catGoToBookmark = function (index) {
    const bookmarks = getBookmarks();
    const b = bookmarks[index];
    if (!b || typeof map === 'undefined' || !map) return;
    map.setView([b.lat, b.lng], b.zoom);
    closeBookmarksModal();
  };

  window.catDeleteBookmark = function (index) {
    if (typeof currentProject === 'undefined' || !currentProject || !currentProject.metadata) return;
    const bookmarks = getBookmarks();
    if (index < 0 || index >= bookmarks.length) return;
    bookmarks.splice(index, 1);
    renderList();
    persist();
  };
})();
