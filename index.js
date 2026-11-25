"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const VERSION = "1.4.0";
const PORT = parseInt(process.env.PORT || "10000", 10);
const GH_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const REPO = (process.env.REPO_TIENDA || "").trim();
const RAMA = (process.env.RAMA || "main").trim();
const CLAVE_PROPIETARIO = (process.env.CLAVE_PROPIETARIO || "").trim();
const GH_API = (process.env.GH_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const GH_UPLOADS = (process.env.GH_UPLOADS_BASE || "https://uploads.github.com").replace(/\/+$/, "");
const MAX_SUBIDA = (parseInt(process.env.MAX_SUBIDA_MB || "300", 10) || 300) * 1048576;
const VALIDAR_CATALOGO = (process.env.VALIDAR_CATALOGO || "1") !== "0";
const ARCHIVO_ADMINS = "puente_admins.json";

const ahoraMs = () => Date.now();
const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function igualSeguro(a, b) {
  const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}
const esObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const esVacio = (x) => x == null || (Array.isArray(x) && x.length === 0) || (esObj(x) && Object.keys(x).length === 0);
const comoLista = (x) => (Array.isArray(x) ? x : esVacio(x) ? [] : null);
const comoMapa = (x) => (esObj(x) ? x : esVacio(x) ? {} : null);
const tamano = (x) => (Array.isArray(x) ? x.length : esObj(x) ? Object.keys(x).length : 0);
const cadena = (x, max) => typeof x === "string" && x.length <= max;
const llaveItem = (nombre, autor) => (String(nombre) + "_" + String(autor)).replace(/[^A-Za-z0-9_\-]/g, "_");
function limpiarLlaveUsuario(u) { return String(u || "").trim().toLowerCase(); }

function logLinea(o) { try { console.log(JSON.stringify(o)); } catch (e) {} }
const AUDITORIA = [];
function auditar(reg) {
  reg.t = new Date().toISOString();
  AUDITORIA.push(reg);
  if (AUDITORIA.length > 400) AUDITORIA.shift();
  logLinea(reg);
}

const cubos = new Map();
function limite(clave, max, ventanaMs) {
  const t = ahoraMs();
  let c = cubos.get(clave);
  if (!c || t - c.ini > ventanaMs) { c = { ini: t, n: 0 }; cubos.set(clave, c); }
  c.n++;
  return c.n <= max;
}
setInterval(() => { const t = ahoraMs(); for (const [k, v] of cubos) if (t - v.ini > 3600000) cubos.delete(k); }, 600000).unref();

function peticion(urlStr, opciones, cuerpo) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, opciones, (res) => {
      const trozos = [];
      res.on("data", (d) => trozos.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(trozos) }));
    });
    req.setTimeout(60000, () => req.destroy(new Error("tiempo agotado")));
    req.on("error", reject);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}
function ghCabeceras(extra) {
  return Object.assign({
    Authorization: "Bearer " + GH_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "puente-tienda/" + VERSION,
    "X-GitHub-Api-Version": "2022-11-28",
  }, extra || {});
}
function gh(metodo, ruta, json, extraCab) {
  const cuerpo = json === undefined ? null : Buffer.from(JSON.stringify(json));
  const cab = ghCabeceras(extraCab);
  if (cuerpo) { cab["Content-Type"] = "application/json"; cab["Content-Length"] = cuerpo.length; }
  return peticion(GH_API + ruta, { method: metodo, headers: cab }, cuerpo);
}
const rutaRepo = (sufijo) => "/repos/" + REPO + sufijo;
const codRuta = (p) => p.split("/").map(encodeURIComponent).join("/");

const microCache = new Map();
async function leerArchivo(ruta, sinCache) {
  const k = "f:" + ruta;
  const c = microCache.get(k);
  if (!sinCache && c && ahoraMs() - c.t < 4000) return c.p;
  const p = (async () => {
    const r = await gh("GET", rutaRepo("/contents/" + codRuta(ruta) + "?ref=" + encodeURIComponent(RAMA)));
    if (r.status === 404) return { existe: false, sha: undefined, texto: null, json: null };
    if (r.status !== 200) throw new Error("GitHub respondio " + r.status + " al leer " + ruta);
    const o = JSON.parse(r.buf.toString("utf8"));
    let texto;
    if (o.content && o.encoding === "base64") texto = Buffer.from(o.content, "base64").toString("utf8");
    else {
      const b = await gh("GET", rutaRepo("/git/blobs/" + o.sha));
      if (b.status !== 200) throw new Error("No se pudo leer el contenido de " + ruta);
      const bo = JSON.parse(b.buf.toString("utf8"));
      texto = Buffer.from(bo.content || "", "base64").toString("utf8");
    }
    let json = null;
    try { json = JSON.parse(texto); } catch (e) {}
    return { existe: true, sha: o.sha, texto, json };
  })();
  microCache.set(k, { t: ahoraMs(), p });
  p.catch(() => microCache.delete(k));
  return p;
}
async function escribirArchivo(ruta, texto, sha, mensaje) {
  microCache.delete("f:" + ruta);
  const cuerpo = { message: mensaje, content: Buffer.from(texto, "utf8").toString("base64"), branch: RAMA };
  if (sha) cuerpo.sha = sha;
  return gh("PUT", rutaRepo("/contents/" + codRuta(ruta)), cuerpo);
}

let admins = { lista: [], t: 0 };
async function cargarAdmins(forzar) {
  if (!forzar && ahoraMs() - admins.t < 120000) return admins.lista;
  try {
    const f = await leerArchivo(ARCHIVO_ADMINS, true);
    const l = f.existe && f.json && Array.isArray(f.json.admins) ? f.json.admins : [];
    admins = { lista: l.filter((a) => a && a.nombre && a.hash), t: ahoraMs(), sha: f.sha };
  } catch (e) { logLinea({ aviso: "no se pudieron leer los administradores", error: String(e.message) }); admins.t = ahoraMs() - 100000; }
  return admins.lista;
}
async function guardarAdmins(lista) {
  for (let i = 0; i < 4; i++) {
    const f = await leerArchivo(ARCHIVO_ADMINS, true);
    const r = await escribirArchivo(ARCHIVO_ADMINS, JSON.stringify({ admins: lista }, null, 1), f.sha, "Puente: administradores");
    if (r.status === 200 || r.status === 201) { admins = { lista, t: ahoraMs() }; return true; }
    if (r.status !== 409 && r.status !== 422) throw new Error("GitHub respondio " + r.status);
  }
  return false;
}

