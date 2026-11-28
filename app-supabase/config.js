// PRUEBA CON SUPABASE: la misma app, pero los datos vienen de una base de datos en Supabase
// (una parte de la copia de pruebas: 2 cajas y 30 muebles). No toca el Excel ni las otras versiones.
window.ACERVO = {
  api: 'https://pwfbiasfznndbykeubda.supabase.co/functions/v1/acervo',
  clientId: '872173441251-palqgnq6tbtorou3928uqv4s3iicvbg5.apps.googleusercontent.com',
  entorno: 'SUPABASE',
  prefijo: 'acervo-supa'
};
// Un QR de mueble o caja (…?mueble=ACV-0001 / …?caja=CJ-0001) abre directo su ficha.
(function () {
  var p = new URLSearchParams(location.search), m = p.get('mueble'), c = p.get('caja');
  if (m || c) history.replaceState(null, '', location.pathname + (m ? '#/m/' + encodeURIComponent(m) : '#/c/' + encodeURIComponent(c)));
})();
