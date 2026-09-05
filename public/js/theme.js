// Westpoint Security - Public Site Theme Toggle (Dark / Light)
(function() {
  // 1. Run synchronously before paint to prevent theme flash
  try {
    var savedTheme = localStorage.getItem('wp-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
  } catch (e) {}

  // 2. Inject floating toggle button on DOM ready
  function initThemeToggle() {
    if (document.getElementById('wpThemeToggleBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'wpThemeToggleBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle Dark / Light Theme');
    btn.style.position = 'fixed';
    btn.style.bottom = '12px';
    btn.style.right = '12px';
    btn.style.zIndex = '200';
    btn.style.background = '#1E252D';
    btn.style.color = '#FFFFFF';
    btn.style.border = '1px solid #788A99';
    btn.style.borderRadius = '3px';
    btn.style.padding = '5px 9px';
    btn.style.fontSize = '11px';
    btn.style.fontWeight = 'bold';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.3)';
    btn.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';

    function updateBtnLabel() {
      var current = document.documentElement.getAttribute('data-theme');
      if (!current) {
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        current = prefersDark ? 'dark' : 'light';
      }
      btn.innerHTML = current === 'dark' ? '&#9728; Light' : '&#9790; Dark';
    }

    btn.onclick = function() {
      var current = document.documentElement.getAttribute('data-theme');
      if (!current) {
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        current = prefersDark ? 'dark' : 'light';
      }
      var nextTheme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', nextTheme);
      try {
        localStorage.setItem('wp-theme', nextTheme);
      } catch (e) {}
      updateBtnLabel();
    };

    updateBtnLabel();
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeToggle);
  } else {
    initThemeToggle();
  }
})();
