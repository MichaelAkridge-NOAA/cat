// View-only mode for the annotation page.
//
// Every signed-in user may open any project, but only its owner, added
// editors and admins may change it (enforced server-side in
// cat/api/db_projects.py). When GET .../snapshot reports my_role === 'viewer',
// annotation-runtime-project-layers.js sets window.catReadOnly and calls
// catApplyReadOnlyMode(): the edit controls are hidden and a banner offers
// "Duplicate to my projects", which makes an editable copy owned by the viewer.
// Personal display settings (layer colors, opacity, visibility) are client-side
// and stay fully usable.

(function () {
  'use strict';

  var STYLE_ID = 'catReadOnlyStyle';
  var BANNER_ID = 'catReadOnlyBanner';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      // Edit-only controls. The server rejects writes regardless; this just
      // keeps the UI honest.
      'body.cat-readonly .leaflet-draw,' +
      'body.cat-readonly #saveProjectBtn,' +
      'body.cat-readonly #annotationFormPanel { display: none !important; }' +
      '#' + BANNER_ID + ' { position: fixed; top: env(safe-area-inset-top, 0px); left: 50%;' +
      ' transform: translateX(-50%); z-index: 2500; display: flex; align-items: center; gap: 10px;' +
      ' flex-wrap: wrap; max-width: calc(100vw - 32px); padding: 8px 12px; border-radius: 8px;' +
      ' background: #fff8e1; color: #5f4b00; border: 1px solid #f0d878;' +
      ' box-shadow: 0 2px 8px rgba(0,0,0,.18); font: 13px/1.3 system-ui, sans-serif; }' +
      '#' + BANNER_ID + ' button { font: inherit; padding: 5px 10px; border-radius: 6px; cursor: pointer;' +
      ' border: 1px solid #b58900; background: #fff; color: #5f4b00; }' +
      '#' + BANNER_ID + ' button.primary { background: #005ea2; border-color: #005ea2; color: #fff; }' +
      '#' + BANNER_ID + ' button:disabled { opacity: .6; cursor: default; }';
    document.head.appendChild(style);
  }

  async function duplicate(projectId, projectName, btn) {
    var suggested = projectName + ' (copy)';
    var entered = window.prompt(
      'Duplicate "' + projectName + '" into your projects.\n\nName for your copy:',
      suggested
    );
    if (entered === null) return;
    btn.disabled = true;
    btn.textContent = 'Duplicating…';
    try {
      var resp = await fetch('/api/db/projects/' + encodeURIComponent(projectId) + '/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only send a name the user actually changed; otherwise the server
        // picks the first free "(copy)", "(copy 2)", ...
        body: JSON.stringify({ new_name: entered.trim() && entered.trim() !== suggested ? entered.trim() : null })
      });
      if (!resp.ok) {
        var err = await resp.json().catch(function () { return {}; });
        throw new Error(err.detail || ('HTTP ' + resp.status));
      }
      var data = await resp.json();
      window.location.href = '/annotation.html?project_id=' + encodeURIComponent(data.project.project_id);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Duplicate to my projects';
      window.alert('Failed to duplicate project: ' + e.message);
    }
  }

  window.catApplyReadOnlyMode = function (projectId, project) {
    document.body.classList.add('cat-readonly');
    injectStyle();
    if (document.getElementById(BANNER_ID)) return;

    var name = (project && project.project_name) || ('Project ' + projectId);
    var owner = project && (project.owner_display_name || project.owner_username);

    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      '<span><strong>View only</strong>' +
      (owner ? ' — owned by ' + esc(owner) + '. Ask them to add you as an editor to make changes.' : '.') +
      '</span>' +
      '<button type="button" class="primary" data-act="dup">Duplicate to my projects</button>' +
      '<button type="button" data-act="back">Back to projects</button>';
    banner.querySelector('[data-act="dup"]').addEventListener('click', function (ev) {
      duplicate(projectId, name, ev.currentTarget);
    });
    banner.querySelector('[data-act="back"]').addEventListener('click', function () {
      window.location.href = '/project_creator.html';
    });
    document.body.appendChild(banner);
  };
})();
