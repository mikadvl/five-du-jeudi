// Applique le thème choisi (clair / sombre / auto) avant l'affichage, pour éviter un flash.
(function () {
  try {
    var t = localStorage.getItem('fdj-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {
    /* stockage indisponible : thème automatique */
  }
})();
