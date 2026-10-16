// Se ejecuta antes de pintar para evitar el parpadeo de tema.
(function () {
  var t = null;
  try {
    t = localStorage.getItem('codesala:theme');
  } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = t;
})();