function identidad(req) {
  const ah = String(req.headers["authorization"] || "");
  const m = ah.match(/^(?:token|bearer)\s+(\S+)$/i);
  const r = { id: "", usuario: "invitado", clave: "", ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim() };
  if (!m) return r;
  const partes = m[1].split(":");
  if (partes.length >= 1 && /^[A-Za-z0-9_\-]{6,64}$/.test(partes[0])) r.id = partes[0];
  if (partes.length >= 2 && partes[1]) {
    try { const u = Buffer.from(partes[1], "base64url").toString("utf8").trim(); if (u && u.length <= 60) r.usuario = u; } catch (e) {}
  }
  if (partes.length >= 3) r.clave = partes.slice(2).join(":");
  return r;
}
const fallosClave = new Map();
function ipBloqueada(ip) { const f = fallosClave.get(ip); return !!f && ahoraMs() - f.ini < 600000 && f.n >= 12; }
function anotarFallo(ip) {
  const t = ahoraMs(); let f = fallosClave.get(ip);
  if (!f || t - f.ini >= 600000) { f = { ini: t, n: 0 }; fallosClave.set(ip, f); }
  f.n++;
}
setInterval(() => { const t = ahoraMs(); for (const [k, v] of fallosClave) if (t - v.ini > 600000) fallosClave.delete(k); }, 600000).unref();
async function resolverRol(id) {
  if (!id.clave) return { rol: "usuario", nombre: id.usuario };
  if (ipBloqueada(id.ip)) return { rol: "bloqueado" };
  if (CLAVE_PROPIETARIO.length >= 12 && igualSeguro(id.clave, CLAVE_PROPIETARIO)) return { rol: "propietario", nombre: "propietario" };
  const h = sha256(id.clave);
  const lista = await cargarAdmins(false);
  const a = lista.find((x) => x.hash === h);
  if (a) return { rol: "admin", nombre: a.nombre };
  const l2 = await cargarAdmins(true);
  const b = l2.find((x) => x.hash === h);
  if (b) return { rol: "admin", nombre: b.nombre };
  anotarFallo(id.ip); // solo los fallos cuentan para el bloqueo
  return { rol: "usuario", nombre: id.usuario, claveInvalida: true };
}

async function llavesCatalogo() {
  if (!VALIDAR_CATALOGO) return null;
  try {
    const f = await leerArchivo("archivos.json", false);
    if (!f.json) return null;
    const set = new Set();
    const visita = (x, prof) => {
      if (prof > 4 || x == null) return;
      if (Array.isArray(x)) { x.forEach((y) => visita(y, prof + 1)); return; }
      if (typeof x === "object") {
        if (typeof x.nombre === "string" && x.autor !== undefined) set.add(llaveItem(x.nombre, x.autor));
        Object.values(x).forEach((y) => { if (typeof y === "object") visita(y, prof + 1); });
      }
    };
    visita(f.json, 0);
    return set.size ? set : null;
  } catch (e) { return null; }
}

const NO = (motivo) => ({ ok: false, motivo });
const SI = (nuevo) => ({ ok: true, nuevo });

function soloAgrega(viejaLista, nuevaLista, validaAgregado, maxAgregados) {
  const ol = comoLista(viejaLista), nl = comoLista(nuevaLista);
  if (!ol || !nl) return NO("lista no valida");
  let p = 0, agregados = 0;
  for (const it of nl) {
    if (p < ol.length && deepEqual(it, ol[p])) { p++; continue; }
    const r = validaAgregado(it);
    if (r) return NO(r);
    agregados++;
    if (agregados > maxAgregados) return NO("demasiados elementos nuevos");
  }
  if (p !== ol.length) return NO("no se pueden quitar ni modificar elementos de otras personas");
  return { ok: true, agregados };
}

async function vComentarios(viejo, nuevo, c) {
  const v = comoMapa(viejo) || {}, n = comoMapa(nuevo);
  if (!n) return NO("formato no valido");
  const catalogo = await llavesCatalogo();
  const yo = limpiarLlaveUsuario(c.usuario);
  let totalNuevos = 0;
  for (const k of Object.keys(v)) if (!(k in n)) return NO("no se puede borrar el comentario de otra persona");
  for (const k of Object.keys(n)) {
    const e = n[k];
    if (!esObj(e)) return NO("entrada no valida");
    const antes = v[k];
    if (antes) {
      if (!deepEqual(e.nombreArchivo, antes.nombreArchivo) || !deepEqual(e.autorArchivo, antes.autorArchivo)) return NO("no se pueden cambiar los datos del elemento");
    } else {
      if (!cadena(e.nombreArchivo, 200) || !(typeof e.autorArchivo === "string" || typeof e.autorArchivo === "number")) return NO("elemento no valido");
      if (llaveItem(e.nombreArchivo, e.autorArchivo) !== k) return NO("llave no coincide con el elemento");
      if (catalogo && !catalogo.has(k)) return NO("ese elemento no esta en el catalogo");
    }
    const r = soloAgrega(antes ? antes.listaComentarios : [], e.listaComentarios, (it) => {
      if (!esObj(it)) return "comentario no valido";
      if (limpiarLlaveUsuario(it.autor) !== yo) return "el comentario debe ser tuyo";
      if (typeof it.texto !== "string" || it.texto.trim() === "" || it.texto.length > 1000) return "texto de comentario no valido (1 a 1000 letras)";
      if (it.fecha !== undefined && !cadena(it.fecha, 40)) return "fecha no valida";
      const extra = Object.keys(it).filter((x) => !["autor", "texto", "fecha"].includes(x));
      if (extra.length) return "campos no permitidos";
      return null;
    }, 3);
    if (!r.ok) return r;
    totalNuevos += r.agregados;
  }
  if (totalNuevos > 3) return NO("demasiados comentarios a la vez");
  return SI();
}

async function vCalificaciones(viejo, nuevo, c) {
  const v = comoMapa(viejo) || {}, n = comoMapa(nuevo);
  if (!n) return NO("formato no valido");
  const catalogo = await llavesCatalogo();
  const yo = limpiarLlaveUsuario(c.usuario);
  for (const k of Object.keys(v)) if (!(k in n)) return NO("no se pueden borrar calificaciones");
  const salida = {};
  for (const k of Object.keys(n)) {
    const e = n[k], antes = v[k];
    if (!esObj(e)) return NO("entrada no valida");
    if (antes) {
      if (!deepEqual(e.nombreArchivo, antes.nombreArchivo) || !deepEqual(e.autorArchivo, antes.autorArchivo)) return NO("no se pueden cambiar los datos del elemento");
    } else {
      if (!cadena(e.nombreArchivo, 200) || !(typeof e.autorArchivo === "string" || typeof e.autorArchivo === "number")) return NO("elemento no valido");
      if (llaveItem(e.nombreArchivo, e.autorArchivo) !== k) return NO("llave no coincide con el elemento");
      if (catalogo && !catalogo.has(k)) return NO("ese elemento no esta en el catalogo");
    }
    const evViejas = comoMapa(antes && antes.evaluaciones) || {};
    const evNuevas = comoMapa(e.evaluaciones);
    if (!evNuevas) return NO("evaluaciones no validas");
    for (const u of Object.keys(evViejas)) {
      if (limpiarLlaveUsuario(u) === yo) continue;
      if (!(u in evNuevas) || evNuevas[u] !== evViejas[u]) return NO("no se pueden tocar las calificaciones de otras personas");
    }
    for (const u of Object.keys(evNuevas)) {
      if (u in evViejas && evNuevas[u] === evViejas[u]) continue;
      if (limpiarLlaveUsuario(u) !== yo) return NO("solo puedes cambiar tu propia calificacion");
      const nota = Number(evNuevas[u]);
      if (!Number.isFinite(nota) || nota < 1 || nota > 5) return NO("la calificacion debe estar entre 1 y 5");
    }
    const notas = Object.values(evNuevas).map(Number).filter(Number.isFinite);
    const suma = notas.reduce((a, b) => a + b, 0);
    salida[k] = Object.assign({}, e, {
      evaluaciones: evNuevas,
      promedio: notas.length ? Math.floor((suma / notas.length) * 10) / 10 : 0,
      totalVotos: notas.length,
    });
  }
  return SI(salida);
}

