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

module.exports = { importarExcel, extraerGastos };
