'use strict';
/**
 * Dashboard semanal de gastos por operador — Transportes Regis
 *
 * - Lee una pestaña de Google Sheets (por defecto BASE_EXCEL) con columnas:
 *   MES, FECHA, OPERADOR, DESTINO, DIAS, ANTICIPO, COMIDA, AGUA, CASETAS,
 *   PENSION, FEDERALES, OTROS, TOTAL, DIFERENCIA  (el orden no importa, se detecta por encabezado)
 * - Agrega Lunes–Domingo por operador y compara contra la semana anterior
 * - Entrega los datos como JSON para la pestaña "Gasto semanal" del panel (/api/admin/semanal)
 * - Cada sábado manda a los admins por Telegram un resumen con enlace al panel
 */
const cron = require('node-cron');

const TZ = 'America/Mexico_City';
const CONCEPTOS = ['comida', 'agua', 'casetas', 'pension', 'federales', 'otros'];
const ETIQ = { comida: 'Comidas', agua: 'Aguas', casetas: 'Casetas', pension: 'Pensión', federales: 'Federales', otros: 'Otros' };
const MESES_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DIAS_ES = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

// ── Utilidades ───────────────────────────────────────────
const quitaAcentos = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const normHeader   = s => quitaAcentos(s).toUpperCase().replace(/[^A-Z]/g, '');
const num = v => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('es-MX');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = s => s.charAt(0) + s.slice(1).toLowerCase();

const EPOCH = Date.UTC(1899, 11, 30);                       // serial 0 de Excel/Sheets
const serialToDate = s => new Date(EPOCH + s * 86400000);
const dateToSerial = (y, m, d) => Math.round((Date.UTC(y, m, d) - EPOCH) / 86400000);

function hoyMX() {
  const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);
  return dateToSerial(y, m - 1, d);
}

/** Acepta serial (número), Date, 'YYYY-MM-DD', 'DD/MM/YYYY', '20/Abr'. Devuelve serial entero o null. */
function parseFecha(v) {
  if (v instanceof Date) return dateToSerial(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'number') return v > 20000 ? Math.floor(v) : null;
  if (typeof v !== 'string') return null;
  const t = quitaAcentos(v).trim().toLowerCase();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return dateToSerial(+m[1], +m[2] - 1, +m[3]);
  if ((m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/))) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return dateToSerial(y, +m[2] - 1, +m[1]);
  }
  if ((m = t.match(/^(\d{1,2})[\/\-\s]([a-z]{3})/))) {            // "20/Abr" sin año → año actual
    const mes = MESES_ES.indexOf(m[2]);
    if (mes < 0) return null;
    const hoy = serialToDate(hoyMX());
    let s = dateToSerial(hoy.getUTCFullYear(), mes, +m[1]);
    if (s > hoyMX() + 7) s = dateToSerial(hoy.getUTCFullYear() - 1, mes, +m[1]);
    return s;
  }
  return null;
}

const normOperador = s => {
  const o = quitaAcentos(s || '').toUpperCase().trim();
  return o === 'RAFAEL' ? 'RAFA' : o;
};

// ── Lectura de Google Sheets ─────────────────────────────
const ALIAS = {
  fecha: ['FECHA', 'FECHADEVIAJES', 'FECHAVIAJE'],
  operador: ['OPERADOR', 'NOMBRE'],
  destino: ['DESTINO', 'ORIGENDESTINO'],
  dias: ['DIAS'],
  anticipo: ['ANTICIPO'],
  comida: ['COMIDA', 'COMIDAS'],
  agua: ['AGUA', 'AGUAS'],
  casetas: ['CASETAS'],
  pension: ['PENSION'],
  federales: ['FEDERALES'],
  otros: ['OTROS'],
  total: ['TOTAL', 'TOTALGASTOS'],
};

