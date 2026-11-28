// Acervo · PRUEBA en Supabase.
// Hace lo mismo que la app web de Apps Script (mismas acciones, mismas respuestas), pero leyendo y escribiendo
// en la base de datos de Supabase. Así la app del teléfono funciona igual, solo cambia la dirección a la que habla.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const URL_FOTOS = Deno.env.get('SUPABASE_URL') + '/storage/v1/object/public/fotos/';

const APP_CLIENT_ID = '872173441251-palqgnq6tbtorou3928uqv4s3iicvbg5.apps.googleusercontent.com';
const DIAS_SESION = 14;
const ESTADOS_ANTES = ['Buen estado', 'Mal estado', 'Se debe mandar a reparación', 'En reparación'];
const QR_NUEVOS = 'https://thorfilo2612.github.io/acervo-fichas/app-supabase/';   // QR de los muebles agregados en la prueba
// Solo para traer datos de la copia de pruebas: se comprueba que quien importa sea administrador allá.
const API_COPIA = 'https://script.google.com/macros/s/AKfycbwx_rFeDy8-UIIB5uCBxI5gdpmi-DaTvXYKiYwgbOqeOzJxO6X-rngRspN42sTqApAu3g/exec';
const FOTO_MAX = 2000000;
const NO_DISPONIBLE = 'Esto todavía no está en la prueba con Supabase (por ahora: ver, agregar, entrada, salida, mover y cambiar estado).';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
};

class ErrorApp extends Error {
  codigo?: string;
  constructor(m: string, codigo?: string) { super(m); this.codigo = codigo; }
}
const limpio = (x: unknown) => String(x === undefined || x === null ? '' : x).replace(/\s+/g, ' ').trim();
const lower = (x: unknown) => limpio(x).toLowerCase();
const falla = (r: { error: { message: string } | null }) => { if (r.error) throw new ErrorApp(r.error.message); };

/* ---------- Ajustes (en memoria unos segundos) ---------- */
type Listas = { ubicaciones: string[]; depositos: { nombre: string; ubic: string }[]; tipos: string[]; categorias: string[]; estados: string[] };
type Caja = { codigo: string; nombre: string; almacen: string; deposito: string; qr: string };
type Admin = { email: string; nombre: string; rol: string; activo: boolean };
const memo: Record<string, { t: number; v: unknown }> = {};
async function enMemoria<T>(k: string, seg: number, fn: () => Promise<T>): Promise<T> {
  const x = memo[k];
  if (x && Date.now() - x.t < seg * 1000) return x.v as T;
  const v = await fn();
  memo[k] = { t: Date.now(), v };
  return v;
}
const olvidar = () => { for (const k of Object.keys(memo)) if (k !== 'clave') delete memo[k]; };

const claveSesion = () => enMemoria('clave', 3600, async () => {
  const r = await db.from('ajustes').select('valor').eq('clave', 'clave_sesion').single(); falla(r);
  return String(r.data!.valor);
});
const listas = () => enMemoria('listas', 20, async (): Promise<Listas> => {
  const r = await db.from('ajustes').select('valor').eq('clave', 'listas').single(); falla(r);
  const v = r.data!.valor || {};
  return { ubicaciones: v.ubicaciones || [], depositos: v.depositos || [], tipos: v.tipos || [], categorias: v.categorias || [], estados: v.estados || [] };
});
const cajasTodas = () => enMemoria('cajas', 20, async (): Promise<Caja[]> => {
  const r = await db.from('cajas').select('codigo,nombre,almacen,deposito,qr').order('orden'); falla(r);
  return r.data as Caja[];
});
const admins = () => enMemoria('admins', 30, async (): Promise<Admin[]> => {
  const r = await db.from('admins').select('email,nombre,rol,activo'); falla(r);
  return r.data as Admin[];
});

/* ---------- Sesión ---------- */
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
async function firma(datos: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(await claveSesion()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(datos))));
}
async function datosUsuario(email: string) {
  const a = (await admins()).find(x => x.email === email);
  return { email, nombre: a ? (a.nombre || email.split('@')[0]) : email.split('@')[0], rol: a ? a.rol : 'Administrador' };
}
const permitido = async (email: string) => !!email && (await admins()).some(a => a.email === email && a.activo);

