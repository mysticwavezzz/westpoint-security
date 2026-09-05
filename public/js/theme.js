// Applies the stored/preferred theme immediately (before paint, to avoid a
// flash of the wrong theme), then injects a floating toggle button once the
// DOM is ready. Include this script tag right after the stylesheet <link>
// in <head> on every public page.
(function () {
  try {
    var stored = localStorage.getItem('wp-theme');
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();

function wpToggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var isDark = current === 'dark' || (!current && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('wp-theme', next); } catch (e) {}
  var btn = document.getElementById('wpThemeToggleBtn');
  if (btn) btn.textContent = next === 'dark' ? '☀' : '☾';
}

document.addEventListener('DOMContentLoaded', function () {
  var btn = document.createElement('button');
  btn.id = 'wpThemeToggleBtn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle dark mode');
  var current = document.documentElement.getAttribute('data-theme');
  var isDark = current === 'dark' || (!current && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  btn.textContent = isDark ? '☀' : '☾';
  btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:200;width:34px;height:34px;border-radius:50%;border:1px solid #788A99;background:#2F3B47;color:#fff;font-size:15px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
  btn.onclick = wpToggleTheme;
  document.body.appendChild(btn);
});