async function leerGastos(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:Z5000`,
    valueRenderOption: 'UNFORMATTED_VALUE',      // números reales, sin "$" ni comas
    dateTimeRenderOption: 'SERIAL_NUMBER',       // fechas siempre como serial
  });
  return filasAGastos(res.data.values || []);
}

/** values = matriz tal cual la regresa la API (primera fila = encabezados) */
function filasAGastos(values) {
  if (!values.length) return [];
  const heads = values[0].map(normHeader);
  const col = {};
  for (const [campo, nombres] of Object.entries(ALIAS)) col[campo] = heads.findIndex(h => nombres.includes(h));
  if (col.fecha < 0 || col.operador < 0) throw new Error(`La pestaña necesita columnas FECHA y OPERADOR (encabezados: ${values[0].join(', ')})`);

  const out = [];
  for (const r of values.slice(1)) {
    const fecha = parseFecha(r[col.fecha]);
    const operador = normOperador(r[col.operador]);
    if (fecha == null || !operador) continue;     // filas vacías o sin fecha válida
    const g = { fecha, operador, destino: r[col.destino] || '', dias: num(r[col.dias]), anticipo: num(r[col.anticipo]) };
    for (const c of CONCEPTOS) g[c] = col[c] >= 0 ? num(r[col[c]]) : 0;
    const suma = CONCEPTOS.reduce((s, c) => s + g[c], 0);
    g.total = col.total >= 0 && r[col.total] !== undefined && r[col.total] !== '' ? num(r[col.total]) : suma;
    out.push(g);
  }
  return out;
}

// ── Agregación ───────────────────────────────────────────
/** Lunes–Domingo de la semana que contiene `serial` */
function semanaDe(serial) {
  const dow = serialToDate(serial).getUTCDay();          // 0=Dom
  const lunes = serial - ((dow + 6) % 7);
  return { ini: lunes, fin: lunes + 6 };
}

function agregar(gastos, ini, fin) {
  const ops = {};
  const viajes = gastos.filter(g => g.fecha >= ini && g.fecha <= fin);
  for (const g of viajes) {
    const o = (ops[g.operador] ||= { nombre: g.operador, viajes: 0, anticipo: 0, total: 0, ...Object.fromEntries(CONCEPTOS.map(c => [c, 0])) });
    o.viajes++; o.anticipo += g.anticipo; o.total += g.total;
    for (const c of CONCEPTOS) o[c] += g[c];
  }
  const lista = Object.values(ops).sort((a, b) => b.total - a.total);
  lista.forEach(o => { o.saldo = o.anticipo - o.total; });
  const porConcepto = Object.fromEntries(CONCEPTOS.map(c => [c, lista.reduce((s, o) => s + o[c], 0)]));
  return {
    ini, fin, viajes, lista, porConcepto,
    total: lista.reduce((s, o) => s + o.total, 0),
    nViajes: viajes.length,
  };
}

function construirDatos(gastos, refSerial) {
  const { ini, fin } = semanaDe(refSerial);
  const actual = agregar(gastos, ini, fin);
  const previa = agregar(gastos, ini - 7, fin - 7);
  const tendencia = [];
  for (let i = 7; i >= 0; i--) {
    const w = agregar(gastos, ini - 7 * i, fin - 7 * i);
    tendencia.push({ ini: w.ini, total: w.total });
  }
  const prevPorOp = Object.fromEntries(previa.lista.map(o => [o.nombre, o.total]));
  return { actual, previa, tendencia, prevPorOp };
}

// ── Presentación ─────────────────────────────────────────
function fmtDia(s) { const d = serialToDate(s); return `${d.getUTCDate()} ${MESES_ES[d.getUTCMonth()]}`; }
function rangoTexto(ini, fin) {
  const a = serialToDate(ini), b = serialToDate(fin);
  return `${DIAS_ES[a.getUTCDay()]} ${a.getUTCDate()} ${MESES_LARGO[a.getUTCMonth()]} – ${DIAS_ES[b.getUTCDay()]} ${b.getUTCDate()} ${MESES_LARGO[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}
const variacion = (a, p) => (p > 0 ? ((a - p) / p) * 100 : null);
const flecha = v => (v == null ? '—' : `${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${Math.abs(v).toFixed(0)}%`);

function generarTexto({ actual, previa }) {
  if (!actual.nViajes) return `📊 <b>Dashboard semanal</b>\n${rangoTexto(actual.ini, actual.fin)}\n\nNo hay gastos registrados en esa semana.`;
  const v = variacion(actual.total, previa.total);
  let t = `📊 <b>Gasto semanal de operadores</b>\n${rangoTexto(actual.ini, actual.fin)}\n\n` +
    `💰 <b>Total: ${money(actual.total)}</b>  (${flecha(v)} vs semana anterior: ${money(previa.total)})\n` +
    `🚛 Viajes: ${actual.nViajes}\n\n`;
  actual.lista.forEach((o, i) => { t += `${['🥇','🥈','🥉'][i] || '▫️'} ${cap(o.nombre)}: <b>${money(o.total)}</b> · ${o.viajes} viajes\n`; });
  const top = Object.entries(actual.porConcepto).sort((a, b) => b[1] - a[1])[0];
  t += `\n📌 Concepto más alto: ${ETIQ[top[0]]} (${money(top[1])})\n📎 Te mando el dashboard completo en el archivo.`;
  return t;
}

// ── Pestaña del Sheet ────────────────────────────────────
const TABS_ACEPTADAS = ['BASE_EXCEL', 'BASE_EXCE'];
async function resolverTab(sheets, spreadsheetId, preferido) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titulos = meta.data.sheets.map(h => h.properties.title);
  const cand = [preferido, ...TABS_ACEPTADAS].filter(Boolean);
  return cand.find(c => titulos.includes(c)) || null;
}

const serialAISO = s => serialToDate(s).toISOString().slice(0, 10);

// ── Datos para el panel (JSON) ───────────────────────────
/** Semana a mostrar: la pedida; si no, la de hoy; si hoy aún no hay registros, la semana del último dato cargado. */
function resolverReferencia(gastos, refSerial) {
  if (refSerial != null) return refSerial;
  const ref = hoyMX();
  const w = semanaDe(ref);
  if (agregar(gastos, w.ini, w.fin).nViajes || !gastos.length) return ref;
  return Math.max(...gastos.map(g => g.fecha));
}

function datosParaPanel(gastos, refSerial) {
  const ref = resolverReferencia(gastos, refSerial);
  const d = construirDatos(gastos, ref);
  const { actual, previa } = d;
  const semanaHoy = semanaDe(hoyMX()).ini;
  const ultimo = gastos.length ? Math.max(...gastos.map(g => g.fecha)) : null;
  return {
    semana: { ini: serialAISO(actual.ini), fin: serialAISO(actual.fin), texto: rangoTexto(actual.ini, actual.fin) },
    refAnterior: serialAISO(actual.ini - 7),
    refSiguiente: actual.ini + 7 <= semanaHoy ? serialAISO(actual.ini + 7) : null,
    ultimoDato: ultimo ? serialAISO(ultimo) : null,
    total: actual.total, nViajes: actual.nViajes,
    previaTotal: previa.total, variacion: variacion(actual.total, previa.total),
    operadores: actual.lista.map(o => ({ ...o, previo: d.prevPorOp[o.nombre] || 0 })),
    conceptos: actual.porConcepto,
    tendencia: d.tendencia.map(t => ({ ini: serialAISO(t.ini), total: t.total })),
    top: [...actual.viajes].sort((a, b) => b.total - a.total).slice(0, 5)
      .map(g => ({ fecha: serialAISO(g.fecha), operador: g.operador, destino: g.destino, total: g.total })),
  };
}

async function datosSemanales({ getSheets, spreadsheetId, tab, ref }) {
  const sheets = getSheets();
  const tabReal = await resolverTab(sheets, spreadsheetId, tab);
  if (!tabReal) return { sinPestana: true };
  const gastos = await leerGastos(sheets, spreadsheetId, tabReal);
  const refSerial = ref ? parseFecha(ref) : null;
  return { tab: tabReal, ...datosParaPanel(gastos, refSerial) };
}

// ── Telegram + cron ──────────────────────────────────────
async function enviarResumen({ bot, chatIds, getSheets, spreadsheetId, tab, panelUrl, refSerial }) {
  const sheets = getSheets();
  const tabReal = await resolverTab(sheets, spreadsheetId, tab);
  if (!tabReal) throw new Error('No encuentro la pestaña BASE_EXCEL. Mándame el Excel por este chat y yo la creo.');
  const gastos = await leerGastos(sheets, spreadsheetId, tabReal);
  const datos = construirDatos(gastos, resolverReferencia(gastos, refSerial));
  let texto = generarTexto(datos);
  texto = texto.replace('📎 Te mando el dashboard completo en el archivo.',
    panelUrl ? `🔗 <a href="${panelUrl}">Abrir dashboard completo en el panel</a>` : '');
  for (const id of chatIds) await bot.sendMessage(id, texto, { parse_mode: 'HTML', disable_web_page_preview: true });
  return datos;
}

function programar({ bot, chatIds, getSheets, spreadsheetId, tab, panelUrl, expr = '0 9 * * 6' }) {
  if (!cron.validate(expr)) throw new Error(`DASHBOARD_CRON inválido: ${expr}`);
  cron.schedule(expr, async () => {
    try {
      await enviarResumen({ bot, chatIds, getSheets, spreadsheetId, tab, panelUrl });
      console.log('📊 Resumen semanal enviado');
    } catch (e) {
      console.error('❌ Error en resumen semanal:', e.message);
      chatIds.forEach(id => bot.sendMessage(id, `⚠️ No pude generar el resumen semanal: ${e.message}`).catch(() => {}));
    }
  }, { timezone: TZ });
  console.log(`📊 Resumen semanal programado (${expr}, ${TZ}) leyendo pestaña "${tab}"`);
}

module.exports = {
  resolverTab, serialAISO, serialToDate, hoyMX, programar, enviarResumen, datosSemanales,
  filasAGastos, construirDatos, datosParaPanel, generarTexto, parseFecha, semanaDe, dateToSerial,
};