async function entrar(idToken: string) {
  if (!idToken) throw new ErrorApp('Falta el inicio de sesión de Google.');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (r.status !== 200) throw new ErrorApp('Google no reconoció el inicio de sesión. Vuelve a intentarlo.');
  const t = await r.json();
  if (t.aud !== APP_CLIENT_ID) throw new ErrorApp('Inicio de sesión no válido para esta app.');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(t.iss) < 0) throw new ErrorApp('Inicio de sesión no válido.');
  if (String(t.email_verified) !== 'true') throw new ErrorApp('Tu correo de Google no está verificado.');
  if (Number(t.exp) * 1000 < Date.now()) throw new ErrorApp('El inicio de sesión caducó. Vuelve a entrar.');
  const email = lower(t.email);
  if (!(await permitido(email))) throw new ErrorApp('La cuenta ' + email + ' no tiene acceso a Acervo. Pide al administrador que te agregue.', 'sin_acceso');
  const datos = email + '|' + (Date.now() + DIAS_SESION * 86400000);
  const sesion = b64url(new TextEncoder().encode(datos)) + '.' + await firma(datos);
  return Object.assign({ ok: true, sesion, foto: t.picture || '' }, await sesionDatos(await datosUsuario(email)));
}

async function usuario(sesion: string) {
  const malo = () => new ErrorApp('Tu sesión terminó. Vuelve a entrar.', 'sesion');
  const partes = String(sesion || '').split('.');
  if (partes.length !== 2) throw malo();
  let datos = '';
  try { datos = deB64url(partes[0]); } catch { throw malo(); }
  if (await firma(datos) !== partes[1]) throw malo();
  const [email, vence] = datos.split('|');
  if (!(Number(vence) > Date.now())) throw malo();
  if (!(await permitido(email))) throw new ErrorApp('Tu cuenta ya no tiene acceso.', 'sin_acceso');
  return datosUsuario(email);
}

async function sesionDatos(u: { email: string; nombre: string; rol: string }) {
  const [l, cajas] = await Promise.all([listas(), cajasTodas()]);
  return {
    usuario: u,
    listas: {
      ubicaciones: l.ubicaciones, depositos: l.depositos, tipos: l.tipos, categorias: l.categorias, estados: l.estados.slice(),
      cajas: cajas.map(c => ({ codigo: c.codigo, nombre: c.nombre, almacen: c.almacen, deposito: c.deposito })),
    },
  };
}

