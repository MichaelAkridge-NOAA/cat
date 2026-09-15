/**
 * CAT shared auth helpers (Oracle mode only).
 *
 * No dependencies, no external network requests. Every call is same-origin
 * against /api/config and /api/auth/*. Pages that don't need login checks
 * (file-mode installs) never call /api/auth/* because /api/config's
 * `auth_enabled` flag is always checked first.
 *
 * Include AFTER cat-nav.js if you want the nav bar's user menu populated:
 *     <script src="js/cat-nav.js"></script>
 *     <script src="js/cat-auth.js"></script>
 */
(function (global) {
  'use strict';

  var _configPromise = null;
  var _userPromise = null;

  function getConfig() {
    if (!_configPromise) {
      _configPromise = fetch('/api/config').then(function (r) { return r.json(); }).catch(function () {
        return { auth_enabled: false };
      });
    }
    return _configPromise;
  }

  function fetchCurrentUser(force) {
    if (force) _userPromise = null;
    if (!_userPromise) {
      _userPromise = getConfig().then(function (config) {
        if (!config.auth_enabled) return null;
        return fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) return null;
          return r.json();
        }).then(function (data) {
          return data && data.user ? data : null;
        }).catch(function () { return null; });
      });
    }
    return _userPromise;
  }

  function requireLogin(loginPath) {
    return fetchCurrentUser().then(function (data) {
      return getConfig().then(function (config) {
        if (config.auth_enabled && !data) {
          var next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = (loginPath || '/login.html') + '?next=' + next;
          return null;
        }
        return data ? data.user : null;
      });
    });
  }

  function requireAdmin(loginPath) {
    return requireLogin(loginPath).then(function (user) {
      if (user && user.role !== 'admin') {
        window.location.href = '/';
        return null;
      }
      return user;
    });
  }

  function logout() {
    return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
      _userPromise = null;
      window.location.href = '/';
    });
  }

  function renderNavUser() {
    var inner = document.querySelector('.cat-topnav-inner');
    if (!inner) return;

    getConfig().then(function (config) {
      if (!config.auth_enabled) return;
      fetchCurrentUser().then(function (data) {
        var links = inner.querySelector('.cat-topnav-links');
        if (!links) return;

        var menu = document.createElement('span');
        menu.className = 'cat-topnav-user';

        if (data && data.user) {
          var name = document.createElement('span');
          name.textContent = data.user.display_name || data.user.username;
          menu.appendChild(name);

          if (data.user.role === 'admin') {
            var adminLink = document.createElement('a');
            adminLink.href = '/user_admin.html';
            adminLink.className = 'cat-topnav-link';
            adminLink.textContent = 'Users';
            menu.appendChild(adminLink);

            var debugLink = document.createElement('a');
            debugLink.href = '/debug_stats.html';
            debugLink.className = 'cat-topnav-link';
            debugLink.textContent = 'Debug';
            menu.appendChild(debugLink);
          }

          var prefsLink = document.createElement('a');
          prefsLink.href = '/user_preferences.html';
          prefsLink.className = 'cat-topnav-link';
          prefsLink.textContent = 'Preferences';
          menu.appendChild(prefsLink);

          var logoutLink = document.createElement('a');
          logoutLink.href = '#';
          logoutLink.className = 'cat-topnav-link';
          logoutLink.textContent = 'Log out';
          logoutLink.addEventListener('click', function (e) {
            e.preventDefault();
            logout();
          });
          menu.appendChild(logoutLink);
        } else {
          var loginLink = document.createElement('a');
          loginLink.href = '/login.html';
          loginLink.className = 'cat-topnav-link';
          loginLink.textContent = 'Log in';
          menu.appendChild(loginLink);
        }

        links.appendChild(menu);
      });
    });
  }

  global.CatAuth = {
    getConfig: getConfig,
    fetchCurrentUser: fetchCurrentUser,
    requireLogin: requireLogin,
    requireAdmin: requireAdmin,
    logout: logout
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNavUser);
  } else {
    renderNavUser();
  }
})(window);