async function vDescargadores(viejo, nuevo, c) {
  const v = comoMapa(viejo) || {}, n = comoMapa(nuevo);
  if (!n) return NO("formato no valido");
  const catalogo = await llavesCatalogo();
  const yo = limpiarLlaveUsuario(c.usuario);
  for (const k of Object.keys(v)) if (!(k in n)) return NO("no se pueden borrar registros");
  let agregados = 0;
  for (const k of Object.keys(n)) {
    const e = n[k], antes = v[k];
    if (!esObj(e)) return NO("entrada no valida");
    if (antes) {
      if (!deepEqual(e.nombreArchivo, antes.nombreArchivo) || !deepEqual(e.autorArchivo, antes.autorArchivo)) return NO("no se pueden cambiar los datos del elemento");
    } else {
      if (!cadena(e.nombreArchivo, 200)) return NO("elemento no valido");
      if (llaveItem(e.nombreArchivo, e.autorArchivo) !== k) return NO("llave no coincide con el elemento");
      if (catalogo && !catalogo.has(k)) return NO("ese elemento no esta en el catalogo");
    }
    const r = soloAgrega(antes ? antes.usuarios : [], e.usuarios, (u) => (typeof u === "string" && limpiarLlaveUsuario(u) === yo ? null : "solo puedes registrarte a ti"), 1);
    if (!r.ok) return r;
    agregados += r.agregados;
  }
  if (agregados > 1) return NO("demasiados registros");
  return SI();
}

async function vUsuariosTienda(viejo, nuevo, c) {
  const v = comoMapa(viejo) || {}, n = comoMapa(nuevo);
  if (!n) return NO("formato no valido");
  const yo = limpiarLlaveUsuario(c.usuario);
  for (const k of Object.keys(v)) {
    if (!(k in n)) return NO("no se pueden borrar usuarios");
    if (k !== yo && !deepEqual(v[k], n[k])) return NO("solo puedes tocar tu propio registro");
  }
  for (const k of Object.keys(n)) {
    if (k in v) { if (k !== yo) continue; }
    else if (k !== yo) return NO("solo puedes crear tu propio registro");
    const e = n[k];
    if (!esObj(e)) return NO("registro no valido");
    if (limpiarLlaveUsuario(e.usuario) !== yo) return NO("el registro debe ser tuyo");
    for (const campo of ["visitas", "dias", "primera", "ultima"]) {
      if (e[campo] !== undefined && !(Number.isFinite(Number(e[campo])) && Number(e[campo]) >= 0 && Number(e[campo]) < 4e9)) return NO("numero no valido");
    }
    const antes = v[k];
    if (antes && Number(e.visitas) - Number(antes.visitas || 0) > 3) return NO("demasiadas visitas a la vez");
    if (e.rol !== undefined && !cadena(e.rol, 30)) return NO("rol no valido");
    if (e.dias_lista !== undefined && (!Array.isArray(e.dias_lista) || e.dias_lista.length > 400) && !esVacio(e.dias_lista)) return NO("lista de dias no valida");
  }
  return SI();
}

function validaSolicitudPropia(entrada, anterior, yo, estadosPermitidos) {
  if (!esObj(entrada)) return "solicitud no valida";
  if (limpiarLlaveUsuario(entrada.usuario) !== yo) return "la solicitud debe ser tuya";
  if (anterior && String(anterior.estado) === "aprobado" && !deepEqual(anterior, entrada)) return "ya esta aprobada";
  if (!estadosPermitidos.includes(String(entrada.estado || "pendiente"))) return "estado no permitido";
  return null;
}
async function vSolicitudesBeta(viejo, nuevo, c) {
  const v = comoMapa(viejo) || {}, n = comoMapa(nuevo);
  if (!n) return NO("formato no valido");
  const yo = limpiarLlaveUsuario(c.usuario);
  for (const k of Object.keys(v)) if (!(k in n)) return NO("no se pueden borrar solicitudes");
  for (const k of Object.keys(n)) {
    if (k in v && deepEqual(v[k], n[k])) continue;
    if (k !== yo) return NO("solo puedes tocar tu propia solicitud");
    const r = validaSolicitudPropia(n[k], v[k], yo, ["pendiente"]);
    if (r) return NO(r);
  }
  return SI();
}
async function vSolicitudesCompra(viejo, nuevo, c) {
  const v = comoMapa(viejo) || {}, n = comoMapa(nuevo);
  if (!n) return NO("formato no valido");
  const catalogo = await llavesCatalogo();
  const yo = limpiarLlaveUsuario(c.usuario);
  for (const k of Object.keys(v)) if (!(k in n)) return NO("no se pueden borrar solicitudes");
  for (const k of Object.keys(n)) {
    const e = n[k], antes = v[k];
    if (!esObj(e)) return NO("entrada no valida");
    if (antes) {
      if (!deepEqual(e.nombreArchivo, antes.nombreArchivo) || !deepEqual(e.autorArchivo, antes.autorArchivo)) return NO("no se pueden cambiar los datos del elemento");
    } else if (catalogo && !catalogo.has(k)) return NO("ese elemento no esta en el catalogo");
    const cv = comoMapa(antes && antes.compradores) || {}, cn = comoMapa(e.compradores);
    if (!cn) return NO("compradores no validos");
    for (const u of Object.keys(cv)) if (!(u in cn)) return NO("no se pueden borrar solicitudes");
    for (const u of Object.keys(cn)) {
      if (u in cv && deepEqual(cv[u], cn[u])) continue;
      if (u !== yo) return NO("solo puedes tocar tu propia solicitud");
      const r = validaSolicitudPropia(cn[u], cv[u], yo, ["pendiente"]);
      if (r) return NO(r);
    }
  }
  return SI();
}

const ARCHIVOS_USUARIO = {
  "comentarios.json": vComentarios,
  "calificaciones.json": vCalificaciones,
  "descargadores.json": vDescargadores,
  "usuarios_tienda.json": vUsuariosTienda,
  "solicitudes_compra.json": vSolicitudesCompra,
  "solicitudes_beta.json": vSolicitudesBeta,
};
const SOLO_ADMIN = new Set([
  "archivos.json", "notificaciones.json", "anuncios.json", "perfiles.json", "betas.json", "membresia.json",
  "musica.json", "musica_activa_tienda.json", "musica_tiendas.json", "musica_secciones.json",
  "version_tienda.json", "bot_distribuidor.json",
]);
const LIMPIABLES = new Set(["notificaciones.json", "anuncios.json"]);
const LECTURA_ADMIN = new Set(["bot_distribuidor.json"]);
const SOLO_PROPIETARIO = new Set(["propietarios_supremos.json"]);

function rutaValida(ruta) {
  return typeof ruta === "string" && ruta.length > 0 && ruta.length <= 200 && /^[A-Za-z0-9_\-./ ]+$/.test(ruta) && !ruta.includes("..") && !ruta.startsWith("/");
}
function rutaProtegida(ruta) {
  const r = ruta.toLowerCase();
  return r.startsWith("puente_") || r.startsWith(".github") || r.startsWith(".git/") || r === ".git";
}