/* ---------- Lugares ---------- */
type L = { ubic: string; dep: string; caja: string; lugar: string };
function lugarTexto(x: { ubic: string; dep: string; caja: string }, cajas: Caja[]) {
  if (!x.caja) return x.ubic + (x.dep ? ' · ' + x.dep : '');
  const c = cajas.find(k => lower(k.codigo) === lower(x.caja));
  const ub = c ? c.almacen : x.ubic, dp = c ? c.deposito : x.dep;
  return 'Caja ' + x.caja + (c && c.nombre ? ' (' + c.nombre + ')' : '') + ' · ' + ub + (dp ? ' · ' + dp : '');
}
function codigoDeCajaEnTexto(texto: string, cajas: Caja[]) {
  const t = limpio(texto);
  if (!t) return '';
  let m = t.match(/[?&]caja=([^&#\s]+)/i);
  if (m) return decodeURIComponent(m[1]);
  m = t.match(/^caja\s+(\S+)/i);
  if (m) return m[1];
  const primero = t.split(/\s+·\s+|\s+/)[0];
  return cajas.some(c => lower(c.codigo) === lower(primero)) ? primero : '';
}
const codigoDeTexto = (texto: string) => { const t = limpio(texto); const m = t.match(/[?&]mueble=([^&#\s]+)/i); return m ? decodeURIComponent(m[1]) : t; };

async function parseLugar(texto: unknown, depTexto: unknown): Promise<L> {
  const t = limpio(texto);
  if (!t) throw new ErrorApp('Falta el lugar.');
  const [cajas, l] = await Promise.all([cajasTodas(), listas()]);
  const cod = codigoDeCajaEnTexto(t, cajas);
  if (cod) {
    const c = cajas.find(k => lower(k.codigo) === lower(cod));
    if (!c) throw new ErrorApp('No existe la caja ' + cod + '.');
    const x = { ubic: c.almacen, dep: c.deposito, caja: c.codigo };
    return Object.assign(x, { lugar: lugarTexto(x, cajas) });
  }
  let ubTxt = t, dpTxt = limpio(depTexto);
  const partes = t.split(/\s+·\s+/);
  if (partes.length === 2 && !dpTxt) { ubTxt = partes[0]; dpTxt = partes[1]; }
  const alm = l.ubicaciones.find(u => lower(u) === lower(ubTxt));
  if (!alm) throw new ErrorApp('«' + ubTxt + '» no es una ubicación de la lista ni una caja.');
  let dep = '';
  if (dpTxt) {
    const d = l.depositos.find(x => lower(x.nombre) === lower(dpTxt) && lower(x.ubic) === lower(alm));
    if (!d) throw new ErrorApp('El depósito «' + dpTxt + '» no pertenece a ' + alm + '.');
    dep = d.nombre;
  }
  return { ubic: alm, dep, caja: '', lugar: alm + (dep ? ' · ' + dep : '') };
}
const mismoLugar = (a: L, b: L) => (a.caja || b.caja) ? lower(a.caja) === lower(b.caja) : lower(a.ubic) === lower(b.ubic) && lower(a.dep) === lower(b.dep);

/* ---------- Lecturas ---------- */
const COLS = 'codigo,nombre,tipo,categoria,material,medidas,color,descripcion,foto_catalogo,foto_real,qr,orden';
type Fila = Record<string, any>;

function armarMuebles(filas: Fila[], lugares: Fila[], estados: string[], cajas: Caja[]) {
  const porCod: Record<string, any> = {};
  const lista = filas.map(r => {
    const m = {
      codigo: r.codigo, nombre: r.nombre, tipo: r.tipo, categoria: r.categoria, material: r.material, medidas: r.medidas,
      color: r.color, descripcion: r.descripcion, foto: '', conFoto: !!(r.foto_catalogo || r.foto_real),
      total: 0, estados: estados.map(() => 0), lugares: [] as any[], qr: r.qr,
    };
    porCod[r.codigo] = m;
    return m;
  });
  for (const l of lugares) {
    const m = porCod[l.codigo];
    if (!m) continue;
    const num = estados.map(e => Number((l.cant || {})[e]) || 0);
    const t = num.reduce((a, b) => a + b, 0);
    m.total += t;
    num.forEach((n, j) => { m.estados[j] += n; });
    m.lugares.push({ ubic: l.ubic, dep: l.dep, caja: l.caja, texto: lugarTexto(l as any, cajas), num, total: t });
  }
  return lista;
}

async function leerInventario(codigo?: string) {
  let q = db.from('muebles').select(COLS).order('orden');
  let ql = db.from('lugares').select('codigo,ubic,dep,caja,cant').order('id');
  if (codigo) { q = q.ilike('codigo', codigo.replace(/[%_\\]/g, '\\$&')); }
  const [rm, rl, l, cajas] = await Promise.all([q, codigo ? Promise.resolve(null) : ql, listas(), cajasTodas()]);
  falla(rm);
  let lugares: Fila[] = [];
  if (codigo) {
    if (!rm.data!.length) return [];
    const r2 = await db.from('lugares').select('codigo,ubic,dep,caja,cant').eq('codigo', rm.data![0].codigo).order('id'); falla(r2);
    lugares = r2.data!;
  } else { falla(rl!); lugares = rl!.data!; }
  return armarMuebles(rm.data!, lugares, l.estados, cajas);
}

const esReparacion = (e: string) => /repar/.test(lower(e)) && !/mandar/.test(lower(e));
async function resumen(muebles: any[]) {
  const [l, cajas] = await Promise.all([listas(), cajasTodas()]);
  return {
    muebles: muebles.length,
    unidades: muebles.reduce((a, m) => a + m.total, 0),
    cajas: cajas.length,
    porReparar: muebles.reduce((a, m) => a + m.estados.reduce((p: number, n: number, i: number) => p + (esReparacion(l.estados[i]) ? n : 0), 0), 0),
  };
}

function cuandoTexto(iso: string) {   // hora de Caracas (UTC-4), como la muestra el Excel
  const d = new Date(new Date(iso).getTime() - 4 * 3600000);
  return d.toISOString().slice(0, 19);
}
const histDe = (r: Fila) => ({ cuando: cuandoTexto(r.cuando), usuario: r.usuario, codigo: r.codigo, mueble: r.mueble, accion: r.accion, antes: r.antes, despues: r.despues, detalle: r.detalle });
async function historial(codigo: string, limite: number) {
  let q = db.from('historial').select('cuando,usuario,codigo,mueble,accion,antes,despues,detalle').order('cuando', { ascending: false }).order('id', { ascending: false }).limit(Math.min(Number(limite) || 50, 200));
  if (limpio(codigo)) q = q.ilike('codigo', limpio(codigo).replace(/[%_\\]/g, '\\$&'));
  const r = await q; falla(r);
  return { historial: r.data!.map(histDe) };
}

function cajasDe(muebles: any[], cajas: Caja[]) {
  const cuenta: Record<string, { muebles: number; unidades: number }> = {};
  muebles.forEach(m => m.lugares.forEach((l: any) => {
    if (!l.caja) return;
    const k = lower(l.caja);
    cuenta[k] = cuenta[k] || { muebles: 0, unidades: 0 };
    if (l.total > 0) cuenta[k].muebles++;
    cuenta[k].unidades += l.total;
  }));
  return cajas.map(c => Object.assign({ codigo: c.codigo, nombre: c.nombre, almacen: c.almacen, deposito: c.deposito, qr: c.qr }, cuenta[lower(c.codigo)] || { muebles: 0, unidades: 0 }));
}

async function todo(u: any) {
  const [muebles, h, ses, cajas] = await Promise.all([leerInventario(), historial('', 80), sesionDatos(u), cajasTodas()]);
  return Object.assign(ses, { muebles, cajas: cajasDe(muebles, cajas), resumen: await resumen(muebles), historial: h.historial, hora: Date.now() });
}

async function ficha(codigo: string, sinFotos: boolean, tengo: string[]) {
  const cod = limpio(codigoDeTexto(codigo));
  const ms = cod ? await leerInventario(cod) : [];
  const m = ms[0];
  if (!m) throw new ErrorApp('No hay ningún mueble con el código ' + cod + '.', 'no_existe');
  const fotos: any[] = [];
  if (!sinFotos) {
    const r = await db.from('muebles').select('foto_catalogo,foto_real').eq('codigo', m.codigo).single(); falla(r);
    ([['Catálogo', r.data!.foto_catalogo], ['Real', r.data!.foto_real]] as [string, string][]).forEach(([tipo, ruta]) => {
      if (!ruta) return;
      fotos.push((tengo || []).indexOf(ruta) >= 0 ? { tipo, fp: ruta, igual: true } : { tipo, fp: ruta, src: URL_FOTOS + ruta });
    });
  }
  return Object.assign(m, { fotos, enlaceQR: m.qr, historial: (await historial(m.codigo, 15)).historial });
}

async function caja(codigo: string) {
  const cajas = await cajasTodas();
  const cod = codigoDeCajaEnTexto(codigo, cajas) || limpio(codigo);
  const c = cajas.find(k => lower(k.codigo) === lower(cod));
  if (!c) throw new ErrorApp('No existe la caja ' + cod + '.', 'no_existe');
  const [rl, l] = await Promise.all([db.from('lugares').select('codigo,cant,muebles(nombre,tipo,orden)').ilike('caja', c.codigo.replace(/[%_\\]/g, '\\$&')), listas()]);
  falla(rl);
  const items = rl.data!.map((x: any) => {
    const num = l.estados.map(e => Number((x.cant || {})[e]) || 0);
    return { codigo: x.codigo, nombre: x.muebles?.nombre || '', tipo: x.muebles?.tipo || '', num, total: num.reduce((a, b) => a + b, 0), orden: x.muebles?.orden || 0 };
  }).sort((a: any, b: any) => a.orden - b.orden).map(({ orden, ...x }: any) => x);
  return { caja: { codigo: c.codigo, nombre: c.nombre, almacen: c.almacen, deposito: c.deposito,
    lugar: lugarTexto({ ubic: c.almacen, dep: c.deposito, caja: c.codigo }, cajas), enlaceQR: c.qr, contenido: items,
    unidades: items.reduce((a: number, x: any) => a + x.total, 0) } };
}

async function resolver(texto: string) {
  const t = limpio(texto);
  if (!t) throw new ErrorApp('Escribe o escanea un código.');
  const cajas = await cajasTodas();
  const cj = codigoDeCajaEnTexto(t, cajas);
  const c = cj && cajas.find(k => lower(k.codigo) === lower(cj));
  if (c) return { tipo: 'caja', codigo: c.codigo };
  const cod = codigoDeTexto(t).replace(/[%_\\]/g, '\\$&');
  let r = await db.from('muebles').select('codigo').ilike('codigo', cod).limit(1); falla(r);
  if (!r.data!.length) { r = await db.from('muebles').select('codigo').ilike('nombre', cod).limit(1); falla(r); }
  if (r.data!.length) return { tipo: 'mueble', codigo: r.data![0].codigo };
  throw new ErrorApp('No encontré «' + t + '» en el inventario.', 'no_existe');
}

/* ---------- Miniaturas ---------- */
async function minis(tengo: Record<string, string>) {
  tengo = tengo || {};
  const r = await db.from('muebles').select('codigo,mini_v').not('mini', 'is', null).order('orden'); falla(r);
  const hay: Record<string, boolean> = {};
  const cambian = r.data!.filter((x: any) => { const k = lower(x.codigo); hay[k] = true; return tengo[k] !== x.mini_v; }).map((x: any) => x.codigo);
  const quitar = Object.keys(tengo).filter(k => !hay[k]);
  const out: any[] = [];
  let tam = 0, mas = false;
  for (let i = 0; i < cambian.length && !mas; i += 60) {
    const rr = await db.from('muebles').select('codigo,mini_v,mini').in('codigo', cambian.slice(i, i + 60)); falla(rr);
    for (const x of rr.data! as any[]) {
      if (tam > 2500000) { mas = true; break; }
      out.push({ codigo: x.codigo, v: x.mini_v, src: x.mini }); tam += x.mini.length;
    }
  }
  return { minis: out, quitar, mas };
}

async function fotoComoTexto(ruta: string) {
  const r = await db.storage.from('fotos').download(ruta);
  if (r.error || !r.data) return '';
  const b = new Uint8Array(await r.data.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return 'data:' + (r.data.type || 'image/jpeg') + ';base64,' + btoa(s);
}
async function fotosMini(codigos: string[]) {
  const cods = (codigos || []).slice(0, 4).map(limpio);
  const r = await db.from('muebles').select('codigo,foto_catalogo,foto_real').in('codigo', cods); falla(r);
  return { fotos: await Promise.all(cods.map(async c => {
    const m = (r.data as any[]).find(x => lower(x.codigo) === lower(c));
    const ruta = m && (m.foto_catalogo || m.foto_real);
    return { codigo: m ? m.codigo : c, src: ruta ? await fotoComoTexto(ruta) : '' };
  })) };
}
async function guardarMinis(lista: { codigo: string; mini: string }[]) {
  let n = 0;
  for (const x of (lista || []).slice(0, 40)) {
    if (!/^data:image\//.test(x.mini || '') || x.mini.length > 60000) continue;
    const r = await db.from('muebles').update({ mini: x.mini, mini_v: String(Date.now()) }).ilike('codigo', limpio(x.codigo)).select('codigo'); falla(r);
    n += r.data!.length;
  }
  return { ok: true, guardadas: n };
}

/* ---------- Fotos que manda la app ---------- */
async function subirFoto(texto: string, max = FOTO_MAX) {
  const s = String(texto || '');
  if (!s) return '';
  let tipo = 'image/jpeg', bytes: Uint8Array;
  if (/^https?:\/\//.test(s)) {
    const r = await fetch(s);
    if (!r.ok) return '';
    tipo = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    bytes = new Uint8Array(await r.arrayBuffer());
  } else {
    const m = s.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (!m) throw new ErrorApp('La foto no se pudo leer. Toma otra.');
    if (s.length > max) throw new ErrorApp('La foto es demasiado grande. Toma otra.');
    tipo = m[1].toLowerCase();
    bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  }
  if (!/^image\/(jpeg|png|webp|gif)$/.test(tipo)) tipo = 'image/jpeg';
  const ruta = 'm/' + crypto.randomUUID() + '.' + (tipo.split('/')[1] === 'jpeg' ? 'jpg' : tipo.split('/')[1]);
  const r = await db.storage.from('fotos').upload(ruta, bytes, { contentType: tipo, cacheControl: '31536000', upsert: false });
  if (r.error) throw new ErrorApp('No se pudo guardar la foto: ' + r.error.message);
  return ruta;
}

/* ---------- Cambios ---------- */
async function estadosAlDia(ve: unknown) {
  const actual = (await listas()).estados.join('|');
  if (ve === undefined || ve === null) return actual === ESTADOS_ANTES.join('|');
  return String(ve) === actual;
}
function cantidad(x: unknown, msj = 'La cantidad debe ser un número entero mayor que 0.') {
  const n = Number(limpio(x));
  if (!Number.isInteger(n) || n <= 0) throw new ErrorApp(msj);
  return n;
}
async function estadoValido(e: unknown, msj: string) {
  const v = limpio(e);
  const x = (await listas()).estados.find(s => lower(s) === lower(v));
  if (!x) throw new ErrorApp(msj);
  return x;
}
const quien = (u: any) => ({ usuario: u.nombre, correo: u.email });
const rpc = async (fn: string, p: unknown) => { const r = await db.rpc(fn, { p }); falla(r); return r.data as { codigo: string; mensaje: string }; };

async function cambio(q: any, u: any) {
  const n = (x: unknown) => limpio(x);
  if (q.accion === 'entrada' || q.accion === 'salida') {
    const tipo = q.accion === 'entrada' ? 'Entrada' : 'Salida';
    if (!n(q.codigo)) throw new ErrorApp('Escanea o escribe el código, o elige el mueble de la lista.');
    if (!n(q.ubicacion)) throw new ErrorApp(tipo === 'Entrada' ? 'Elige a qué lugar llegan las unidades.' : 'Elige de qué lugar salen las unidades.');
    const L = await parseLugar(q.ubicacion, q.deposito);
    const cant = cantidad(q.cantidad);
    const estado = await estadoValido(q.estado, 'Elige el estado de esas unidades.');
    return rpc('acv_registrar', { ...quien(u), codigo: codigoDeTexto(q.codigo), tipo, ...L, cant, estado, nota: n(q.nota) });
  }
  if (q.accion === 'estado') {
    if (!n(q.codigo)) throw new ErrorApp('Escanea o escribe el código, o elige el mueble de la lista.');
    if (!n(q.ubicacion)) throw new ErrorApp('Elige en qué lugar están esas unidades.');
    const L = await parseLugar(q.ubicacion, q.deposito);
    const de = await estadoValido(q.de, 'Elige en qué estado están ahora («De»).');
    const a = await estadoValido(q.a, 'Elige el nuevo estado («A»).');
    if (de === a) throw new ErrorApp('«De» y «A» son el mismo estado.');
    const cant = cantidad(q.cantidad);
    return rpc('acv_cambiar_estado', { ...quien(u), codigo: codigoDeTexto(q.codigo), ...L, cant, de, a, nota: n(q.nota) });
  }
  if (q.accion === 'mover') {
    if (!n(q.codigo)) throw new ErrorApp('Escanea o escribe el código, o elige el mueble de la lista.');
    if (!n(q.ubicacion)) throw new ErrorApp('Elige desde qué lugar mueves las unidades.');
    if (!n(q.hacia)) throw new ErrorApp('Elige a qué ubicación o caja van («Hacia»).');
    const D = await parseLugar(q.ubicacion, q.deposito), H = await parseLugar(q.hacia, q.depHacia);
    if (mismoLugar(D, H)) throw new ErrorApp('«Desde» y «Hacia» son el mismo lugar.');
    const cant = cantidad(q.cantidad, 'Escribe cuántas unidades mueves (un número entero mayor que 0).');
    const estado = await estadoValido(q.estado, 'Elige el estado de las unidades que mueves.');
    return rpc('acv_mover', { ...quien(u), codigo: codigoDeTexto(q.codigo), ...D, hUbic: H.ubic, hDep: H.dep, hCaja: H.caja, hLugar: H.lugar, cant, estado, nota: n(q.nota) });
  }
  if (q.accion === 'agregar') {
    if (!q.foto && !q.fotoReal) throw new ErrorApp('Falta la foto del mueble (de catálogo o real; basta una).');
    if (!n(q.ubicacion)) throw new ErrorApp('Elige dónde está el mueble (ubicación o caja).');
    const L = await parseLugar(q.ubicacion, q.deposito);
    const cant = n(q.cantidad) === '' ? 1 : cantidad(q.cantidad);
    const estado = n(q.estado) ? await estadoValido(q.estado, 'Elige el estado de esas unidades.') : (await listas()).estados[0];
    const subidas: string[] = [];
    try {
      const fc = await subirFoto(q.foto); if (fc) subidas.push(fc);
      const fr = await subirFoto(q.fotoReal); if (fr) subidas.push(fr);
      return await rpc('acv_agregar', {
        ...quien(u), codigo: n(q.codigoNuevo), nombre: n(q.nombre), tipo: n(q.tipo), categoria: n(q.categoria), material: n(q.material),
        medidas: n(q.medidas), color: n(q.color), descripcion: n(q.descripcion), ...L, cant, estado, foto_catalogo: fc, foto_real: fr,
        mini: /^data:image\//.test(q.mini || '') && q.mini.length <= 60000 ? q.mini : '', qrBase: QR_NUEVOS,
      });
    } catch (e) {
      if (subidas.length) await db.storage.from('fotos').remove(subidas);   // no quedan fotos sueltas si el alta falló
      throw e;
    }
  }
  throw new ErrorApp(NO_DISPONIBLE);
}

/* ---------- Importar datos de la copia de pruebas (solo administradores de la copia) ---------- */
async function adminDeLaCopia(sesionCopia: string) {
  return enMemoria('copia:' + sesionCopia, 600, async () => {
    const r = await fetch(API_COPIA, { method: 'POST', body: JSON.stringify({ accion: 'sesion', sesion: sesionCopia }), redirect: 'follow' });
    const j = await r.json().catch(() => ({}));
    if (!j.ok || !j.usuario || j.usuario.rol !== 'Administrador') throw new ErrorApp('Solo un administrador de la copia de pruebas puede importar.', 'sin_acceso');
    return j.usuario;
  });
}
// Entrar sin la ventana de Google, con la sesión que ya está abierta en la versión de pruebas (misma cuenta).
async function entrarConCopia(sesionCopia: string) {
  const u = await adminDeLaCopia(sesionCopia);
  const email = lower(u.email);
  if (!(await permitido(email))) throw new ErrorApp('La cuenta ' + email + ' no tiene acceso a Acervo. Pide al administrador que te agregue.', 'sin_acceso');
  const datos = email + '|' + (Date.now() + DIAS_SESION * 86400000);
  const sesion = b64url(new TextEncoder().encode(datos)) + '.' + await firma(datos);
  return Object.assign({ ok: true, sesion, foto: '' }, await sesionDatos(await datosUsuario(email)));
}
async function importarBase(q: any) {
  await adminDeLaCopia(q.sesionCopia);
  const l = q.listas || {};
  falla(await db.from('ajustes').upsert({ clave: 'listas', valor: { ubicaciones: l.ubicaciones || [], depositos: l.depositos || [], tipos: l.tipos || [], categorias: l.categorias || [], estados: l.estados || ESTADOS_ANTES } }));
  if ((q.cajas || []).length) falla(await db.from('cajas').upsert(q.cajas.map((c: any) => ({ codigo: limpio(c.codigo), nombre: limpio(c.nombre), almacen: limpio(c.almacen), deposito: limpio(c.deposito), qr: String(c.qr || '') }))));
  if ((q.admins || []).length) falla(await db.from('admins').upsert(q.admins.map((a: any) => ({ email: lower(a.email), nombre: limpio(a.nombre), rol: a.rol === 'Solo consulta' ? 'Solo consulta' : 'Administrador', activo: a.activo !== false }))));
  olvidar();
  return { ok: true, mensaje: 'Base importada.' };
}
async function importarMueble(q: any) {
  await adminDeLaCopia(q.sesionCopia);
  const m = q.mueble, est: string[] = q.estados || [];
  const viejo = await db.from('muebles').select('foto_catalogo,foto_real').eq('codigo', m.codigo).maybeSingle(); falla(viejo);
  const fotos: Record<string, string> = {};
  for (const f of q.fotos || []) { const ruta = await subirFoto(f.src, 9000000); if (ruta) fotos[f.tipo === 'Real' ? 'foto_real' : 'foto_catalogo'] = ruta; }
  falla(await db.from('muebles').upsert({
    codigo: m.codigo, nombre: m.nombre, tipo: m.tipo || '', categoria: m.categoria || '', material: m.material || '', medidas: m.medidas || '',
    color: m.color || '', descripcion: m.descripcion || '', foto_catalogo: fotos.foto_catalogo || null, foto_real: fotos.foto_real || null,
    mini: q.mini || null, mini_v: q.mini ? String(Date.now()) : '', qr: m.qr || '',
  }));
  const quitar = [viejo.data?.foto_catalogo, viejo.data?.foto_real].filter(Boolean) as string[];
  if (quitar.length) await db.storage.from('fotos').remove(quitar);
  falla(await db.from('lugares').delete().eq('codigo', m.codigo));
  const lug = (m.lugares || []).map((l: any) => {
    const cant: Record<string, number> = {};
    est.forEach((e, i) => { const k = Number(l.num[i]) || 0; if (k) cant[e] = k; });
    return { codigo: m.codigo, ubic: l.ubic, dep: l.dep || '', caja: l.caja || '', cant };
  });
  if (lug.length) falla(await db.from('lugares').insert(lug));
  falla(await db.from('historial').delete().eq('codigo', m.codigo).eq('importado', true));
  const h = (q.historial || []).slice().reverse().map((x: any) => ({
    cuando: x.cuando + '-04:00', usuario: x.usuario || '', correo: '', codigo: x.codigo || m.codigo, mueble: x.mueble || '', accion: x.accion || '',
    antes: x.antes || '', despues: x.despues || '', detalle: x.detalle || '', importado: true,
  }));
  if (h.length) falla(await db.from('historial').insert(h));
  return { ok: true, mensaje: m.codigo + ' importado.', fotos: Object.keys(fotos).length };
}

/* ---------- Entrada ---------- */
async function responder(q: any) {
  if (q.accion === 'entrar') return entrar(q.idToken);
  if (q.accion === 'entrarConCopia') return entrarConCopia(q.sesionCopia);
  if (q.accion === 'importarBase') return importarBase(q);
  if (q.accion === 'importarMueble') return importarMueble(q);
  const u = await usuario(q.sesion);
  const lecturas: Record<string, () => Promise<any>> = {
    todo: () => todo(u),
    sesion: () => sesionDatos(u),
    inicio: async () => { const ms = await leerInventario(); return { resumen: await resumen(ms), actividad: (await historial('', 12)).historial }; },
    inventario: async () => ({ muebles: await leerInventario() }),
    ficha: () => ficha(q.codigo, false, q.tengo),
    cajas: async () => ({ cajas: cajasDe(await leerInventario(), await cajasTodas()) }),
    caja: () => caja(q.codigo),
    historial: () => historial(q.codigo, q.limite),
    resolver: () => resolver(q.texto),
    minis: () => minis(q.tengo),
    fotosMini: () => fotosMini(q.codigos),
  };
  if (lecturas[q.accion]) return Object.assign({ ok: true }, await lecturas[q.accion]());
  if (q.accion === 'miniaturas') return guardarMinis(q.lista);
  const conocidas = ['agregar', 'entrada', 'salida', 'estado', 'mover', 'editar', 'baja', 'cajaCrear', 'cajaMover', 'cajaBorrar', 'cajaNombre'];
  if (conocidas.indexOf(q.accion) < 0) throw new ErrorApp('Acción desconocida.');
  if (u.rol === 'Solo consulta') throw new ErrorApp('Tu rol es «Solo consulta»: puedes ver, pero no hacer cambios.');
  if (['agregar', 'entrada', 'salida', 'estado', 'mover', 'baja'].indexOf(q.accion) >= 0 && !(await estadosAlDia(q.ve))) {
    throw new ErrorApp('La lista de estados del inventario cambió. La app ya la actualizó: revisa el estado elegido y vuelve a intentarlo.', 'estados');
  }
  const r = await cambio(q, u);
  olvidar();
  const out: any = { ok: true, mensaje: r.mensaje };
  if (r.codigo) { try { out.ficha = await ficha(r.codigo, true, []); } catch { /* nada */ } }
  out.todo = await todo(u);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let out: any;
  const t0 = Date.now();
  try {
    if (req.method !== 'POST') throw new ErrorApp('Usa POST.');
    const q = JSON.parse(await req.text() || '{}');
    out = await responder(q);
    out.ms = Date.now() - t0;
  } catch (e) {
    const err = e as ErrorApp;
    out = { ok: false, error: err && err.message ? err.message : 'Algo salió mal.', codigo: err && err.codigo };
    if (!(e instanceof ErrorApp)) console.error(e);
  }
  return new Response(JSON.stringify(out), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
});
