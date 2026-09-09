window._catPopoutMode = new URLSearchParams(window.location.search).get('cat_popout') || null;
    if (window._catPopoutMode) {
      document.documentElement.classList.add('cat-popout-' + window._catPopoutMode);

      // Elements that MUST stay visible/functional inside the popout. Everything
      // else under <body> is hidden. Allowlist (not denylist) so panels added
      // later can never leak into the popout — this is the root-cause fix for the
      // recurring "sidebar still visible in popout" bug.
      var KEEP_IDS = ['annotationFormPanel', 'toastContainer', 'catConfirmOverlay'];

      // Layer 1: inject a <style> so hiding applies before elements render. Hide all
      // direct children of <body>, then un-hide the keep-set; force the form panel to
      // fill the popout window.
      // Blanket-hide every body child EXCEPT the keep-set. We deliberately do NOT
      // force `display: revert` onto the keep-set: doing so overrode #catConfirmOverlay's
      // inline `display:none`, so an empty confirm modal was permanently painted over the
      // popout (verified). Only #annotationFormPanel is force-shown; #toastContainer and
      // #catConfirmOverlay keep their own display logic (hidden until actually invoked).
      var _ps = document.createElement('style');
      _ps.id = 'cat-popout-style';
      _ps.textContent =
        'body > *' + KEEP_IDS.map(function(id){ return ':not(#' + id + ')'; }).join('') +
        '{display:none!important}' +
        '#annotationFormPanel{display:block!important;position:static!important;' +
        'max-height:none!important;min-height:100vh;width:100%;overflow-y:auto;' +
        'border-radius:0!important;box-shadow:none!important;padding:16px!important}' +
        'body{overflow:auto!important;background:#f0f4ff!important;height:auto!important}';
      document.head.appendChild(_ps);

      // Layer 2: after DOM is ready, enforce with inline styles so nothing re-shows a
      // hidden element, and strip layout modes so no docked-sidebar CSS applies.
      document.addEventListener('DOMContentLoaded', function() {
        document.body.classList.remove('layout-docked', 'layout-float');
        var keep = {};
        KEEP_IDS.forEach(function(id){ var el = document.getElementById(id); if (el) keep[id] = el; });
        Array.prototype.forEach.call(document.body.children, function(child) {
          var isKeep = Object.keys(keep).some(function(id){ return keep[id] === child || (keep[id] && keep[id].contains && keep[id] === child); });
          if (!isKeep) child.style.setProperty('display', 'none', 'important');
        });
        var panel = document.getElementById('annotationFormPanel');
        if (panel) {
          panel.style.setProperty('display', 'block', 'important');
          panel.style.setProperty('position', 'static', 'important');
          panel.style.setProperty('max-height', 'none', 'important');
          panel.style.setProperty('min-height', '100vh', 'important');
          panel.style.setProperty('width', '100%', 'important');
          panel.style.setProperty('overflow-y', 'auto', 'important');
          panel.style.setProperty('border-radius', '0', 'important');
          panel.style.setProperty('box-shadow', 'none', 'important');
          panel.style.setProperty('padding', '16px', 'important');
        }
        document.body.style.setProperty('overflow', 'auto', 'important');
        document.body.style.setProperty('background', '#f0f4ff', 'important');
      });
    }