function guardia(ruta, viejo, nuevoTexto, nuevoJson, rol) {
  if (/\.json$/i.test(ruta) && nuevoJson === null) return "el contenido no es un JSON valido";
  if (rol === "propietario") return null;
  const v = tamano(viejo), n = tamano(nuevoJson);
  if (v > 0 && n === 0 && !LIMPIABLES.has(ruta)) return "vaciaria el archivo";
  if (v >= 5 && n < v * 0.3 && !LIMPIABLES.has(ruta)) return "perderia mas del 70% del contenido";
  if (v > 0 && viejo !== null && nuevoJson !== null && !esVacio(nuevoJson) && !esVacio(viejo) && Array.isArray(viejo) !== Array.isArray(nuevoJson)) return "cambiaria la estructura del archivo";
  return null;
}

function responder(res, status, cuerpo, cab) {
  const esBuf = Buffer.isBuffer(cuerpo);
  const data = esBuf ? cuerpo : Buffer.from(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo));
  const h = Object.assign({ "Content-Type": esBuf || typeof cuerpo === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" }, cab || {});
  res.writeHead(status, h);
  res.end(data);
}
const error = (res, status, mensaje) => responder(res, status, { message: mensaje });

function leerCuerpo(req, max) {
  return new Promise((resolve, reject) => {
    const partes = []; let n = 0;
    req.on("data", (d) => { n += d.length; if (n > max) { req.destroy(); reject(new Error("cuerpo demasiado grande")); return; } partes.push(d); });
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}
function urlPublica(req) {
  const env = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (env) return env;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return proto + "://" + req.headers.host;
}
function reescribirRelease(o, base) {
  if (!o || typeof o !== "object") return o;
  if (o.id && o.upload_url) o.upload_url = base + "/uploads/repos/" + REPO + "/releases/" + o.id + "/assets{?name,label}";
  if (Array.isArray(o.assets)) {
    for (const a of o.assets) {
      if (!a || !a.id) continue;
      a.url = base + "/repos/" + REPO + "/releases/assets/" + a.id;
    }
  }
  ["html_url", "tarball_url", "zipball_url"].forEach((k) => { if (o[k]) delete o[k]; });
  return o;
}

// ---------------------------------------------------------------------------------------------
// Codigos de canje (promociones). Se guardan en puente_promos.json (el puente no lo expone).
// Cupos que ve el publico = total - reservados - canjeados (nunca se muestran cupos inexistentes).
// ---------------------------------------------------------------------------------------------
const ARCHIVO_PROMOS = "puente_promos.json";
const MAX_CUPOS = 20;
let colaPromos = Promise.resolve();
function enColaPromos(fn) { const p = colaPromos.then(fn, fn); colaPromos = p.catch(() => {}); return p; }
async function cambiarPromos(mutar) {
  return enColaPromos(async () => {
    for (let i = 0; i < 4; i++) {
      const f = await leerArchivo(ARCHIVO_PROMOS, true);
      const data = f.json && Array.isArray(f.json.promos) ? f.json : { promos: [] };
      data.promos.forEach((p) => { if (!Array.isArray(p.canjeados)) p.canjeados = []; });
      const res = mutar(data);
      if (!res || res.error || !res.guardar) return res;
      const r = await escribirArchivo(ARCHIVO_PROMOS, JSON.stringify(data, null, 1), f.existe ? f.sha : undefined, "Puente: codigos de canje");
      if (r.status === 200 || r.status === 201) return res;
      if (r.status !== 409 && r.status !== 422) throw new Error("GitHub respondio " + r.status);
    }
    return { error: "No se pudo guardar. Reintenta.", status: 409 };
  });
}
const normCodigo = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function cuposDe(p) { return Math.max(0, (p.cupos_total | 0) - (p.cupos_reservados | 0) - (Array.isArray(p.canjeados) ? p.canjeados.length : 0)); }
function vistaPromo(p, admin) {
  const o = {
    id: p.id, elemento: p.elemento, alcance: p.alcance, version: p.version || "", activo: p.activo !== false, desactivar_al_agotar: p.desactivar_al_agotar === true, duracion_dias: p.duracion_dias | 0,
    cupos_total: p.cupos_total, cupos_reservados: p.cupos_reservados | 0,
    canjeados: Array.isArray(p.canjeados) ? p.canjeados.length : 0, disponibles: p.activo === false ? 0 : cuposDe(p), creado: p.creado,
  };
  if (admin) { o.codigo = p.codigo; o.usuarios = (Array.isArray(p.canjeados) ? p.canjeados : []).map((c) => ({ usuario: c.n, fecha: c.f })); }
  return o;
}
function generarCodigoPromo(data) {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 50; i++) {
    let s = ""; const b = crypto.randomBytes(8);
    for (let k = 0; k < 8; k++) s += A[b[k] % A.length];
    const cod = "EM-" + s.slice(0, 4) + "-" + s.slice(4);
    if (!data.promos.some((p) => normCodigo(p.codigo) === normCodigo(cod))) return cod;
  }
  throw new Error("No se pudo generar un codigo unico");
}
function avisarBotPromo(p) {
  const url = (process.env.BOT_URL || "").replace(/\/+$/, ""), sec = process.env.BOT_SECRET || "";
  if (!url || !sec || typeof fetch !== "function") return;
  const v = vistaPromo(p, false);
  fetch(url + "/api/promo/actualizar", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + sec },
    body: JSON.stringify({ id: v.id, disponibles: v.disponibles, total: v.cupos_total, activo: v.activo }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}
// Duracion del acceso tras canjear: 0 = para siempre; si no, dias contados desde el canje.
function vencimientoMs(p, c) {
  const d = (p.duracion_dias | 0);
  const t = Date.parse(c && c.f);
  return d > 0 && !isNaN(t) ? t + d * 86400000 : 0;
}
function textoCorto(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }
function entero(x) { const n = Number(x); return Number.isInteger(n) ? n : NaN; }

async function manejarPromos(req, ruta, metodo, u, rol, id, R, E) {
  const esAdm = rol === "admin" || rol === "propietario";
  const bot = !!(process.env.BOT_CLAVE && process.env.BOT_CLAVE.length >= 12 && igualSeguro(String(req.headers["x-bot-clave"] || ""), process.env.BOT_CLAVE));
  const sub = ruta.replace(/^\/puente\/promos\/?/, "");
  const idq = textoCorto(u.searchParams.get("id"), 40);
  const leerJson = async (max) => { try { return JSON.parse((await leerCuerpo(req, max)).toString() || "{}"); } catch (e) { return null; } };

  if (sub === "estado" && metodo === "GET") {
    const f = await leerArchivo(ARCHIVO_PROMOS, false);
    const p = f.json && (f.json.promos || []).find((x) => x.id === idq);
    if (!p) return E(404, "No encontrado");
    return R(200, vistaPromo(p, false));
  }
  if (sub === "mis" && metodo === "GET") {
    if (!id.id) return E(401, "Falta la identificacion de la instalacion.");
    const f = await leerArchivo(ARCHIVO_PROMOS, false);
    const ahora = Date.now();
    const lista = [];
    for (const p of ((f.json && f.json.promos) || [])) {
      const c = (Array.isArray(p.canjeados) ? p.canjeados : []).find((x) => x.u === id.id);
      if (!c) continue;
      const vence = vencimientoMs(p, c);
      if (vence && ahora > vence) continue;
      lista.push({ id: p.id, elemento: p.elemento, alcance: p.alcance, version: p.version || "", duracion_dias: p.duracion_dias | 0, expira_ms: vence });
    }
    return R(200, { canjes: lista });
  }
  if (sub === "canjear" && metodo === "POST") {
    if (!id.id) return E(401, "Falta la identificacion de la instalacion.");
    if (!limite("pc:" + id.id, 10, 600000) || !limite("pcip:" + id.ip, 30, 600000)) return E(429, "Demasiados intentos. Espera unos minutos.");
    const cu = await leerJson(2048);
    const cod = normCodigo(cu && cu.codigo);
    if (cod.length < 6) return E(400, "Escribe el codigo completo.");
    const res = await cambiarPromos((data) => {
      const p = data.promos.find((x) => normCodigo(x.codigo) === cod && x.activo !== false);
      if (!p) return { status: 404, error: "Codigo no valido." };
      p.canjeados = p.canjeados || [];
      const previo = p.canjeados.find((c) => c.u === id.id);
      if (previo) {
        const v = vencimientoMs(p, previo);
        if (v && Date.now() > v) return { status: 409, error: "Ya usaste este codigo y su tiempo de acceso termino." };
        return { ya: true, promo: p, canje: previo };
      }
      if (cuposDe(p) <= 0) return { status: 410, error: "Los cupos de este codigo se agotaron." };
      p.canjeados.push({ u: id.id, n: textoCorto(id.usuario, 60), f: new Date().toISOString() });
      if (p.desactivar_al_agotar === true && cuposDe(p) <= 0) p.activo = false;
      return { guardar: true, promo: p, canje: p.canjeados[p.canjeados.length - 1] };
    });
    if (res.error) return E(res.status || 400, res.error);
    if (!res.ya) avisarBotPromo(res.promo);
    return R(200, { ok: true, ya_canjeado: !!res.ya, elemento: res.promo.elemento, alcance: res.promo.alcance, version: res.promo.version || "", disponibles: cuposDe(res.promo), duracion_dias: res.promo.duracion_dias | 0, expira_ms: vencimientoMs(res.promo, res.canje) });
  }
  if (sub === "ver" && metodo === "POST") {
    if (!esAdm && !bot) return E(403, "Solo el bot o un administrador.");
    const cu = await leerJson(2048);
    const f = await leerArchivo(ARCHIVO_PROMOS, true);
    const p = f.json && (f.json.promos || []).find((x) => x.id === textoCorto(cu && cu.id, 40));
    if (!p) return E(404, "No encontrado");
    const d = p.activo === false ? 0 : cuposDe(p);
    return R(200, d > 0 ? { agotado: false, codigo: p.codigo, disponibles: d, total: p.cupos_total, elemento: p.elemento } : { agotado: true, disponibles: 0, total: p.cupos_total });
  }

  if (!esAdm) return E(403, "Necesitas la clave de administrador del puente.");
  if (sub === "" && metodo === "GET") {
    const f = await leerArchivo(ARCHIVO_PROMOS, true);
    return R(200, { promos: ((f.json && f.json.promos) || []).map((p) => vistaPromo(p, true)) });
  }
  if (sub === "" && metodo === "POST") {
    const cu = await leerJson(8192);
    if (!cu) return E(400, "Cuerpo no valido");
    const el = cu.elemento || {};
    const nombre = textoCorto(el.nombre, 120);
    if (!nombre) return E(400, "Falta el nombre del elemento.");
    const total = entero(cu.cupos_total), reserv = cu.cupos_reservados === undefined ? 0 : entero(cu.cupos_reservados);
    if (!(total >= 1 && total <= MAX_CUPOS)) return E(400, "Los cupos van de 1 a " + MAX_CUPOS + ".");
    if (!(reserv >= 0 && reserv <= total)) return E(400, "Los cupos reservados no pueden pasar del total.");
    const alcance = cu.alcance === "actualizacion" ? "actualizacion" : "lanzamiento";
    const dur = cu.duracion_dias === undefined ? 0 : entero(cu.duracion_dias);
    if (!(dur >= 0 && dur <= 365)) return E(400, "La duracion va de 0 (para siempre) a 365 dias.");
    const res = await cambiarPromos((data) => {
      if (data.promos.length >= 500) return { status: 400, error: "Demasiados codigos guardados. Borra los viejos." };
      let codigo = cu.codigo ? textoCorto(cu.codigo, 30).toUpperCase() : "";
      if (codigo && (normCodigo(codigo).length < 6 || data.promos.some((p) => normCodigo(p.codigo) === normCodigo(codigo)))) return { status: 409, error: "Ese codigo no sirve o ya existe." };
      if (!codigo) codigo = generarCodigoPromo(data);
      const p = {
        id: "p" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), codigo,
        elemento: { nombre, categoria: textoCorto(el.categoria, 40), tienda: textoCorto(el.tienda, 80), autor: textoCorto(el.autor, 80) },
        alcance, version: textoCorto(cu.version, 40), cupos_total: total, cupos_reservados: reserv, canjeados: [],
        activo: true, desactivar_al_agotar: cu.desactivar_al_agotar === true, duracion_dias: dur, creado: new Date().toISOString(), creado_por: textoCorto(id.usuario, 60),
      };
      data.promos.push(p);
      return { guardar: true, promo: p };
    });
    if (res.error) return E(res.status || 400, res.error);
    return R(201, vistaPromo(res.promo, true));
  }
  if (sub === "" && metodo === "PATCH") {
    const cu = await leerJson(8192);
    if (!cu) return E(400, "Cuerpo no valido");
    const res = await cambiarPromos((data) => {
      const p = data.promos.find((x) => x.id === idq);
      if (!p) return { status: 404, error: "No encontrado" };
      const usados = (p.canjeados || []).length;
      const total = cu.cupos_total === undefined ? p.cupos_total : entero(cu.cupos_total);
      const reserv = cu.cupos_reservados === undefined ? (p.cupos_reservados | 0) : entero(cu.cupos_reservados);
      if (!(total >= 1 && total <= MAX_CUPOS)) return { status: 400, error: "Los cupos van de 1 a " + MAX_CUPOS + "." };
      if (!(reserv >= 0)) return { status: 400, error: "Reservados no valido." };
      if (reserv + usados > total) return { status: 400, error: "Reservados + canjeados (" + (reserv + usados) + ") no pueden pasar del total (" + total + ")." };
      p.cupos_total = total; p.cupos_reservados = reserv;
      if (typeof cu.activo === "boolean") p.activo = cu.activo;
      if (typeof cu.desactivar_al_agotar === "boolean") p.desactivar_al_agotar = cu.desactivar_al_agotar;
      if (cu.duracion_dias !== undefined) {
        const dd = entero(cu.duracion_dias);
        if (!(dd >= 0 && dd <= 365)) return { status: 400, error: "La duracion va de 0 (para siempre) a 365 dias." };
        p.duracion_dias = dd;
      }
      if (cu.alcance === "lanzamiento" || cu.alcance === "actualizacion") p.alcance = cu.alcance;
      if (cu.version !== undefined) p.version = textoCorto(cu.version, 40);
      if (cu.regenerar === true) p.codigo = generarCodigoPromo(data);
      return { guardar: true, promo: p };
    });
    if (res.error) return E(res.status || 400, res.error);
    avisarBotPromo(res.promo);
    return R(200, vistaPromo(res.promo, true));
  }
  if (sub === "" && metodo === "DELETE") {
    const res = await cambiarPromos((data) => {
      const i = data.promos.findIndex((x) => x.id === idq);
      if (i < 0) return { status: 404, error: "No encontrado" };
      const [p] = data.promos.splice(i, 1);
      p.activo = false;
      return { guardar: true, promo: p };
    });
    if (res.error) return E(res.status || 400, res.error);
    avisarBotPromo(res.promo);
    return R(200, { ok: true });
  }
  return E(405, "Metodo no permitido");
}

async function manejar(req, res) {
  const u = new URL(req.url, "http://x");
  const ruta = decodeURIComponent(u.pathname);
  const metodo = req.method;
  if (ruta === "/health" || ruta === "/") return responder(res, 200, "ok puente-tienda " + VERSION);
  if (!GH_TOKEN || !REPO) return error(res, 503, "El puente no esta configurado (faltan GITHUB_TOKEN o REPO_TIENDA).");

  const id = identidad(req);
  const quien = await resolverRol(id);
  if (quien.rol === "bloqueado") return error(res, 429, "Demasiados intentos con clave incorrecta. Espera unos minutos.");
  const rol = quien.rol;
  const etiqueta = id.id || id.ip;
  const esEscritura = metodo !== "GET" && metodo !== "HEAD";
  if (!limite("g:" + etiqueta, rol === "usuario" ? 240 : 600, 60000)) return error(res, 429, "Demasiadas peticiones. Espera un momento.");
  if (esEscritura && rol === "usuario" && !limite("e:" + etiqueta, parseInt(process.env.LIMITE_ESCRITURAS || "20", 10), 60000)) return error(res, 429, "Demasiadas escrituras seguidas. Espera un minuto.");
  if (esEscritura && rol === "usuario" && !limite("eip:" + id.ip, 120, 3600000)) return error(res, 429, "Limite de escrituras alcanzado.");
  const reg = { rol, usuario: id.usuario, admin: quien.nombre, instalacion: id.id, ip: id.ip, metodo, ruta };
  const fin = (status, nota) => { reg.estado = status; if (nota) reg.nota = nota; if (esEscritura || status >= 400) auditar(reg); };
  const R = (status, cuerpo, cab, nota) => { fin(status, nota); return responder(res, status, cuerpo, cab); };
  const E = (status, m) => R(status, { message: m }, null, m);

  if (ruta === "/puente/promos" || ruta.startsWith("/puente/promos/")) return manejarPromos(req, ruta, (metodo === "POST" && String(u.searchParams.get("metodo") || "").toUpperCase() === "PATCH") ? "PATCH" : metodo, u, rol, id, R, E);

  if (ruta === "/puente/info") return R(200, { version: VERSION, rol, nombre: quien.nombre, repo: REPO, claveInvalida: !!quien.claveInvalida });

  if (ruta === "/puente/admins") {
    if (rol !== "propietario") return E(403, "Solo el propietario administra las claves.");
    if (metodo === "GET") { const l = await cargarAdmins(true); return R(200, { admins: l.map((a) => ({ nombre: a.nombre, creada: a.creada })) }); }
    if (metodo === "POST") {
      const cuerpo = JSON.parse((await leerCuerpo(req, 4096)).toString() || "{}");
      const nombre = String(cuerpo.nombre || "").trim();
      if (!/^[\p{L}\p{N}_ .\-]{2,40}$/u.test(nombre)) return E(400, "Nombre no valido (2 a 40 letras o numeros).");
      const l = (await cargarAdmins(true)).slice();
      if (l.some((a) => a.nombre.toLowerCase() === nombre.toLowerCase())) return E(409, "Ya existe un administrador con ese nombre.");
      if (l.length >= 60) return E(400, "Demasiados administradores.");
      const clave = "emp_" + crypto.randomBytes(24).toString("base64url");
      l.push({ nombre, hash: sha256(clave), creada: new Date().toISOString() });
      if (!(await guardarAdmins(l))) return E(409, "No se pudo guardar. Reintenta.");
      return R(201, { nombre, clave, aviso: "Guarda esta clave: no se vuelve a mostrar." });
    }
    if (metodo === "DELETE") {
      const nombre = String(u.searchParams.get("nombre") || "").trim().toLowerCase();
      const l = (await cargarAdmins(true)).filter((a) => a.nombre.toLowerCase() !== nombre);
      if (!(await guardarAdmins(l))) return E(409, "No se pudo guardar. Reintenta.");
      return R(200, { ok: true });
    }
    return E(405, "Metodo no permitido");
  }
  if (ruta === "/puente/diagnostico") {
    if (rol !== "propietario") return E(403, "Solo el propietario.");
    const d = { version: VERSION, repo: REPO, rama: RAMA, claveDePropietarioLarga: CLAVE_PROPIETARIO.length >= 12 };
    try {
      const rr = await gh("GET", rutaRepo(""));
      d.github = rr.status;
      if (rr.status === 200) { const o = JSON.parse(rr.buf.toString("utf8")); d.privado = !!o.private; d.puedeEscribir = !!(o.permissions && o.permissions.push); }
      else if (rr.status === 401) d.problema = "GitHub rechazo el token (vencido o mal copiado).";
      else if (rr.status === 404) d.problema = "El token no ve el repositorio " + REPO + " (revisa el nombre y que el token tenga acceso a ese repositorio).";
      else d.problema = "GitHub respondio " + rr.status;
      const f = await leerArchivo("archivos.json", true);
      d.catalogoLegible = f.existe;
      if (d.puedeEscribir === false) d.problema = "El token solo puede leer: necesita permiso de escritura (Contents: Read and write).";
    } catch (e) { d.problema = "No se pudo hablar con GitHub: " + e.message; }
    return R(200, d);
  }
  if (ruta === "/puente/auditoria") {
    if (rol !== "propietario") return E(403, "Solo el propietario.");
    return R(200, { eventos: AUDITORIA.slice(-200) });
  }

  if (ruta.startsWith("/raw/") && metodo === "GET") {
    let p = ruta.slice(5);
    const pref = REPO + "/";
    if (p.toLowerCase().startsWith(pref.toLowerCase())) { p = p.slice(pref.length); const i = p.indexOf("/"); p = i >= 0 ? p.slice(i + 1) : ""; }
    if (!rutaValida(p) || rutaProtegida(p)) return E(404, "No encontrado");
    if (LECTURA_ADMIN.has(p) && rol === "usuario") return E(404, "No encontrado");
    const f = await leerArchivo(p, false);
    if (!f.existe) return E(404, "No encontrado");
    return R(200, f.texto, { "Cache-Control": "no-cache" });
  }

  let m = ruta.match(/^\/dl\/([^/]+)\/(.+)$/);
  if (m && metodo === "GET") return descargaPorEtiqueta(req, res, m[1], m[2], R, E);

  m = ruta.match(/^\/uploads\/repos\/([^/]+\/[^/]+)\/releases\/(\d+)\/assets$/);
  if (m && metodo === "POST") {
    if (m[1].toLowerCase() !== REPO.toLowerCase()) return E(404, "Repositorio no permitido");
    if (rol !== "admin" && rol !== "propietario") return E(403, "Necesitas la clave de administrador del puente.");
    const nombre = String(u.searchParams.get("name") || "");
    if (!/^[^\/\\\x00-\x1f]{1,180}$/.test(nombre) || nombre.includes("..")) return E(400, "Nombre de archivo no valido.");
    const largo = parseInt(req.headers["content-length"] || "0", 10);
    if (!largo) return E(411, "Falta Content-Length.");
    if (largo > MAX_SUBIDA) return E(413, "Archivo demasiado grande (limite " + Math.round(MAX_SUBIDA / 1048576) + " MB).");
    if (rol === "admin" && !limite("sub:" + quien.nombre, 60, 3600000)) return E(429, "Demasiadas subidas por hora.");
    return subirAsset(req, res, m[2], nombre, largo, u.searchParams.get("label"), R, E);
  }

  m = ruta.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/);
  if (!m) return E(404, "Ruta no encontrada");
  if (m[1].toLowerCase() !== REPO.toLowerCase()) return E(404, "Repositorio no permitido");
  const resto = m[2];

  let c = resto.match(/^\/contents\/(.+)$/);
  if (c) {
    const archivo = c[1];
    if (!rutaValida(archivo) || rutaProtegida(archivo)) return E(404, "No encontrado");
    if ((metodo === "GET" || metodo === "HEAD") && LECTURA_ADMIN.has(archivo) && rol === "usuario") return E(404, "No encontrado");
    if (metodo === "GET" || metodo === "HEAD") {
      const q = new URLSearchParams(u.search); q.delete("nocache"); q.delete("ref"); q.set("ref", RAMA);
      const cab = {}; if (req.headers["if-none-match"]) cab["If-None-Match"] = req.headers["if-none-match"];
      if (req.headers["accept"] && /raw|json/.test(req.headers["accept"])) cab["Accept"] = req.headers["accept"];
      const r = await gh("GET", rutaRepo("/contents/" + codRuta(archivo) + "?" + q.toString()), undefined, cab);
      const salida = {};
      if (r.headers["etag"]) salida["ETag"] = r.headers["etag"];
      if (r.headers["content-type"]) salida["Content-Type"] = r.headers["content-type"];
      fin(r.status);
      res.writeHead(r.status, Object.assign({ "Content-Length": r.buf.length, "Cache-Control": "no-store" }, salida));
      return res.end(r.buf);
    }
    if (metodo === "PUT") return escribirContenido(req, archivo, rol, id, quien, R, E);
    if (metodo === "DELETE") {
      if (rol !== "propietario") return E(403, "Solo el propietario puede borrar archivos del repositorio.");
      const cu = JSON.parse((await leerCuerpo(req, 8192)).toString() || "{}");
      const r = await gh("DELETE", rutaRepo("/contents/" + codRuta(archivo)), { message: String(cu.message || "Borrado por el puente").slice(0, 200), sha: cu.sha, branch: RAMA });
      microCache.delete("f:" + archivo);
      return R(r.status, r.buf, { "Content-Type": "application/json" });
    }
    return E(405, "Metodo no permitido");
  }

  c = resto.match(/^\/git\/blobs\/([0-9a-f]{40})$/);
  if (c && metodo === "GET") {
    const r = await gh("GET", rutaRepo("/git/blobs/" + c[1]));
    fin(r.status);
    res.writeHead(r.status, { "Content-Type": "application/json", "Content-Length": r.buf.length });
    return res.end(r.buf);
  }

  if (resto === "/releases" && metodo === "GET") {
    const r = await gh("GET", rutaRepo("/releases?per_page=" + Math.min(100, parseInt(u.searchParams.get("per_page") || "30", 10) || 30) + "&page=" + (parseInt(u.searchParams.get("page") || "1", 10) || 1)));
    return respuestaRelease(r, req, res, fin);
  }
  c = resto.match(/^\/releases\/tags\/([^/]+)$/);
  if (c && metodo === "GET") return respuestaRelease(await gh("GET", rutaRepo("/releases/tags/" + encodeURIComponent(c[1]))), req, res, fin);
  c = resto.match(/^\/releases\/(\d+)$/);
  if (c && metodo === "GET") return respuestaRelease(await gh("GET", rutaRepo("/releases/" + c[1])), req, res, fin);

  if (resto === "/releases" && metodo === "POST") {
    if (rol !== "admin" && rol !== "propietario") return E(403, "Necesitas la clave de administrador del puente.");
    if (rol === "admin" && !limite("rel:" + quien.nombre, 60, 3600000)) return E(429, "Demasiados releases por hora.");
    const cu = JSON.parse((await leerCuerpo(req, 65536)).toString() || "{}");
    if (!/^[A-Za-z0-9._\-]{1,100}$/.test(String(cu.tag_name || ""))) return E(400, "tag_name no valido");
    const cuerpo = { tag_name: cu.tag_name, target_commitish: RAMA, name: String(cu.name || cu.tag_name).slice(0, 200), body: String(cu.body || "").slice(0, 20000), draft: false, prerelease: false };
    return respuestaRelease(await gh("POST", rutaRepo("/releases"), cuerpo), req, res, fin);
  }
  if ((c = resto.match(/^\/releases\/(\d+)$/)) && (metodo === "DELETE" || metodo === "PATCH")) {
    if (rol !== "admin" && rol !== "propietario") return E(403, "Necesitas la clave de administrador del puente.");
    if (rol === "admin" && !limite("del:" + quien.nombre, 40, 3600000)) return E(429, "Demasiados borrados por hora.");
    if (metodo === "DELETE") { const r = await gh("DELETE", rutaRepo("/releases/" + c[1])); return R(r.status, r.buf.length ? r.buf : "", { "Content-Type": "application/json" }); }
    const cu = JSON.parse((await leerCuerpo(req, 65536)).toString() || "{}");
    const cuerpo = {}; ["name", "body"].forEach((k) => { if (typeof cu[k] === "string") cuerpo[k] = cu[k].slice(0, 20000); });
    return respuestaRelease(await gh("PATCH", rutaRepo("/releases/" + c[1]), cuerpo), req, res, fin);
  }

  c = resto.match(/^\/git\/refs\/tags\/([A-Za-z0-9._\-]{1,100})$/);
  if (c && metodo === "DELETE") {
    if (rol !== "admin" && rol !== "propietario") return E(403, "Necesitas la clave de administrador del puente.");
    if (rol === "admin" && !limite("del:" + quien.nombre, 40, 3600000)) return E(429, "Demasiados borrados por hora.");
    const r = await gh("DELETE", rutaRepo("/git/refs/tags/" + c[1]));
    return R(r.status, r.buf.length ? r.buf : "", { "Content-Type": "application/json" });
  }

  c = resto.match(/^\/releases\/assets\/(\d+)$/);
  if (c && metodo === "GET") return descargaAsset(c[1], R, E);
  if (c && metodo === "DELETE") {
    if (rol !== "admin" && rol !== "propietario") return E(403, "Necesitas la clave de administrador del puente.");
    if (rol === "admin" && !limite("del:" + quien.nombre, 40, 3600000)) return E(429, "Demasiados borrados por hora.");
    const r = await gh("DELETE", rutaRepo("/releases/assets/" + c[1]));
    return R(r.status, r.buf.length ? r.buf : "", { "Content-Type": "application/json" });
  }

  return E(404, "Ruta no permitida por el puente");
}

async function respuestaRelease(r, req, res, fin) {
  fin(r.status);
  let cuerpo = r.buf;
  if (r.status === 200 || r.status === 201) {
    try {
      const o = JSON.parse(r.buf.toString("utf8"));
      const base = urlPublica(req);
      cuerpo = Buffer.from(JSON.stringify(Array.isArray(o) ? o.map((x) => reescribirRelease(x, base)) : reescribirRelease(o, base)));
    } catch (e) {}
  }
  res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": cuerpo.length, "Cache-Control": "no-store" });
  res.end(cuerpo);
}

async function descargaAsset(idAsset, R, E) {
  const r = await gh("GET", rutaRepo("/releases/assets/" + idAsset), undefined, { Accept: "application/octet-stream" });
  if ((r.status === 302 || r.status === 301) && r.headers.location) return R(302, "", { Location: r.headers.location }, "descarga");
  if (r.status === 404) return E(404, "Archivo no encontrado");
  return E(502, "GitHub respondio " + r.status);
}
// Las descargas solo redirigen a una dirección firmada de GitHub (los bytes NO pasan por este
// servidor). Se recuerda 60 s qué archivos tiene cada release para no consultar GitHub en cada descarga.
const cacheEtiquetas = new Map();
async function descargaPorEtiqueta(req, res, tag, archivo, R, E) {
  let activos = null;
  const hit = cacheEtiquetas.get(tag);
  if (hit && ahoraMs() - hit.t < 60000) activos = hit.assets;
  if (!activos) {
    const rel = await gh("GET", rutaRepo("/releases/tags/" + encodeURIComponent(tag)));
    if (rel.status === 404) return E(404, "Release no encontrado");
    if (rel.status !== 200) return E(502, "GitHub respondio " + rel.status);
    const o = JSON.parse(rel.buf.toString("utf8"));
    activos = (o.assets || []).map((x) => ({ id: x.id, name: x.name }));
    if (cacheEtiquetas.size > 300) cacheEtiquetas.clear();
    cacheEtiquetas.set(tag, { t: ahoraMs(), assets: activos });
  }
  const a = activos.find((x) => x.name === archivo);
  if (!a) { cacheEtiquetas.delete(tag); return E(404, "Archivo no encontrado en el release"); }
  return descargaAsset(String(a.id), R, E);
}

function subirAsset(req, res, idRelease, nombre, largo, label, R, E) {
  return new Promise((resolve) => {
    let path = "/repos/" + REPO + "/releases/" + idRelease + "/assets?name=" + encodeURIComponent(nombre);
    if (label) path += "&label=" + encodeURIComponent(String(label).slice(0, 100));
    const up = new URL(GH_UPLOADS + path);
    const lib = up.protocol === "http:" ? http : https;
    const salida = lib.request(up, {
      method: "POST",
      headers: ghCabeceras({ "Content-Type": req.headers["content-type"] || "application/octet-stream", "Content-Length": largo }),
    }, (gr) => {
      const trozos = []; gr.on("data", (d) => trozos.push(d));
      gr.on("end", () => {
        let buf = Buffer.concat(trozos);
        if (gr.statusCode === 201) {
          try { const o = JSON.parse(buf.toString("utf8")); o.url = urlPublica(req) + "/repos/" + REPO + "/releases/assets/" + o.id; buf = Buffer.from(JSON.stringify(o)); } catch (e) {}
        }
        R(gr.statusCode, buf, { "Content-Type": "application/json" }, "subida " + nombre + " (" + largo + " bytes)");
        resolve();
      });
    });
    salida.setTimeout(30 * 60000, () => salida.destroy(new Error("tiempo agotado")));
    salida.on("error", (e) => { E(502, "Fallo al subir: " + e.message); resolve(); });
    req.on("error", () => salida.destroy());
    req.pipe(salida);
  });
}

async function escribirContenido(req, archivo, rol, id, quien, R, E) {
  let cu;
  try { cu = JSON.parse((await leerCuerpo(req, 3 * 1048576)).toString("utf8")); } catch (e) { return E(400, "Cuerpo no valido"); }
  if (!cu || typeof cu.content !== "string") return E(400, "Falta el contenido");
  let nuevoTexto;
  try { nuevoTexto = Buffer.from(cu.content, "base64").toString("utf8"); } catch (e) { return E(400, "Contenido no valido"); }
  if (nuevoTexto.trim() === "") return E(400, "No se permite escribir contenido vacio.");
  const mensaje = "[puente " + rol + (quien.nombre ? ": " + String(quien.nombre).slice(0, 40) : "") + "] " + String(cu.message || "Actualizacion").slice(0, 160);

  if (SOLO_PROPIETARIO.has(archivo) && rol !== "propietario") return E(403, "Este archivo solo lo cambia el propietario.");
  const esUsuario = Object.prototype.hasOwnProperty.call(ARCHIVOS_USUARIO, archivo);
  const esAdminFile = SOLO_ADMIN.has(archivo);
  if (!esUsuario && !esAdminFile && !SOLO_PROPIETARIO.has(archivo) && rol !== "propietario") return E(403, "Ese archivo no se puede escribir desde el puente.");
  if (esAdminFile && rol === "usuario") return E(403, "Necesitas la clave de administrador del puente.");

  let actual;
  try { actual = await leerArchivo(archivo, true); } catch (e) { return E(502, "No se pudo leer el archivo actual: " + e.message); }
  if (actual.existe && cu.sha && cu.sha !== actual.sha) return E(409, archivo + " does not match " + cu.sha + " (el archivo cambio, reintenta)");
  if (actual.existe && !cu.sha) return E(422, "Falta sha del archivo existente");
  let nuevoJson = null;
  try { nuevoJson = JSON.parse(nuevoTexto); } catch (e) {}

  if (esUsuario && rol === "usuario") {
    if (nuevoJson === null) return E(400, "El contenido no es JSON valido");
    if (actual.existe && actual.json === null) return E(409, "El archivo actual no se pudo interpretar; no se modifica.");
    const r = await ARCHIVOS_USUARIO[archivo](actual.json, nuevoJson, { usuario: id.usuario, instalacion: id.id });
    if (!r.ok) return E(403, "Rechazado: " + r.motivo);
    if (r.nuevo !== undefined) nuevoTexto = JSON.stringify(r.nuevo, null, 1);
  } else {
    const motivo = guardia(archivo, actual.json, nuevoTexto, nuevoJson, rol);
    if (motivo) return E(409, "Protegido: " + motivo + ". Si de verdad lo quieres, hazlo con el panel del propietario.");
  }
  const r = await escribirArchivo(archivo, nuevoTexto, actual.existe ? actual.sha : undefined, mensaje);
  let cuerpo = r.buf;
  return R(r.status, cuerpo, { "Content-Type": "application/json" }, archivo);
}

const servidor = http.createServer((req, res) => {
  manejar(req, res).catch((e) => {
    logLinea({ error: String(e && e.message), ruta: req.url });
    if (!res.headersSent) responder(res, 500, { message: "Error interno del puente" });
    else try { res.end(); } catch (x) {}
  });
});
servidor.requestTimeout = 0;
servidor.headersTimeout = 30000;
if (require.main === module) {
  servidor.listen(PORT, () => {
    console.log("Puente de la tienda " + VERSION + " listo en el puerto " + PORT);
    if (!GH_TOKEN) console.log("AVISO: falta GITHUB_TOKEN");
    if (!REPO) console.log("AVISO: falta REPO_TIENDA (formato dueno/repositorio)");
    if (CLAVE_PROPIETARIO.length < 12) console.log("AVISO: CLAVE_PROPIETARIO debe tener al menos 12 caracteres; sin ella no hay propietario.");
  });
}
module.exports = { servidor, _p: { deepEqual, soloAgrega, guardia, cuposDe } };

