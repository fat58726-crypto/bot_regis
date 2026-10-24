'use strict';
/**
 * Recibe el Excel (GASTOS_2026.xlsx) en memoria, normaliza fechas/operadores y
 * reemplaza por completo la pestaña BASE_EXCEL del Google Sheet.
 *
 * Fuente 1: hoja "BASE" (valores ya calculados por Excel).
 * Fuente 2 (respaldo): pestañas mensuales ENERO … DICIEMBRE, si BASE no trae datos.
 */
const ExcelJS = require('exceljs');
const { filasAGastos, serialAISO, serialToDate, resolverTab } = require('./dashboard');

const MESES = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
const HEAD = ['MES','FECHA','OPERADOR','DESTINO','DIAS','ANTICIPO','COMIDA','AGUA','CASETAS','PENSION','FEDERALES','OTROS','TOTAL','DIFERENCIA'];

function valorCelda(c) {
  let v = c.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;                       // fórmula → su resultado calculado
    else if (v.richText) v = v.richText.map(t => t.text).join('');
    else if (v.text) v = v.text;
    else if (v.error) v = null;
  }
  if (v && typeof v === 'object' && v.error) v = null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);   // fecha → texto AAAA-MM-DD (sin zonas horarias)
  return v ?? null;
}

function hojaAMatriz(ws, forzarFecha = false) {
  const m = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    for (let i = 1; i <= Math.min(row.cellCount, 26); i++) arr.push(valorCelda(row.getCell(i)));
    m.push(arr);
  });
  if (forzarFecha && m.length) m[0][0] = 'FECHA';          // en las hojas mensuales A1 trae una hora, no el título
  return m;
}

async function extraerGastos(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let gastos = [];
  const base = wb.worksheets.find(w => w.name.trim().toUpperCase() === 'BASE');
  if (base) { try { gastos = filasAGastos(hojaAMatriz(base)); } catch (_) { gastos = []; } }
  let origen = 'hoja BASE';
  if (!gastos.length) {
    origen = 'pestañas mensuales';
    for (const ws of wb.worksheets) {
      if (!MESES.includes(ws.name.trim().toUpperCase())) continue;
      try { gastos.push(...filasAGastos(hojaAMatriz(ws, true))); } catch (_) { /* hoja sin formato esperado */ }
    }
  }
  return { gastos, origen };
}

async function escribirTab(sheets, spreadsheetId, tabPreferida, gastos) {
  let tab = await resolverTab(sheets, spreadsheetId, tabPreferida);
  if (!tab) {                                              // la pestaña no existe: se crea
    tab = 'BASE_EXCEL';
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: [{ addSheet: { properties: { title: tab } } }] } });
  }
  const filas = gastos
    .sort((a, b) => a.fecha - b.fecha)
    .map(g => [
      MESES[serialToDate(g.fecha).getUTCMonth()], serialAISO(g.fecha), g.operador, g.destino,
      g.dias, g.anticipo, g.comida, g.agua, g.casetas, g.pension, g.federales, g.otros,
      g.total, g.anticipo - g.total,
    ]);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tab}!A1`, valueInputOption: 'RAW',
    resource: { values: [HEAD, ...filas] },
  });
  return { tab, n: filas.length };
}

async function importarExcel({ buffer, getSheets, spreadsheetId, tab }) {
  const { gastos, origen } = await extraerGastos(buffer);
  if (!gastos.length) throw new Error('No encontré registros en el Excel (busqué la hoja BASE y las pestañas de cada mes).');
  const r = await escribirTab(getSheets(), spreadsheetId, tab, gastos);
  const fechas = gastos.map(g => g.fecha);
  return { ...r, origen, desde: serialAISO(Math.min(...fechas)), hasta: serialAISO(Math.max(...fechas)) };
}


// ── Excel de RENDIMIENTOS (una pestaña ECO#NN por tractor) ───────────
// Fórmulas SIN separadores de argumentos: valen igual en hojas con coma o con punto y coma (según el idioma de la hoja).
const fDif  = r => `=(D${r}-E${r})*(E${r}<>"")`;
const fRend = r => `=IFERROR((D${r}-E${r})/G${r}*(E${r}<>""))`;
const esHojaEco = nombre => /^ECO\s*#/i.test(String(nombre).trim());

/** 'rendimientos' si el libro trae pestañas ECO#NN; si no, 'gastos' */
async function detectarTipo(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const nombres = wb.worksheets.map(w => w.name);
  const tieneEco = nombres.some(esHojaEco);
  const tieneGastos = nombres.some(n => n.trim().toUpperCase() === 'BASE' || MESES.includes(n.trim().toUpperCase()));
  return tieneEco && !tieneGastos ? 'rendimientos' : 'gastos';
}

/**
 * Crea en el Google Sheet de diésel una pestaña por cada hoja ECO#NN del Excel.
 * NUNCA pisa una pestaña que ya existe (ahí pueden estar cargas capturadas por el bot): solo la reporta como omitida.
 */
async function importarRendimientos({ buffer, getSheets, spreadsheetId }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const existentes = new Set(meta.data.sheets.map(h => h.properties.title.trim().toLowerCase()));
  const creadas = [], omitidas = [];
  let filasTotal = 0;

  for (const ws of wb.worksheets) {
    if (!esHojaEco(ws.name)) continue;
    const titulo = ws.name.trim();
    if (existentes.has(titulo.toLowerCase())) { omitidas.push(titulo); continue; }

    // matriz A1:J(última fila con fecha); F y H se escriben como fórmulas, igual que las filas que agrega el bot
    const mat = [];
    let ultima = 2;
    ws.eachRow({ includeEmpty: false }, (row, n) => { if (n >= 3 && valorCelda(row.getCell(1)) != null && valorCelda(row.getCell(1)) !== '') ultima = Math.max(ultima, n); });
    for (let r = 1; r <= ultima; r++) {
      const fila = [];
      for (let c = 1; c <= 10; c++) fila.push(valorCelda(ws.getRow(r).getCell(c)) ?? '');
      if (r >= 3 && fila[0] !== '') {
        fila[5] = fDif(r);
        fila[7] = fRend(r);
      } else if (r >= 3) { fila[5] = ''; fila[7] = ''; }
      mat.push(fila);
    }
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: [{ addSheet: { properties: { title: titulo } } }] } });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${titulo.replace(/'/g, "''")}'!A1`, valueInputOption: 'USER_ENTERED', resource: { values: mat },
    });
    creadas.push(titulo);
    filasTotal += mat.filter((f, i) => i >= 2 && f[0] !== '').length;
  }
  if (!creadas.length && !omitidas.length) throw new Error('No encontré hojas ECO#NN en ese Excel.');
  return { creadas, omitidas, filas: filasTotal };
}

module.exports = { importarExcel, extraerGastos, detectarTipo, importarRendimientos, fDif, fRend };
