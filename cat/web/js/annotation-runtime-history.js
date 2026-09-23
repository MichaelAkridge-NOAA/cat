// Recently deleted / change history panel.
// Every edit, delete and restore of an annotation is copied into
// cat_annotation_history by a database trigger (migration 0018). This panel
// lists those entries for the open project and can put any of them back
// (POST .../annotations/{id}/history/{hid}/restore — a normal versioned
// update, so the restore itself is also recorded and can be undone).
(function () {
  'use strict';

  const OP_LABEL = {
    DELETE: '🗑️ Deleted',
    UPDATE: '✏️ Edited',
    RESTORE: '♻️ Restored',
    HARD_DELETE: '💥 Wiped'
  };

  let filter = 'DELETE';

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function whenText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleString();
  }

  function summary(props) {
    if (!props || typeof props !== 'object') return '';
    const bits = [];
    const sp = props.spcode || props.SPCODE;
    if (sp) bits.push(`<strong>${esc(sp)}</strong>`);
    ['morph_code', 'site', 'transect', 'segment', 'analyst'].forEach(k => {
      if (props[k] != null && props[k] !== '') bits.push(`${esc(k)}: ${esc(props[k])}`);
    });
    return bits.join(' · ') || '<em>no fields</em>';
  }

  function stateBadge(state) {
    if (state === 'live') return '<span style="color:#16a34a;">live now</span>';
    if (state === 'deleted') return '<span style="color:#b91c1c;">deleted now</span>';
    return '<span style="color:#6b7280;">gone</span>';
  }

  function ensureModal() {
    let modal = document.getElementById('catHistoryModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'catHistoryModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:10050;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:min(820px,94vw);max-height:84vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #e5e7eb;">
          <strong style="font-size:15px;flex:1;">🕘 Recently deleted &amp; history</strong>
          <select id="catHistoryFilter" style="font-size:12px;padding:4px 6px;">
            <option value="DELETE">Deleted annotations</option>
            <option value="">All changes</option>
            <option value="UPDATE">Edits</option>
            <option value="RESTORE">Restores</option>
          </select>
          <button id="catHistoryReload" class="cat-btn cat-btn--secondary" style="font-size:12px;padding:4px 10px;">↻</button>
          <button id="catHistoryClose" class="cat-btn cat-btn--secondary" style="font-size:12px;padding:4px 10px;">✕</button>
        </div>
        <div style="padding:8px 16px;font-size:12px;color:#6b7280;border-bottom:1px solid #f1f5f9;">
          Each row is an annotation <em>as it was just before</em> that change. <strong>Restore</strong> puts it back to exactly that state (and undeletes it). Restores are recorded too, so they can be undone the same way.
        </div>
        <div id="catHistoryBody" style="overflow:auto;padding:4px 0;"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeHistory(); });
    modal.querySelector('#catHistoryClose').addEventListener('click', closeHistory);
    modal.querySelector('#catHistoryReload').addEventListener('click', loadHistory);
    modal.querySelector('#catHistoryFilter').addEventListener('change', (e) => { filter = e.target.value; loadHistory(); });
    return modal;
  }

  function closeHistory() {
    const modal = document.getElementById('catHistoryModal');
    if (modal) modal.style.display = 'none';
  }

  async function loadHistory() {
    const body = document.getElementById('catHistoryBody');
    const projectId = (typeof currentProject !== 'undefined' && currentProject) ? currentProject.project_id : null;
    if (!body) return;
    if (!projectId) { body.innerHTML = '<div style="padding:16px;">No project open.</div>'; return; }
    body.innerHTML = '<div style="padding:16px;color:#6b7280;">Loading…</div>';
    try {
      const q = filter ? `?op=${encodeURIComponent(filter)}&limit=300` : '?limit=300';
      const resp = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/history${q}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      render(data.history || []);
    } catch (e) {
      body.innerHTML = `<div style="padding:16px;color:#b91c1c;">Could not load history: ${esc(e.message)}</div>`;
    }
  }

  function render(entries) {
    const body = document.getElementById('catHistoryBody');
    if (!entries.length) {
      body.innerHTML = `<div style="padding:16px;color:#6b7280;">${filter === 'DELETE' ? 'Nothing has been deleted in this project.' : 'No changes recorded yet.'}</div>`;
      return;
    }
    const canRestore = !window.catReadOnly;
    body.innerHTML = entries.map(h => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid #f1f5f9;font-size:12px;">
        <div style="width:92px;flex:none;">${OP_LABEL[h.op] || esc(h.op)}</div>
        <div style="flex:1;min-width:0;">
          <div>#${esc(h.annotation_id)} — ${summary(h.properties)}</div>
          <div style="color:#6b7280;">${esc(whenText(h.changed_at))}${h.changed_by_display_name || h.changed_by_username ? ' by ' + esc(h.changed_by_display_name || h.changed_by_username) : ''} · v${esc(h.version)} · ${stateBadge(h.current_state)}${h.legacy ? ' · <span title="Deleted before change history was kept">earlier deletion</span>' : ''}</div>
        </div>
        ${canRestore ? `<button class="cat-btn cat-btn--secondary" data-restore="${esc(h.annotation_id)}:${esc(h.history_id)}" style="font-size:12px;padding:4px 10px;flex:none;">♻️ Restore</button>` : ''}
      </div>`).join('');
    body.querySelectorAll('[data-restore]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [aid, hid] = btn.dataset.restore.split(':');
        restoreEntry(aid, hid, btn);
      });
    });
  }

  async function restoreEntry(annotationId, historyId, btn) {
    const projectId = currentProject && currentProject.project_id;
    if (!projectId) return;
    const ok = (typeof catConfirm === 'function')
      ? await catConfirm(`Restore annotation #${annotationId} to this earlier state?`, { ok: 'Restore' })
      : true;
    if (!ok) return;
    if (btn) btn.disabled = true;
    try {
      // No history id = deleted before history was recorded (older
      // version); the row itself is still there, so plain undelete it.
      const url = historyId
        ? `${window.location.origin}/api/db/projects/${projectId}/annotations/${annotationId}/history/${historyId}/restore`
        : `${window.location.origin}/api/db/projects/${projectId}/annotations/${annotationId}/restore`;
      const resp = await fetch(url, { method: 'POST' });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error((typeof e.detail === 'string' && e.detail) || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      showStatus(data.recreated
        ? `♻️ Restored as new annotation #${data.annotation.annotation_id}`
        : `♻️ Restored annotation #${annotationId}`, 'success');
      // Pull the restored annotation into the map/table (the refresh saves
      // any pending local edits first and never discards them).
      if (typeof refreshAnnotations === 'function') await refreshAnnotations({ auto: true });
      if (window._catChannel) window._catChannel.postMessage({ type: 'annotations-changed', project_id: projectId });
      loadHistory();
    } catch (e) {
      showStatus(`❌ Restore failed: ${e.message}`, 'error');
      if (btn) btn.disabled = false;
    }
  }

  window.catOpenHistoryPanel = function () {
    const modal = ensureModal();
    const sel = modal.querySelector('#catHistoryFilter');
    if (sel) sel.value = filter;
    modal.style.display = 'flex';
    loadHistory();
  };
})();
