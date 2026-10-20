'use strict';
 
const TelegramBot = require('node-telegram-bot-api');
const { google }  = require('googleapis');
const express     = require('express');
const path        = require('path');
const dashboard   = require('./dashboard');
const vale        = require('./vale');
const { importarExcel, detectarTipo, importarRendimientos } = require('./importarExcel');
 
const TOKEN       = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT        = process.env.PORT || 3000;
 
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map(s => s.trim().replace(/[^0-9]/g, ''))
  .filter(s => s.length > 0);
 
const SHEET_BOT    = '1i7uciYXLNuZ-DPxE8H0TAQyuegqVzegE751tUNhi7Qc';
const SHEET_DIESEL = process.env.DIESEL_SHEET_ID || '1tEmPW1BGE7MgMXD5iOsLwq8G46GxKkT8sRuqBkdFUOk';   // Google Sheet con las hojas ECO#NN

// Dashboard semanal: pestaña del Sheet donde se carga el Excel (variables opcionales en Railway)
const DASH_TAB  = process.env.DASHBOARD_TAB  || 'BASE_EXCEL';
const DASH_CRON = process.env.DASHBOARD_CRON || '0 9 * * 6';          // sábados 9:00 am (hora CDMX)
const DASH_TOKEN = () => process.env.DASHBOARD_TOKEN || 'regis2024';
const panelUrl  = () => WEBHOOK_URL ? `${WEBHOOK_URL}/dashboard?token=${DASH_TOKEN()}#semanal` : '';
 
const bot = new TelegramBot(TOKEN, { webHook: false });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.send('🚛 Bot Transportes Regis activo'));
app.post(`/bot${TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
 
// ── GOOGLE SHEETS ─────────────────────────────────────────
let _sheets = null;
function getSheets() {
  if (_sheets) return _sheets;
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}
 
async function getRows(sheetId, tab) {
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A1:Z2000` });
  return res.data.values || [];
}
 
async function appendRow(sheetId, tab, values) {
  await getSheets().spreadsheets.values.append({
    spreadsheetId: sheetId, range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED', resource: { values: [values] }
  });
}
 
async function updateCell(sheetId, range, value) {
  await getSheets().spreadsheets.values.update({
    spreadsheetId: sheetId, range,
    valueInputOption: 'USER_ENTERED', resource: { values: [[value]] }
  });
}
 
async function updateRow(sheetId, range, values) {
  await getSheets().spreadsheets.values.update({
    spreadsheetId: sheetId, range,
    valueInputOption: 'USER_ENTERED', resource: { values: [values] }
  });
}
 
// ── ESTADO PERSISTENTE EN SHEETS ─────────────────────────
async function getEstado(chatId) {
  try {
    const rows = await getRows(SHEET_BOT, 'Estado');
    const row  = rows.find(r => r[0] === String(chatId));
    if (!row || !row[1]) return { estado: null };
    return JSON.parse(row[1]);
  } catch (e) { return { estado: null }; }
}
 
async function setEstado(chatId, obj) {
  try {
    const rows   = await getRows(SHEET_BOT, 'Estado');
    const rowIdx = rows.findIndex(r => r[0] === String(chatId));
    const json   = JSON.stringify(obj);
    if (rowIdx >= 0) {
      await updateRow(SHEET_BOT, `Estado!A${rowIdx + 1}:B${rowIdx + 1}`, [String(chatId), json]);
    } else {
      if (rows.length === 0) await appendRow(SHEET_BOT, 'Estado', ['chatId', 'estado_json']);
      await appendRow(SHEET_BOT, 'Estado', [String(chatId), json]);
    }
  } catch (e) { console.error('Error guardando estado:', e.message); }
}
 
async function clearEstado(chatId) {
  await setEstado(chatId, { estado: null });
}
 
// ── HELPERS ───────────────────────────────────────────────
function isAdmin(chatId)   { return ADMIN_IDS.includes(String(chatId)); }
function esNumero(t)       { return /^\d+(\.\d+)?$/.test(String(t).trim()); }
function toNum(v)          { return parseFloat(v) || 0; }
 
function notificarAdmins(msg, opts = {}) {
  ADMIN_IDS.forEach(id => bot.sendMessage(id, msg, opts).catch(e => console.error('Admin notify error:', e.message)));
}
 
function notificarAdminsFoto(fileId, caption) {
  ADMIN_IDS.forEach(id => bot.sendPhoto(id, fileId, { caption }).catch(e => console.error('Error foto admin:', e.message)));
}
 
// ── MENÚS ─────────────────────────────────────────────────
const MENU_OP = { reply_markup: { inline_keyboard: [
  [{ text: '✅ Confirmar mi viaje',  callback_data: 'confirmar_viaje' }],
  [{ text: '💰 Reportar mis gastos', callback_data: 'iniciar_gastos'  }],
  [{ text: '📦 Registrar carga',     callback_data: 'iniciar_carga'   }],
  [{ text: '⛽ Reportar diésel',     callback_data: 'op_diesel'       }],
]}};
 
const MENU_ADMIN = { reply_markup: { inline_keyboard: [
  [{ text: '📋 Ver viajes',       callback_data: 'ver_viajes'     }, { text: '➕ Nuevos viajes', callback_data: 'nuevos_viajes' }],
  [{ text: '👥 Operadores',       callback_data: 'ver_operadores' }, { text: '⛽ Diésel',        callback_data: 'iniciar_diesel' }],
  [{ text: '📊 Resumen',          callback_data: 'ver_resumen'    }, { text: '📈 Gasto semanal', callback_data: 'ver_semanal' }],
]}};
 
const BTN_CANCELAR         = { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]] }};
const MENU_CONFIRM_GASTOS  = { reply_markup: { inline_keyboard: [[{ text: '✅ Guardar', callback_data: 'gastos_ok' }, { text: '🔄 Repetir', callback_data: 'gastos_repetir' }]] }};
const MENU_CONFIRM_CARGA   = { reply_markup: { inline_keyboard: [[{ text: '✅ Guardar', callback_data: 'carga_ok'  }, { text: '🔄 Repetir', callback_data: 'carga_repetir'  }]] }};
 
// ── PREGUNTAS ─────────────────────────────────────────────
const P_GASTOS = [
  { campo: 'fecha_viaje', pregunta: '📅 ¿Fecha del viaje?\nEjemplo: 20/Abr' },
  { campo: 'destino',     pregunta: '📍 ¿Origen y destino?\nEjemplo: Irapuato - Guadalajara' },
  { campo: 'cliente',     pregunta: '🏭 ¿Cliente?' },
  { campo: 'dias',        pregunta: '📅 ¿Cuántos días duró el viaje?' },
  { campo: 'anticipo',    pregunta: '💵 ¿Cuánto de anticipo te dieron?' },
  { campo: 'comida',      pregunta: '🍽️ ¿Cuánto en comidas? (0 si nada)' },
  { campo: 'aguas',       pregunta: '💧 ¿Cuánto en aguas? (0 si nada)' },
  { campo: 'casetas',     pregunta: '🛣️ ¿Cuánto en casetas? (0 si nada)' },
  { campo: 'pension',     pregunta: '🅿️ ¿Cuánto de pensión? (0 si nada)' },
  { campo: 'federales',   pregunta: '👮 ¿Cuánto de federales? (0 si nada)' },
  { campo: 'otros',       pregunta: '📦 ¿Otro gasto? (0 si nada)' },
  { campo: 'desc_otros',  pregunta: '📝 ¿En qué lo gastaron? (escribe "ninguno" si no aplica)' },
];
 
const P_CARGA = [
  { campo: 'fecha_carga', pregunta: '📅 ¿Fecha de la carga?\nEjemplo: 20/Abr' },
  { campo: 'lugar',       pregunta: '📍 ¿En dónde cargas?' },
  { campo: 'comida',      pregunta: '🍽️ ¿Cuánto en comidas? (0 si nada)' },
  { campo: 'aguas',       pregunta: '💧 ¿Cuánto en aguas? (0 si nada)' },
];
 
const P_DIESEL = [
  { campo: 'operador', pregunta: '👤 ¿Qué operador?' },
  { campo: 'tracto',   pregunta: '🚛 ¿Número de tracto?' },
  { campo: 'km_nuevo', pregunta: '📏 Kilometraje actual' },
  { campo: 'km_ant',   pregunta: '📏 Kilometraje anterior' },
  { campo: 'litros',   pregunta: '⛽ ¿Cuántos litros?' },
  { campo: 'vale',     pregunta: '🔢 ¿Número de vale?' },
];
 
// Diésel con foto del vale (operadores y admins)
const BTN_HOY = { reply_markup: { inline_keyboard: [
  [{ text: '📅 Hoy', callback_data: 'dv_hoy' }],
  [{ text: '❌ Cancelar', callback_data: 'cancelar' }],
]}};
const MENU_CONFIRM_DV = { reply_markup: { inline_keyboard: [[{ text: '✅ Guardar', callback_data: 'dv_ok' }, { text: '🔄 Repetir', callback_data: 'dv_repetir' }]] }};

// Evita que varias fotos (álbum) o mensajes del mismo chat se pisen al guardar el estado
const _colas = new Map();
function serializar(chatId, fn) {
  const prev = _colas.get(chatId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _colas.set(chatId, next);
  next.finally(() => { if (_colas.get(chatId) === next) _colas.delete(chatId); }).catch(() => {});
  return next;
}

const NUMERICOS = ['anticipo','comida','aguas','casetas','pension','federales','otros','dias','km_nuevo','km_ant','litros'];
 
const P_VIAJE = [
  { campo: 'fecha',   pregunta: '📅 ¿Fecha del viaje?\nEjemplo: 20/Abr' },
  { campo: 'cliente', pregunta: '🏭 ¿Cliente?' },
  { campo: 'destino', pregunta: '📍 ¿Destino?' },
  { campo: 'hora',    pregunta: '🕐 ¿Hora de salida?\nEjemplo: 8:00am (o escribe "Sin cita")' },
];
 
// ── OPERADORES ────────────────────────────────────────────
async function getOperadores() {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  const ops  = {};
  rows.forEach(r => { if (r[0] && r[0] !== 'chatId') ops[r[0]] = { chatId: r[0], nombre: r[1], tracto: r[2] }; });
  return ops;
}
 
async function saveOperador(chatId, nombre, tracto) {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  if (rows.length === 0) await appendRow(SHEET_BOT, 'Operadores', ['chatId','nombre','tracto']);
  const idx = rows.findIndex(r => r[0] === String(chatId));
  if (idx >= 0) {
    await updateRow(SHEET_BOT, `Operadores!A${idx+1}:C${idx+1}`, [String(chatId), nombre, tracto]);
  } else {
    await appendRow(SHEET_BOT, 'Operadores', [String(chatId), nombre, tracto]);
  }
}
 
// ── VIAJES ────────────────────────────────────────────────
async function getViajes() {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  return rows
    .filter(r => r[0] && r[0] !== 'idx')
    .map(r => ({ idx: r[0], fecha: r[1], cliente: r[2], destino: r[3], hora: r[4], operador: r[5]||'', confirmado: r[6]||'' }));
}
 
async function saveViaje(v) {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  if (rows.length === 0) await appendRow(SHEET_BOT, 'Viajes', ['idx','fecha','cliente','destino','hora','operador','confirmado']);
  const idx = rows.filter(r => r[0] !== 'idx').length + 1;
  await appendRow(SHEET_BOT, 'Viajes', [idx, v.fecha, v.cliente, v.destino, v.hora, v.operador||'', '']);
  return idx;
}
 
async function getViajeRowIdx(idx) {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  return rows.findIndex(r => String(r[0]) === String(idx));
}
 
async function borrarViaje(idx) {
  const sheets = getSheets();
  const rows   = await getRows(SHEET_BOT, 'Viajes');
  const rowIdx = rows.findIndex(r => String(r[0]) === String(idx));
  if (rowIdx < 0) return false;
  const meta  = await sheets.spreadsheets.get({ spreadsheetId: SHEET_BOT });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'Viajes');
  if (!sheet) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_BOT,
    resource: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIdx, endIndex: rowIdx + 1 } } }] }
  });
  return true;
}
 
async function resetViajesConfirmados() {
  const sheets  = getSheets();
  const rows    = await getRows(SHEET_BOT, 'Viajes');
  const meta    = await sheets.spreadsheets.get({ spreadsheetId: SHEET_BOT });
  const sheet   = meta.data.sheets.find(s => s.properties.title === 'Viajes');
  if (!sheet) return 0;
  const toDelete = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][6] && rows[i][6].toLowerCase() === 'si') toDelete.push(i);
  }
  if (toDelete.length === 0) return 0;
  for (const rowIdx of toDelete) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_BOT,
      resource: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIdx, endIndex: rowIdx + 1 } } }] }
    });
  }
  return toDelete.length;
}
 
async function guardarRemision(op, viaje, archivos) {
  try {
    const rows = await getRows(SHEET_BOT, 'Remisiones');
    if (rows.length === 0) {
      await appendRow(SHEET_BOT, 'Remisiones', ['Fecha','Operador','Tracto','Cliente','Destino','Fecha Viaje','Datos Remision','Tiene Fotos']);
    }
    const fecha = new Date().toLocaleDateString('es-MX');
    const textosRemision = archivos.filter(a => a.tipo === 'texto').map(a => a.texto).join(' | ');
    const tieneFotos = archivos.some(a => a.tipo === 'foto') ? 'Sí' : 'No';
    await appendRow(SHEET_BOT, 'Remisiones', [fecha, op.nombre, op.tracto, viaje.cliente || '', viaje.destino || '', viaje.fecha || '', textosRemision || '(solo fotos)', tieneFotos]);
  } catch(e) { console.error('Error guardando remisión:', e.message); }
}
 
function resumenGastos(d, anticipo, total, diferencia) {
  return `📋 *Revisa tus gastos:*\n\n` +
    `📅 Fecha:      ${d.fecha_viaje}\n📍 Destino:    ${d.destino}\n🏭 Cliente:    ${d.cliente}\n📅 Días:       ${d.dias}\n\n` +
    `💵 Anticipo:   $${anticipo.toFixed(2)}\n🍽️ Comidas:    $${toNum(d.comida).toFixed(2)}\n` +
    `💧 Aguas:      $${toNum(d.aguas).toFixed(2)}\n🛣️ Casetas:    $${toNum(d.casetas).toFixed(2)}\n` +
    `🅿️ Pensión:    $${toNum(d.pension).toFixed(2)}\n👮 Federales:  $${toNum(d.federales).toFixed(2)}\n` +
    `📦 Otros:      $${toNum(d.otros).toFixed(2)}\n📝 Desc otros: ${d.desc_otros}\n\n` +
    `💰 *Total:     $${total.toFixed(2)}*\n${diferencia >= 0 ? '✅' : '🔴'} *Diferencia:  $${diferencia.toFixed(2)}*\n\n¿Todo correcto?`;
}
 
// ═══════════════════════════════════════════════════════════
//   COMANDOS
// ═══════════════════════════════════════════════════════════
 
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await clearEstado(chatId);
  if (isAdmin(chatId)) return bot.sendMessage(chatId, `👋 *Bienvenido Admin!*\n\n¿Qué quieres hacer?`, { parse_mode:'Markdown', ...MENU_ADMIN });
  const ops = await getOperadores();
  const op  = ops[String(chatId)];
  if (op) {
    bot.sendMessage(chatId, `👋 Hola *${op.nombre}* 🚛\n\n¿Qué necesitas?`, { parse_mode:'Markdown', ...MENU_OP });
  } else {
    bot.sendMessage(chatId, `👋 Bienvenido al Bot de Transportes Regis 🚛\n\nRegístrate con:\n/registrar NOMBRE TRACTO\n\nEjemplo:\n/registrar Rafael 9`);
  }
});
 
bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  await clearEstado(chatId);
  if (isAdmin(chatId)) return bot.sendMessage(chatId, '🔄 Reiniciado.', MENU_ADMIN);
  const ops = await getOperadores();
  const op  = ops[String(chatId)];
  bot.sendMessage(chatId, '🔄 Listo.', op ? { parse_mode:'Markdown', ...MENU_OP } : {});
});
 
bot.onText(/\/miadmin/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🔎 Tu ID: \`${chatId}\`\nAdmin: *${isAdmin(chatId)?'SÍ ✅':'NO ❌'}*`, { parse_mode:'Markdown' });
});
 
bot.onText(/\/registrar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (isAdmin(chatId)) return bot.sendMessage(chatId, '⚠️ Eres admin, no necesitas registrarte.', MENU_ADMIN);
  const parts = match[1].trim().split(' ');
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Ejemplo:\n/registrar Rafael 9');
  try {
    await saveOperador(chatId, parts[0], parts[1]);
    bot.sendMessage(chatId, `✅ Registrado como *${parts[0]}* — Tracto #${parts[1]}`, { parse_mode:'Markdown', ...MENU_OP });
    notificarAdmins(`🚛 Nuevo operador: *${parts[0]}* — Tracto #${parts[1]}`, { parse_mode:'Markdown' });
  } catch(e) { bot.sendMessage(chatId, '❌ Error al registrar. Intenta de nuevo.'); }
});
 
bot.onText(/\/asignar (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const idx    = match[1];
  const nombre = match[2].trim();
  try {
    const rowIdx = await getViajeRowIdx(idx);
    if (rowIdx < 0) return bot.sendMessage(chatId, `❌ No existe el viaje #${idx}`);
    await updateCell(SHEET_BOT, `Viajes!F${rowIdx+1}`, nombre);
    const rows  = await getRows(SHEET_BOT, 'Viajes');
    const viaje = rows[rowIdx];
    const ops   = await getOperadores();
    const op    = Object.values(ops).find(o => o.nombre.toLowerCase() === nombre.toLowerCase());
    bot.sendMessage(chatId, `✅ Viaje #${idx} asignado a *${nombre}*`, { parse_mode:'Markdown', ...MENU_ADMIN });
    notificarAdmins(`📋 Viaje #${idx} asignado a *${nombre}*\n📍 ${viaje[3]} | 📅 ${viaje[1]}`, { parse_mode:'Markdown' });
    if (op) {
      bot.sendMessage(op.chatId,
        `🚛 *¡Tienes un nuevo viaje!*\n\n📍 *Destino:* ${viaje[3]}\n📅 *Fecha:* ${viaje[1]}\n🕐 *Hora:* ${viaje[4]||'Por confirmar'}\n🏭 *Cliente:* ${viaje[2]}\n\n¿Puedes confirmarlo?`,
        { parse_mode:'Markdown', ...MENU_OP });
    }
  } catch(e) {
    console.error('Error /asignar:', e.message);
    bot.sendMessage(chatId, '❌ Error al asignar. Intenta de nuevo.');
  }
});
 
bot.onText(/\/borrar (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  try {
    const viajes = await getViajes();
    const viaje  = viajes.find(v => v.idx === match[1]);
    if (!viaje) return bot.sendMessage(chatId, `❌ No existe el viaje #${match[1]}`);
    const ok = await borrarViaje(match[1]);
    if (ok) bot.sendMessage(chatId, `🗑️ Viaje #${match[1]} eliminado\n📍 ${viaje.destino} | ${viaje.fecha}`, { parse_mode:'Markdown', ...MENU_ADMIN });
    else    bot.sendMessage(chatId, '❌ No se pudo borrar.');
  } catch(e) { bot.sendMessage(chatId, '❌ Error al borrar.'); }
});
 
bot.onText(/\/resetviajes/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  try {
    const n = await resetViajesConfirmados();
    if (n === 0) {
      bot.sendMessage(chatId, '✅ No había viajes confirmados que limpiar.', MENU_ADMIN);
    } else {
      bot.sendMessage(chatId, `🗑️ *Reset completado*\n\nSe eliminaron *${n}* viaje(s) confirmado(s).\nLos viajes pendientes se conservaron.`, { parse_mode:'Markdown', ...MENU_ADMIN });
    }
  } catch(e) {
    console.error('Error /resetviajes:', e.message);
    bot.sendMessage(chatId, '❌ Error al resetear viajes.');
  }
});
 
// ═══════════════════════════════════════════════════════════
//   CALLBACKS
// ═══════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  bot.answerCallbackQuery(query.id).catch(()=>{});
 
  try {
    if (data === 'cancelar') {
      await clearEstado(chatId);
      return isAdmin(chatId)
        ? bot.sendMessage(chatId, '↩️ Cancelado.', MENU_ADMIN)
        : bot.sendMessage(chatId, '↩️ Cancelado.', MENU_OP);
    }
 
    if (data === 'confirmar_viaje') {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
      const viajes     = await getViajes();
      const misViajes  = viajes.filter(v =>
        v.operador.toLowerCase().trim() === op.nombre.toLowerCase().trim() &&
        v.confirmado !== 'si'
      );
      if (misViajes.length === 0) return bot.sendMessage(chatId, '📋 No tienes viajes pendientes.\n\n¿Qué más necesitas?', MENU_OP);
 
      if (misViajes.length === 1) {
        const miViaje = misViajes[0];
        const rowIdx  = await getViajeRowIdx(miViaje.idx);
        if (rowIdx >= 0) await updateCell(SHEET_BOT, `Viajes!G${rowIdx+1}`, 'si');
        notificarAdmins(`✅ *${op.nombre}* confirmó su viaje\n📍 ${miViaje.destino} — ${miViaje.fecha}\n🏭 ${miViaje.cliente}`, { parse_mode:'Markdown' });
        await setEstado(chatId, { estado: 'esperando_remision', viaje: miViaje, operador: op, archivos: [] });
        bot.sendMessage(chatId,
          `✅ ¡Viaje confirmado!\n\n📍 *${miViaje.destino}*\n📅 ${miViaje.fecha}\n\n📋 Ahora envíame tu *remisión y caja* (fotos o números).\nCuando termines escribe *listo*`,
          { parse_mode:'Markdown' });
        return;
      }
 
      const botones = misViajes.map(v => ([{
        text: `📍 ${v.destino} — ${v.fecha} (${v.cliente})`,
        callback_data: `elegir_viaje_${v.idx}`
      }]));
      botones.push([{ text: '❌ Cancelar', callback_data: 'cancelar' }]);
      bot.sendMessage(chatId,
        `🚛 Tienes *${misViajes.length}* viajes pendientes.\n¿Cuál quieres confirmar?`,
        { parse_mode:'Markdown', reply_markup: { inline_keyboard: botones } });
      return;
    }
 
    if (data.startsWith('elegir_viaje_')) {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.');
      const idxElegido = data.replace('elegir_viaje_', '');
      const viajes     = await getViajes();
      const miViaje    = viajes.find(v => String(v.idx) === String(idxElegido));
      if (!miViaje) return bot.sendMessage(chatId, '❌ No se encontró ese viaje.', MENU_OP);
      const rowIdx = await getViajeRowIdx(miViaje.idx);
      if (rowIdx >= 0) await updateCell(SHEET_BOT, `Viajes!G${rowIdx+1}`, 'si');
      notificarAdmins(`✅ *${op.nombre}* confirmó su viaje\n📍 ${miViaje.destino} — ${miViaje.fecha}\n🏭 ${miViaje.cliente}`, { parse_mode:'Markdown' });
      await setEstado(chatId, { estado: 'esperando_remision', viaje: miViaje, operador: op, archivos: [] });
      bot.sendMessage(chatId,
        `✅ ¡Viaje confirmado!\n\n📍 *${miViaje.destino}*\n📅 ${miViaje.fecha}\n\n📋 Ahora envíame tu *remisión y caja* (fotos o números).\nCuando termines escribe *listo*`,
        { parse_mode:'Markdown' });
      return;
    }
 
    if (data === 'iniciar_gastos') {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
      await setEstado(chatId, { estado: 'gastos', paso: 0, datos: {} });
      bot.sendMessage(chatId, `💰 *Reporte de Gastos*\n\n${P_GASTOS[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }
 
    if (data === 'iniciar_carga') {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
      await setEstado(chatId, { estado: 'carga', paso: 0, datos: {} });
      bot.sendMessage(chatId, `📦 *Registrar Carga*\n\n${P_CARGA[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }
 
    if (data === 'gastos_ok') {
      const st = await getEstado(chatId);
      if (!st || st.estado !== 'gastos_revision') return;
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      const d   = st.datos;
      await clearEstado(chatId);
      const total      = ['comida','aguas','casetas','pension','federales','otros'].reduce((s,k) => s+toNum(d[k]), 0);
      const anticipo   = toNum(d.anticipo);
      const diferencia = anticipo - total;
      const rows = await getRows(SHEET_BOT, 'Gastos');
      if (rows.length === 0) await appendRow(SHEET_BOT, 'Gastos', ['Fecha','Operador','Tracto','Cliente','Destino','Días','Anticipo','Comida','Aguas','Casetas','Pensión','Federales','Otros','Descripción Otros','Total','Diferencia']);
      await appendRow(SHEET_BOT, 'Gastos', [d.fecha_viaje, op.nombre, op.tracto, d.cliente, d.destino, d.dias, anticipo, toNum(d.comida), toNum(d.aguas), toNum(d.casetas), toNum(d.pension), toNum(d.federales), toNum(d.otros), d.desc_otros, total, diferencia]);
      bot.sendMessage(chatId, `${diferencia>=0?'✅':'🔴'} *Gastos guardados correctamente* 👍`, { parse_mode:'Markdown', ...MENU_OP });
      notificarAdmins(`💰 *Gastos de ${op.nombre}*\n📅 ${d.fecha_viaje} | 📍 ${d.destino} | 🏭 ${d.cliente} | ${d.dias} día(s)\nAnticipo: $${anticipo} | Total: $${total.toFixed(2)}\n${diferencia>=0?'✅':'🔴'} Diferencia: $${diferencia.toFixed(2)}\n📝 Otros: ${d.desc_otros}`, { parse_mode:'Markdown' });
      if (diferencia < 0) notificarAdmins(`⚠️ *ALERTA* ${op.nombre} gastó $${Math.abs(diferencia).toFixed(2)} más del anticipo.`, { parse_mode:'Markdown' });
      return;
    }
 
    if (data === 'gastos_repetir') {
      await setEstado(chatId, { estado: 'gastos', paso: 0, datos: {} });
      bot.sendMessage(chatId, `🔄 De nuevo.\n\n${P_GASTOS[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }
 
    if (data === 'carga_ok') {
      const st = await getEstado(chatId);
      if (!st || st.estado !== 'carga_revision') return;
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      const d   = st.datos;
      await clearEstado(chatId);
      const total = toNum(d.comida) + toNum(d.aguas);
      const rowsCarga = await getRows(SHEET_BOT, 'Cargas');
      if (rowsCarga.length === 0) await appendRow(SHEET_BOT, 'Cargas', ['Fecha','Operador','Tracto','Lugar','Comida','Aguas']);
      await appendRow(SHEET_BOT, 'Cargas', [d.fecha_carga, op.nombre, op.tracto, d.lugar, toNum(d.comida), toNum(d.aguas)]);
      bot.sendMessage(chatId, `✅ *Carga registrada correctamente* 👍`, { parse_mode:'Markdown', ...MENU_OP });
      notificarAdmins(`📦 *Carga de ${op.nombre}*\n📅 ${d.fecha_carga} | 📍 ${d.lugar}\n🍽️ $${toNum(d.comida).toFixed(2)} | 💧 $${toNum(d.aguas).toFixed(2)} | Total: $${total.toFixed(2)}`, { parse_mode:'Markdown' });
      return;
    }
 
    if (data === 'carga_repetir') {
      await setEstado(chatId, { estado: 'carga', paso: 0, datos: {} });
      bot.sendMessage(chatId, `🔄 De nuevo.\n\n${P_CARGA[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }
 
    if (data === 'ver_viajes') {
      if (!isAdmin(chatId)) return;
      const viajes = await getViajes();
      if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.', MENU_ADMIN);
      let lista = `📋 *Viajes:*\n\n`;
      viajes.forEach(v => {
        lista += `${v.confirmado==='si'?'✅':'⏳'} *${v.idx}.* ${v.fecha} | ${v.cliente} | ${v.destino}${v.operador?' | '+v.operador:''}\n`;
      });
      lista += `\n/asignar NUMERO NOMBRE\n/borrar NUMERO`;
      bot.sendMessage(chatId, lista, { parse_mode:'Markdown', ...MENU_ADMIN });
      return;
    }
 
    if (data === 'nuevos_viajes') {
      if (!isAdmin(chatId)) return;
      await setEstado(chatId, { estado: 'nuevo_viaje', paso: 0, datos: {} });
      bot.sendMessage(chatId, `📋 *Agregar viaje*\n\n${P_VIAJE[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }
 
    if (data === 'viaje_guardar') {
      const st = await getEstado(chatId);
      if (!st || st.estado !== 'nuevo_viaje_revision') return;
      const d = st.datos;
      await clearEstado(chatId);
      const idx = await saveViaje({ fecha: d.fecha, cliente: d.cliente, destino: d.destino, hora: d.hora });
      bot.sendMessage(chatId,
        `✅ *Viaje #${idx} guardado*\n\n📅 ${d.fecha} | 🏭 ${d.cliente}\n📍 ${d.destino} | 🕐 ${d.hora}\n\n¿Agregar otro? Usa el botón ➕ Nuevos viajes`,
        { parse_mode:'Markdown', ...MENU_ADMIN });
      return;
    }
 
    if (data === 'viaje_repetir') {
      await setEstado(chatId, { estado: 'nuevo_viaje', paso: 0, datos: {} });
      bot.sendMessage(chatId, `🔄 De nuevo.\n\n${P_VIAJE[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }
 
    if (data === 'ver_operadores') {
      if (!isAdmin(chatId)) return;
      const ops = await getOperadores();
      if (!Object.keys(ops).length) return bot.sendMessage(chatId, '❌ No hay operadores.', MENU_ADMIN);
      let lista = `👥 *Operadores:*\n\n`;
      Object.values(ops).forEach(o => { lista += `🚛 *${o.nombre}* — Tracto #${o.tracto}\n`; });
      bot.sendMessage(chatId, lista, { parse_mode:'Markdown', ...MENU_ADMIN });
      return;
    }
 
    if (data === 'iniciar_diesel') {
      if (!isAdmin(chatId)) return;
      await iniciarVale(chatId);
      return;
    }
 
    if (data === 'op_diesel' || data === 'dv_repetir') {
      await iniciarVale(chatId);
      return;
    }

    if (data === 'dv_hoy') {
      const st = await getEstado(chatId);
      if (!st || st.estado !== 'dv' || st.preg !== 'fecha') return;
      st.datos.fecha = hoyISO();
      await avanzarVale(chatId, st);
      return;
    }

    if (data.startsWith('dv_op_')) {
      if (!isAdmin(chatId)) return;
      const st = await getEstado(chatId);
      if (!st || st.estado !== 'dv' || st.preg !== 'operador') return;
      const op = (await getOperadores())[data.replace('dv_op_', '')];
      if (!op) return bot.sendMessage(chatId, '❌ No encontré a ese operador.');
      st.datos.operador = op.nombre; st.datos.tracto = op.tracto;
      await avanzarVale(chatId, st);
      return;
    }

    if (data === 'dv_ok') {
      const st = await getEstado(chatId);
      if (!st || st.estado !== 'dv' || st.fase !== 'revision') return;
      const d = st.datos;
      await clearEstado(chatId);
      const menu = isAdmin(chatId) ? MENU_ADMIN : MENU_OP;
      let r;
      try {
        r = await registrarDiesel({ fechaISO: d.fecha, vale: d.folio, operador: d.operador, tracto: d.tracto,
          km_nuevo: d.km_nuevo, km_ant: d.km_ant, litros: d.litros, foto: d.fotos.join('|') });
      } catch (e) {
        console.error('❌ ERROR guardando diésel:', e.message);
        return bot.sendMessage(chatId, '⚠️ Error guardando. Avisa a Fabiola.\n\nUsa /reset para reiniciar.', menu);
      }
      bot.sendMessage(chatId,
        `⛽ *Carga de diésel registrada* ✅\n\nVale #${d.folio}\nKM recorridos: ${r.difKM || '—'}\nRendimiento: ${r.rend} km/lt`,
        { parse_mode:'Markdown', ...menu });
      const alertas = [];
      if (d.km_ant > 0 && d.km_nuevo <= d.km_ant) alertas.push('⚠️ El kilometraje no es mayor al de la carga anterior');
      if (r.rend !== '—' && (parseFloat(r.rend) < 1.2 || parseFloat(r.rend) > 4)) alertas.push(`⚠️ Rendimiento fuera de lo normal (${r.rend} km/lt)`);
      if (r.tabTracto === null) alertas.push(`📗 No encontré la hoja ECO#${d.tracto} en el Excel de rendimientos; quedó solo en la bitácora "Diesel"`);
      const destinos = ADMIN_IDS.filter(id => id !== String(chatId));
      for (const id of destinos) {
        for (const f of d.fotos.slice(0, 3)) bot.sendPhoto(id, f, { caption: `⛽ Vale #${d.folio} — ${d.operador} | Tracto #${d.tracto}` }).catch(() => {});
        bot.sendMessage(id,
          `⛽ *Diésel de ${d.operador}* — Tracto #${d.tracto}\n📅 ${isoAMx(d.fecha)} | Vale #${d.folio}\n` +
          `📏 ${d.km_ant || '—'} → ${d.km_nuevo} (${r.difKM || '—'} km) | ⛽ ${d.litros} lts\n📈 ${r.rend} km/lt` +
          (r.tabTracto ? `\n📗 Guardado en la hoja ${r.tabTracto}` : '') +
          (alertas.length ? `\n\n${alertas.join('\n')}` : ''), { parse_mode:'Markdown' }).catch(() => {});
      }
      return;
    }

    if (data === 'ver_semanal') {
      if (!isAdmin(chatId)) return;
      try {
        await dashboard.enviarResumen({ bot, chatIds: [chatId], getSheets, spreadsheetId: SHEET_BOT, tab: DASH_TAB, panelUrl: panelUrl() });
      } catch (e) { bot.sendMessage(chatId, `⚠️ ${e.message}`); }
      return;
    }

    if (data === 'ver_resumen') {
      if (!isAdmin(chatId)) return;
      const ops    = await getOperadores();
      const viajes = await getViajes();
      bot.sendMessage(chatId,
        `📊 *Resumen*\n\n🚛 Operadores: ${Object.keys(ops).length}\n📋 Viajes: ${viajes.length}\n✅ Confirmados: ${viajes.filter(v=>v.confirmado==='si').length}\n⏳ Pendientes: ${viajes.filter(v=>v.confirmado!=='si').length}`,
        { parse_mode:'Markdown', ...MENU_ADMIN });
      return;
    }
 
  } catch(e) {
    console.error('Error callback:', data, e.message);
    bot.sendMessage(chatId, '❌ Error. Usa /reset e intenta de nuevo.').catch(()=>{});
  }
});
 
// ═══════════════════════════════════════════════════════════
//   MENSAJES DE TEXTO
// ═══════════════════════════════════════════════════════════
bot.on('message', (msg) => serializar(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith('/')) return;
 
  try {
    const st     = await getEstado(chatId);
    const estado = st?.estado;
 
    if (estado === 'nuevo_viaje') {
      const paso        = st.paso;
      const campo       = P_VIAJE[paso].campo;
      const nuevosDatos = { ...st.datos, [campo]: msg.text.trim() };
      const sig         = paso + 1;
      if (sig < P_VIAJE.length) {
        await setEstado(chatId, { estado: 'nuevo_viaje', paso: sig, datos: nuevosDatos });
        bot.sendMessage(chatId, P_VIAJE[sig].pregunta, BTN_CANCELAR);
      } else {
        await setEstado(chatId, { estado: 'nuevo_viaje_revision', datos: nuevosDatos });
        bot.sendMessage(chatId,
          `📋 *Revisa el viaje:*\n\n📅 Fecha:   ${nuevosDatos.fecha}\n🏭 Cliente: ${nuevosDatos.cliente}\n📍 Destino: ${nuevosDatos.destino}\n🕐 Hora:    ${nuevosDatos.hora}\n\n¿Todo correcto?`,
          { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[
            { text: '✅ Guardar', callback_data: 'viaje_guardar' },
            { text: '🔄 Repetir', callback_data: 'viaje_repetir' }
          ]] }});
      }
      return;
    }
 
    if (estado === 'esperando_remision') {
      const { viaje, operador: op, archivos } = st;
      if (msg.text.toLowerCase().trim() === 'listo') {
        if (!archivos || archivos.length === 0) {
          bot.sendMessage(chatId, '⚠️ No mandaste nada todavía.\nManda fotos o números primero, luego escribe *listo*', { parse_mode:'Markdown' });
          return;
        }
        await clearEstado(chatId);
        await guardarRemision(op, viaje, archivos);
        notificarAdmins(`📋 *Remisión/Caja de ${op.nombre}*\n📍 ${viaje.destino} — ${viaje.fecha}\n🏭 ${viaje.cliente}`, { parse_mode:'Markdown' });
        for (const archivo of archivos) {
          if (archivo.tipo === 'foto') {
            notificarAdminsFoto(archivo.fileId, `📸 Remisión — ${op.nombre} | ${viaje.destino}`);
          } else {
            notificarAdmins(`📝 ${archivo.texto}`, {});
          }
        }
        bot.sendMessage(chatId, `✅ Listo, le avisé a Fabiola 👍\n\n¡Buen viaje! 🚛`, { parse_mode:'Markdown', ...MENU_OP });
        return;
      }
      const nuevosArchivos = [...(archivos||[]), { tipo: 'texto', texto: msg.text }];
      await setEstado(chatId, { ...st, archivos: nuevosArchivos });
      bot.sendMessage(chatId, `✅ Guardado. Sigue mandando o escribe *listo*`, { parse_mode:'Markdown' });
      return;
    }
 
    if (estado === 'gastos') {
      const paso  = st.paso;
      const campo = P_GASTOS[paso].campo;
      const texto = msg.text.trim();
      if (NUMERICOS.includes(campo) && !esNumero(texto)) {
        bot.sendMessage(chatId, `❌ Solo números.\n\n${P_GASTOS[paso].pregunta}\n\nEjemplo: 250 o 0`, { parse_mode:'Markdown', ...BTN_CANCELAR });
        return;
      }
      const nuevosDatos = { ...st.datos, [campo]: texto };
      const sig = paso + 1;
      if (sig < P_GASTOS.length) {
        await setEstado(chatId, { estado: 'gastos', paso: sig, datos: nuevosDatos });
        bot.sendMessage(chatId, P_GASTOS[sig].pregunta, BTN_CANCELAR);
      } else {
        const total      = ['comida','aguas','casetas','pension','federales','otros'].reduce((s,k) => s+toNum(nuevosDatos[k]), 0);
        const anticipo   = toNum(nuevosDatos.anticipo);
        const diferencia = anticipo - total;
        await setEstado(chatId, { estado: 'gastos_revision', datos: nuevosDatos });
        bot.sendMessage(chatId, resumenGastos(nuevosDatos, anticipo, total, diferencia), { parse_mode:'Markdown', ...MENU_CONFIRM_GASTOS });
      }
      return;
    }
 
    if (estado === 'carga') {
      const paso  = st.paso;
      const campo = P_CARGA[paso].campo;
      const texto = msg.text.trim();
      if (NUMERICOS.includes(campo) && !esNumero(texto)) {
        bot.sendMessage(chatId, `❌ Solo números.\n\n${P_CARGA[paso].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
        return;
      }
      const nuevosDatos = { ...st.datos, [campo]: texto };
      const sig = paso + 1;
      if (sig < P_CARGA.length) {
        await setEstado(chatId, { estado: 'carga', paso: sig, datos: nuevosDatos });
        bot.sendMessage(chatId, P_CARGA[sig].pregunta, BTN_CANCELAR);
      } else {
        const total = toNum(nuevosDatos.comida) + toNum(nuevosDatos.aguas);
        await setEstado(chatId, { estado: 'carga_revision', datos: nuevosDatos });
        bot.sendMessage(chatId,
          `📋 *Revisa tu carga:*\n\n📅 ${nuevosDatos.fecha_carga}\n📍 ${nuevosDatos.lugar}\n🍽️ $${toNum(nuevosDatos.comida).toFixed(2)}\n💧 $${toNum(nuevosDatos.aguas).toFixed(2)}\n\n💰 *Total: $${total.toFixed(2)}*\n\n¿Todo correcto?`,
          { parse_mode:'Markdown', ...MENU_CONFIRM_CARGA });
      }
      return;
    }
 
    if (estado === 'dv') {
      const texto = msg.text.trim();
      if (st.fase === 'fotos') {
        if (texto.toLowerCase() === 'listo') await cerrarFotosVale(chatId, st);
        else bot.sendMessage(chatId, '📸 Manda las fotos del vale y los tickets, o escribe *listo* cuando termines.', { parse_mode:'Markdown' });
      } else if (st.fase === 'preguntas') {
        await responderPreguntaVale(chatId, st, texto);
      } else {
        bot.sendMessage(chatId, 'Toca ✅ Guardar o 🔄 Repetir 👆');
      }
      return;
    }

    if (estado === 'diesel') {
      const paso  = st.paso;
      const campo = P_DIESEL[paso].campo;
      const nuevosDatos = { ...st.datos, [campo]: msg.text.trim() };
      const sig = paso + 1;
      if (sig < P_DIESEL.length) {
        await setEstado(chatId, { estado: 'diesel', paso: sig, datos: nuevosDatos });
        bot.sendMessage(chatId, P_DIESEL[sig].pregunta, BTN_CANCELAR);
      } else {
        await setEstado(chatId, { estado: 'diesel_foto', datos: nuevosDatos });
        bot.sendMessage(chatId, `📸 Manda una *foto del vale*.\n\nSi no tienes escribe *sin foto*`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      }
      return;
    }
 
    if (estado === 'diesel_foto') {
      if (msg.text.toLowerCase().trim() === 'sin foto') {
        await guardarDiesel(chatId, null, st.datos);
      } else {
        bot.sendMessage(chatId, `📸 Manda la foto del vale o escribe *sin foto*`, { parse_mode:'Markdown' });
      }
      return;
    }
 
    if (isAdmin(chatId)) {
      bot.sendMessage(chatId, '¿Qué necesitas?', MENU_ADMIN);
    } else {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (op) bot.sendMessage(chatId, `¿Qué necesitas, ${op.nombre}?`, MENU_OP);
    }
 
  } catch(e) {
    console.error('Error message handler:', e.message);
    bot.sendMessage(chatId, '❌ Error. Usa /reset e intenta de nuevo.').catch(()=>{});
  }
}));
 
// ═══════════════════════════════════════════════════════════
//   GASTO SEMANAL: comando y carga del Excel (solo admins)
// ═══════════════════════════════════════════════════════════
bot.onText(/\/semanal/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  try {
    await dashboard.enviarResumen({ bot, chatIds: [chatId], getSheets, spreadsheetId: SHEET_BOT, tab: DASH_TAB, panelUrl: panelUrl() });
  } catch (e) {
    console.error('Error /semanal:', e.message);
    bot.sendMessage(chatId, `⚠️ ${e.message}`);
  }
});

// El admin manda GASTOS_2026.xlsx al bot → se carga a BASE_EXCEL → se manda el resumen semanal.
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const doc = msg.document;
  if (!/\.xlsx$/i.test(doc.file_name || '')) {
    return bot.sendMessage(chatId, '📎 Para actualizar el gasto semanal mándame el Excel en formato .xlsx');
  }
  try {
    await bot.sendMessage(chatId, '📥 Recibí el Excel, lo estoy cargando...');
    const url = await bot.getFileLink(doc.file_id);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Telegram respondió ${resp.status} al descargar el archivo`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (await detectarTipo(buffer) === 'rendimientos') {          // Excel de rendimientos por tractor
      const r = await importarRendimientos({ buffer, getSheets, spreadsheetId: SHEET_DIESEL });
      let t = `✅ *Rendimientos cargados*\n\n`;
      if (r.creadas.length) t += `📗 Hojas creadas: ${r.creadas.join(', ')}\n📄 ${r.filas} cargas pasadas\n`;
      if (r.omitidas.length) t += `\n⏭️ Ya existían y NO las toqué: ${r.omitidas.join(', ')}\n(Así no se borra lo que el bot ya registró.)`;
      t += `\n\nYa pueden reportar diésel con el botón ⛽.`;
      return bot.sendMessage(chatId, t, { parse_mode: 'Markdown' });
    }
    const r = await importarExcel({ buffer, getSheets, spreadsheetId: SHEET_BOT, tab: DASH_TAB });
    await bot.sendMessage(chatId, `✅ Excel cargado en la pestaña ${r.tab}\n📄 ${r.n} registros (del ${r.desde} al ${r.hasta})`);
    await dashboard.enviarResumen({ bot, chatIds: [chatId], getSheets, spreadsheetId: SHEET_BOT, tab: DASH_TAB, panelUrl: panelUrl() });
  } catch (e) {
    console.error('Error cargando Excel:', e.message);
    bot.sendMessage(chatId, `⚠️ No pude cargar el Excel: ${e.message}`).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════
//   FOTOS
// ═══════════════════════════════════════════════════════════
bot.on('photo', (msg) => serializar(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  try {
    const st     = await getEstado(chatId);
    const estado = st?.estado;
    if (estado === 'dv') {
      if (st.fase === 'fotos' || st.fase === 'preguntas') {
        const guardada = await procesarFotoVale(chatId, st, fileId);
        if (guardada) { if (st.fase === 'preguntas') await cerrarFotosVale(chatId, st); else await setEstado(chatId, st); }
      } else {
        bot.sendMessage(chatId, 'Toca ✅ Guardar o 🔄 Repetir 👆');
      }
      return;
    }
    if (estado === 'diesel_foto') {
      await guardarDiesel(chatId, fileId, st.datos);
      return;
    }
    if (estado === 'esperando_remision') {
      const nuevosArchivos = [...(st.archivos||[]), { tipo: 'foto', fileId }];
      await setEstado(chatId, { ...st, archivos: nuevosArchivos });
      bot.sendMessage(chatId, `📸 Foto recibida. Sigue mandando o escribe *listo*`, { parse_mode:'Markdown' });
      return;
    }
    if (isAdmin(chatId) && !estado) {                       // foto suelta de un admin = vale de diésel
      if (await iniciarVale(chatId, true)) {
        const st2 = await getEstado(chatId);
        if (await procesarFotoVale(chatId, st2, fileId)) await setEstado(chatId, st2);
      }
      return;
    }
    bot.sendMessage(chatId, 'Para reportar usa el menú 👇', MENU_OP);
  } catch(e) {
    console.error('Error photo handler:', e.message);
  }
}));
 
// ═══════════════════════════════════════════════════════════
//   DIÉSEL: bitácora (pestaña "Diesel") + hoja de cada tractor (ECO#NN)
// ═══════════════════════════════════════════════════════════
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const isoAMx = iso => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };
const qTab   = t => `'${String(t).replace(/'/g, "''")}'`;
const limpio = v => parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
// "ECO#07", "ECO# 8 ", "ECO #9" → coincide con tracto 7, 8, 9
const esTabDelTracto = (titulo, tracto) => {
  const m = String(titulo).trim().match(/^ECO\s*#\s*0*(\d+)$/i);
  return !!m && Number(m[1]) === Number(tracto);
};

async function tabsDiesel() {
  const meta = await getSheets().spreadsheets.get({ spreadsheetId: SHEET_DIESEL, fields: 'sheets.properties.title' });
  return meta.data.sheets.map(h => h.properties.title);
}

/** Último kilometraje conocido del tracto: el mayor entre la bitácora y su hoja ECO#NN. 0 si no hay. */
async function ultimoKm(tracto) {
  let max = 0;
  try {
    const rows = await getRows(SHEET_DIESEL, 'Diesel');
    const h = rows[0] || [], iT = h.indexOf('Tracto'), iK = h.indexOf('KM Nuevo');
    if (iT >= 0 && iK >= 0) rows.slice(1).forEach(r => { if (Number(r[iT]) === Number(tracto)) max = Math.max(max, limpio(r[iK])); });
  } catch (e) { console.error('ultimoKm bitácora:', e.message); }
  try {
    const titulo = (await tabsDiesel()).find(t => esTabDelTracto(t, tracto));
    if (titulo) {
      const res = await getSheets().spreadsheets.values.get({ spreadsheetId: SHEET_DIESEL, range: `${qTab(titulo)}!D3:D2000`, valueRenderOption: 'UNFORMATTED_VALUE' });
      (res.data.values || []).forEach(r => { if (typeof r[0] === 'number') max = Math.max(max, r[0]); });
    }
  } catch (e) { console.error('ultimoKm hoja tracto:', e.message); }
  return max;
}

/** Agrega la carga en la siguiente fila libre de la hoja del tracto, respetando sus fórmulas. */
async function escribirEnHojaTracto({ fechaISO, vale, operador, tracto, km_nuevo, km_ant, litros }) {
  const titulo = (await tabsDiesel()).find(t => esTabDelTracto(t, tracto));
  if (!titulo) return null;
  const res  = await getSheets().spreadsheets.values.get({ spreadsheetId: SHEET_DIESEL, range: `${qTab(titulo)}!A1:A2000` });
  const colA = res.data.values || [];
  let ultima = 2;                                                   // fila 2 = encabezados
  colA.forEach((r, i) => { if (i >= 2 && r[0] !== undefined && String(r[0]).trim() !== '') ultima = i + 1; });
  const f = ultima + 1;
  await updateRow(SHEET_DIESEL, `${qTab(titulo)}!A${f}:I${f}`, [
    fechaISO, Number(vale) || vale, Number(tracto), km_nuevo, km_ant > 0 ? km_ant : '',
    `=IF(E${f}="","",D${f}-E${f})`, litros,
    `=IF(OR(E${f}="",G${f}=0),"",(D${f}-E${f})/G${f})`,
    `Reportó ${operador} (Telegram)`,
  ]);
  return titulo;
}

async function registrarDiesel({ fechaISO, vale, operador, tracto, km_nuevo, km_ant, litros, foto }) {
  const difKM = km_ant > 0 ? +(km_nuevo - km_ant).toFixed(1) : 0;
  const rend  = difKM > 0 && litros > 0 ? (difKM / litros).toFixed(2) : '—';
  // 1) bitácora con foto (se crea la pestaña "Diesel" si no existe)
  await asegurarTab(SHEET_DIESEL, 'Diesel');
  const rows = await getRows(SHEET_DIESEL, 'Diesel');
  if (rows.length === 0) await appendRow(SHEET_DIESEL, 'Diesel', ['Fecha','Vale','Operador','Tracto','KM Nuevo','KM Anterior','KM Recorridos','Litros','Rendimiento km/lt','Foto']);
  else if (!(rows[0] || []).includes('Foto')) await updateCell(SHEET_DIESEL, 'Diesel!J1', 'Foto');
  await appendRow(SHEET_DIESEL, 'Diesel', [isoAMx(fechaISO), vale, operador, tracto, km_nuevo, km_ant, difKM, litros, rend, foto || '']);
  // 2) hoja del tracto (si existe). Si falla, la bitácora ya quedó guardada.
  let tabTracto = null;
  try { tabTracto = await escribirEnHojaTracto({ fechaISO, vale, operador, tracto, km_nuevo, km_ant, litros }); }
  catch (e) { console.error('❌ No pude escribir en la hoja del tracto:', e.message); }
  return { difKM, rend, tabTracto };
}

async function asegurarTab(sheetId, titulo) {
  const meta = await getSheets().spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' });
  if (meta.data.sheets.some(h => h.properties.title === titulo)) return false;
  await getSheets().spreadsheets.batchUpdate({ spreadsheetId: sheetId, resource: { requests: [{ addSheet: { properties: { title: titulo } } }] } });
  return true;
}

async function valeRegistrado(folio) {
  try {
    const rows = await getRows(SHEET_DIESEL, 'Diesel');
    const h = rows[0] || [], iV = h.indexOf('Vale');
    if (iV < 0) return null;
    const r = rows.slice(1).find(x => String(x[iV]).trim() === String(folio).trim());
    return r ? { fecha: r[h.indexOf('Fecha')] || '', operador: r[h.indexOf('Operador')] || '' } : null;
  } catch (e) { return null; }
}

// ── Diésel con foto: vale + tickets (operador o admin) ────
const DV_VACIO = () => ({ fotos: [], tickets: [], folio: '', fecha: '', importe: 0, precio: 0, litros: 0, litrosComo: '',
  vehiculo: '', operador: '', tracto: '', km_nuevo: 0, km_ant: 0 });
const mxn = n => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function descargarFoto(fileId) {
  const r = await fetch(await bot.getFileLink(fileId));
  if (!r.ok) throw new Error(`Telegram respondió ${r.status} al bajar la foto`);
  return Buffer.from(await r.arrayBuffer());
}

async function iniciarVale(chatId, silencioso = false) {
  const datos = DV_VACIO();
  if (!isAdmin(chatId)) {
    const op = (await getOperadores())[String(chatId)];
    if (!op) { bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO'); return false; }
    datos.operador = op.nombre; datos.tracto = op.tracto;
  }
  await setEstado(chatId, { estado: 'dv', fase: 'fotos', datos });
  if (!silencioso) {
    bot.sendMessage(chatId,
      `⛽ *Reportar diésel*${datos.tracto ? ' — Tracto #' + datos.tracto : ''}\n\n📸 Manda la *foto del vale* (papel rosa) y la de los *tickets* de la gasolinera, una por una.\nCuando termines escribe *listo*`,
      { parse_mode:'Markdown', ...BTN_CANCELAR });
  }
  return true;
}

/** Lee la foto, junta los datos en el estado y avisa qué entendió. Regresa true si la foto se guardó. */
async function procesarFotoVale(chatId, st, fileId) {
  const d = st.datos;
  let l = null;
  if (vale.disponible()) {
    try { l = await vale.leer(await descargarFoto(fileId)); }
    catch (e) {
      console.error('Lectura de foto:', e.message);
      bot.sendMessage(chatId, '⚠️ No pude leer esa foto automáticamente. La guardo y al final te pregunto los datos.');
    }
  }
  if (l && l.calidad === 'ilegible') {
    bot.sendMessage(chatId, '📸 Esa foto salió *borrosa o ilegible* y no pude leerla.\n\nTómala otra vez con más luz, bien enfocada y completa, y mándala de nuevo.', { parse_mode:'Markdown' });
    return false;
  }
  if (l && l.tipo === 'otro') {
    bot.sendMessage(chatId, '🤔 Eso no parece un vale ni un ticket de diésel. Manda la foto del vale (papel rosa) o del ticket de la gasolinera.');
    return false;
  }
  const dudas = [];
  let resp = '📸 Foto guardada.';
  if (l && l.tipo === 'ticket') {
    const id = l.ticket || `t${d.tickets.length + 1}`;
    if (d.tickets.some(t => t.ticket === id)) {
      bot.sendMessage(chatId, 'ℹ️ Ese ticket ya lo había leído. Sigue con otra foto o escribe *listo*.', { parse_mode:'Markdown' });
      return false;
    }
    if (l.litros) d.tickets.push({ ticket: id, litros: l.litros, importe: l.importe || 0 }); else dudas.push('los litros');
    if (l.precio_litro) d.precio = l.precio_litro;
    if (!d.fecha && l.fecha) d.fecha = l.fecha;
    resp = `🎫 *Ticket leído*\nLitros: ${l.litros || '❓'}\nPrecio: ${l.precio_litro ? mxn(l.precio_litro) + ' por litro' : '❓'}\nTotal: ${l.importe ? mxn(l.importe) : '❓'}`;
    d.fotos.push(fileId);
  } else if (l && l.tipo === 'vale') {
    if (l.folio) d.folio = l.folio; else dudas.push('el número de folio');
    if (l.fecha) d.fecha = l.fecha; else dudas.push('la fecha');
    if (l.importe) d.importe = l.importe; else dudas.push('el importe en pesos');
    if (l.vehiculo) d.vehiculo = l.vehiculo;
    resp = `🧾 *Vale leído*\nFolio: ${l.folio || '❓'}\nFecha: ${l.fecha ? isoAMx(l.fecha) : '❓'}\nImporte: ${l.importe ? mxn(l.importe) : '❓'}`;
    d.fotos.unshift(fileId);                                  // la foto del vale va primero
  } else {
    d.fotos.push(fileId);
  }
  if (dudas.length) resp += `\n\n⚠️ No se alcanza a leer bien: ${dudas.join(', ')}.\nPuedes mandarla de nuevo más clara; si no, sigo y te lo pregunto al final.`;
  resp += `\n\nSigue mandando fotos o escribe *listo*.`;
  bot.sendMessage(chatId, resp, { parse_mode:'Markdown' });
  return true;
}

/** litros del vale = importe del vale ÷ precio por litro; si no hay vale, la suma de los tickets */
function calcularLitros(d) {
  if (d.importe > 0 && d.precio > 0) return { litros: +(d.importe / d.precio).toFixed(3), como: `${mxn(d.importe)} ÷ ${mxn(d.precio)} por litro` };
  const t = d.tickets.reduce((a, x) => a + x.litros, 0);
  if (t > 0) return { litros: +t.toFixed(3), como: `suma de ${d.tickets.length} ticket(s)` };
  return null;
}

/** Avisa de inmediato si el folio ya se registró (evita capturar dos veces la misma carga). */
async function esDuplicadoVale(chatId, d) {
  if (!d.folio) return false;
  const dup = await valeRegistrado(d.folio);
  if (!dup) return false;
  await clearEstado(chatId);
  bot.sendMessage(chatId, `⚠️ El vale *#${d.folio}* ya está registrado (${dup.fecha}, ${dup.operador}). No lo guardé para evitar duplicados.\n\nSi es otra carga con el mismo número, avisa a Fabiola.`,
    { parse_mode:'Markdown', ...(isAdmin(chatId) ? MENU_ADMIN : MENU_OP) });
  return true;
}

async function cerrarFotosVale(chatId, st) {
  const d = st.datos;
  if (d.fotos.length === 0) return bot.sendMessage(chatId, '📸 Primero manda la foto del vale (y los tickets).');
  if (await esDuplicadoVale(chatId, d)) return;
  const c = calcularLitros(d);
  if (c && !(d.litrosComo === 'capturado a mano')) { d.litros = c.litros; d.litrosComo = c.como; }
  await avanzarVale(chatId, st);
}

const faltanteVale = d => !d.tracto ? 'operador' : !d.folio ? 'folio' : !d.fecha ? 'fecha' : !(d.litros > 0) ? 'litros' : !(d.km_nuevo > 0) ? 'km_nuevo' : null;
const PREG_VALE = {
  folio:    '🔢 No pude leer el *número de vale (folio)*. ¿Cuál es?',
  fecha:    '📅 ¿Fecha de la carga?\nToca "Hoy" o escribe la fecha (20/Abr o 20/04/2026)',
  litros:   '⛽ No pude sacar los litros. ¿Cuántos litros fueron *en total* en el vale?',
  km_nuevo: '📏 ¿Kilometraje actual del odómetro?',
};

async function avanzarVale(chatId, st) {
  const f = faltanteVale(st.datos);
  if (!f) return irRevisionVale(chatId, st);
  st.estado = 'dv'; st.fase = 'preguntas'; st.preg = f;
  await setEstado(chatId, st);
  if (f === 'operador') {
    const botones = Object.values(await getOperadores()).map(o => [{ text: `${o.nombre} — Tracto #${o.tracto}`, callback_data: `dv_op_${o.chatId}` }]);
    botones.push([{ text: '❌ Cancelar', callback_data: 'cancelar' }]);
    return bot.sendMessage(chatId, '👤 ¿De qué operador es esta carga?', { reply_markup: { inline_keyboard: botones } });
  }
  bot.sendMessage(chatId, PREG_VALE[f], { parse_mode:'Markdown', ...(f === 'fecha' ? BTN_HOY : BTN_CANCELAR) });
}

async function responderPreguntaVale(chatId, st, texto) {
  const d = st.datos, f = st.preg;
  let ok = true;
  if (f === 'operador') return bot.sendMessage(chatId, 'Toca el nombre del operador 👆');
  if (f === 'folio') { if (/^\d{3,10}$/.test(texto)) { d.folio = texto; if (await esDuplicadoVale(chatId, d)) return; } else ok = false; }
  else if (f === 'fecha') {
    const ser = texto.toLowerCase() === 'hoy' ? dashboard.hoyMX() : dashboard.parseFecha(texto);
    if (ser == null || ser > dashboard.hoyMX()) ok = false; else d.fecha = dashboard.serialAISO(ser);
  } else if (f === 'litros' || f === 'km_nuevo') {
    if (esNumero(texto) && toNum(texto) > 0) { d[f] = toNum(texto); if (f === 'litros') d.litrosComo = 'capturado a mano'; } else ok = false;
  }
  if (!ok) bot.sendMessage(chatId, '❌ No entendí ese dato, intenta de nuevo.');
  await avanzarVale(chatId, st);
}

async function irRevisionVale(chatId, st) {
  const d = st.datos;
  d.km_ant = await ultimoKm(d.tracto);
  st.fase = 'revision'; await setEstado(chatId, st);
  const dif  = d.km_ant > 0 ? +(d.km_nuevo - d.km_ant).toFixed(1) : 0;
  const rend = dif > 0 && d.litros > 0 ? (dif / d.litros).toFixed(2) : '—';
  let t = `📋 *Revisa la carga de diésel:*\n\n👤 ${d.operador} — Tracto #${d.tracto}\n🧾 Vale:       ${d.folio}\n📅 Fecha:      ${isoAMx(d.fecha)}\n` +
          `⛽ Litros:     ${d.litros}${d.litrosComo ? ' (' + d.litrosComo + ')' : ''}\n` +
          `📏 KM anterior: ${d.km_ant > 0 ? d.km_ant : 'no encontrado'}\n📏 KM actual:  ${d.km_nuevo}\n🛣️ Recorridos: ${dif > 0 ? dif : '—'}\n` +
          `📈 Rendimiento: ${rend} km/lt\n📸 Fotos: ${d.fotos.length}\n`;
  if (d.km_ant > 0 && d.km_nuevo <= d.km_ant) t += `\n⚠️ *El kilometraje es menor o igual al de la carga anterior (${d.km_ant}).* Si te equivocaste, toca Repetir.\n`;
  if (rend !== '—' && (parseFloat(rend) < 1.2 || parseFloat(rend) > 4)) t += `\n⚠️ *Rendimiento fuera de lo normal.* Revisa kilometraje y litros.\n`;
  if (dashboard.hoyMX() - dashboard.parseFecha(d.fecha) > 45) t += `\n⚠️ *La fecha tiene más de 45 días.* Revísala.\n`;
  t += `\n¿Todo correcto?`;
  bot.sendMessage(chatId, t, { parse_mode:'Markdown', ...MENU_CONFIRM_DV });
}

// Flujo del admin (registrar diésel de cualquier operador)
async function guardarDiesel(chatId, fotoFileId, d) {
  await clearEstado(chatId);
  try {
    const r = await registrarDiesel({ fechaISO: hoyISO(), vale: d.vale, operador: d.operador, tracto: d.tracto,
      km_nuevo: toNum(d.km_nuevo), km_ant: toNum(d.km_ant), litros: toNum(d.litros), foto: fotoFileId || '' });
    bot.sendMessage(chatId, `⛽ *Diésel registrado* ✅\n\nOperador: ${d.operador}\nTracto: #${d.tracto}\nKM recorridos: ${r.difKM}\nRendimiento: ${r.rend} km/lt\nVale: #${d.vale}${r.tabTracto ? '\n📗 Guardado en ' + r.tabTracto : ''}`, { parse_mode:'Markdown', ...MENU_ADMIN });
    if (fotoFileId) notificarAdminsFoto(fotoFileId, `⛽ Vale — ${d.operador} | Tracto #${d.tracto} | ${isoAMx(hoyISO())}`);
    notificarAdmins(`⛽ *Diésel* — ${d.operador} | Tracto #${d.tracto} | KM: ${r.difKM} | ${r.rend} km/lt | Vale #${d.vale}`, { parse_mode:'Markdown' });
  } catch (e) {
    console.error('Error guardando diesel:', e.message);
    bot.sendMessage(chatId, '⚠️ Error guardando diésel.', MENU_ADMIN);
  }
}

// ── ERRORES GLOBALES ──────────────────────────────────────
bot.on('error', e => console.error('Bot error:', e.message));
process.on('uncaughtException',  e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
 
// ═══════════════════════════════════════════════════════════
//   DASHBOARD ADMIN
// ═══════════════════════════════════════════════════════════
app.get('/dashboard', (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).send('No autorizado');
  res.sendFile(path.join(__dirname, 'public', 'vista-admin.html'));
});
 
app.get('/api/admin', async (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).json({ ok: false });
  try {
    const ops        = await getOperadores();
    const viajes     = await getViajes();
    const rowsGastos = await getRows(SHEET_BOT, 'Gastos');
    const headers    = rowsGastos[0] || [];
    const col        = (nombre) => headers.findIndex(h => h === nombre);
    const gastos = rowsGastos.slice(1).map(r => ({
      fecha:      r[col('Fecha')]       || '',
      operador:   r[col('Operador')]    || '',
      destino:    r[col('Destino')]     || '',
      cliente:    r[col('Cliente')]     || '',
      total:      parseFloat(r[col('Total')])      || 0,
      diferencia: parseFloat(r[col('Diferencia')]) || 0,
    })).reverse();
    const marcador = Object.values(ops).map(o => ({
      nombre: o.nombre, tracto: o.tracto, chatId: o.chatId,
      viajes: viajes.filter(v => v.operador.toLowerCase().trim() === o.nombre.toLowerCase().trim() && v.confirmado === 'si').length
    })).sort((a, b) => b.viajes - a.viajes);
    res.json({ ok: true, operadores: Object.values(ops), viajes: [...viajes].reverse(), gastos, marcador });
  } catch (e) {
    console.error('Error API admin:', e.message);
    res.json({ ok: false, error: e.message });
  }
});
 
app.post('/api/admin/viaje', async (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).json({ ok: false });
  try {
    const { fecha, cliente, destino, hora, operador } = req.body;
    if (!fecha || !cliente || !destino) return res.json({ ok: false, error: 'Faltan campos' });
    const idx = await saveViaje({ fecha, cliente, destino, hora: hora || 'Sin cita', operador: operador || '' });
    if (operador) {
      const ops = await getOperadores();
      const op  = Object.values(ops).find(o => o.nombre.toLowerCase() === operador.toLowerCase());
      if (op) bot.sendMessage(op.chatId, `🚛 *¡Tienes un nuevo viaje!*\n\n📍 *Destino:* ${destino}\n📅 *Fecha:* ${fecha}\n🕐 *Hora:* ${hora || 'Por confirmar'}\n🏭 *Cliente:* ${cliente}\n\n¿Puedes confirmarlo?`, { parse_mode: 'Markdown', ...MENU_OP });
    }
    notificarAdmins(`📋 Viaje #${idx} creado desde dashboard\n📍 ${destino} | 📅 ${fecha} | 🏭 ${cliente}${operador ? '\n🚛 Asignado a: ' + operador : ''}`, { parse_mode: 'Markdown' });
    res.json({ ok: true, idx });
  } catch (e) {
    console.error('Error POST viaje:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── NUEVOS ENDPOINTS: CAJA / REMISIONES / DIÉSEL / CARGAS ──
app.get('/api/admin/remisiones', async (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).json({ ok: false });
  try {
    const rows    = await getRows(SHEET_BOT, 'Remisiones');
    const headers = rows[0] || [];
    const col     = (nombre) => headers.findIndex(h => h === nombre);
    const remisiones = rows.slice(1).map(r => ({
      fecha:      r[col('Fecha')]          || '',
      operador:   r[col('Operador')]       || '',
      tracto:     r[col('Tracto')]         || '',
      cliente:    r[col('Cliente')]        || '',
      destino:    r[col('Destino')]        || '',
      fechaViaje: r[col('Fecha Viaje')]    || '',
      datos:      r[col('Datos Remision')] || '',
      tieneFotos: r[col('Tiene Fotos')]    || 'No',
    })).reverse();
    res.json({ ok: true, remisiones });
  } catch (e) {
    console.error('Error API remisiones:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/caja', async (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).json({ ok: false });
  try {
    const rows    = await getRows(SHEET_BOT, 'Remisiones');
    const headers = rows[0] || [];
    const col     = (nombre) => headers.findIndex(h => h === nombre);
    const caja = rows.slice(1).map((r, i) => {
      const tieneDatos = (r[col('Datos Remision')] || '').trim().length > 0;
      const tieneFotos = r[col('Tiene Fotos')] === 'Sí';
      return {
        numero:        i + 1,
        fecha:         r[col('Fecha')]          || '',
        operador:      r[col('Operador')]       || '',
        cliente:       r[col('Cliente')]        || '',
        destino:       r[col('Destino')]        || '',
        estado:        (tieneDatos || tieneFotos) ? 'Recibida' : 'Pendiente',
        observaciones: r[col('Datos Remision')] || '',
      };
    }).reverse();
    const recibidas  = caja.filter(c => c.estado === 'Recibida').length;
    const pendientes = caja.length - recibidas;
    res.json({ ok: true, caja, recibidas, pendientes });
  } catch (e) {
    console.error('Error API caja:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/diesel', async (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).json({ ok: false });
  try {
    const rows    = await getRows(SHEET_DIESEL, 'Diesel');
    const headers = rows[0] || [];
    const col     = (nombre) => headers.findIndex(h => h === nombre);
    const diesel = rows.slice(1).map(r => ({
      fecha:        r[col('Fecha')]                 || '',
      vale:         r[col('Vale')]                  || '',
      operador:     r[col('Operador')]              || '',
      tracto:       r[col('Tracto')]                || '',
      kmNuevo:      parseFloat(r[col('KM Nuevo')])      || 0,
      kmAnterior:   parseFloat(r[col('KM Anterior')])   || 0,
      kmRecorridos: parseFloat(r[col('KM Recorridos')]) || 0,
      litros:       parseFloat(r[col('Litros')])        || 0,
      rendimiento:  r[col('Rendimiento km/lt')]     || '—',
      foto:         r[col('Foto')]                  || '',
    })).reverse();
    res.json({ ok: true, diesel });
  } catch (e) {
    console.error('Error API diesel:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Sirve la foto del vale guardada en Telegram (solo con el token del panel)
app.get('/api/admin/foto', async (req, res) => {
  if (req.query.token !== (process.env.DASHBOARD_TOKEN || 'regis2024')) return res.status(401).send('No autorizado');
  const id = String(req.query.id || '');
  if (!/^[A-Za-z0-9_-]{10,250}$/.test(id)) return res.status(400).send('Foto inválida');
  try {
    const url = await bot.getFileLink(id);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Telegram respondió ${r.status}`);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('Error API foto:', e.message);
    res.status(404).send('Foto no disponible');
  }
});

app.get('/api/admin/cargas', async (req, res) => {
  const TOKEN_DASHBOARD = process.env.DASHBOARD_TOKEN || 'regis2024';
  if (req.query.token !== TOKEN_DASHBOARD) return res.status(401).json({ ok: false });
  try {
    const rows    = await getRows(SHEET_BOT, 'Cargas');
    const headers = rows[0] || [];
    const col     = (nombre) => headers.findIndex(h => h === nombre);
    const cargas = rows.slice(1).map(r => ({
      fecha:    r[col('Fecha')]    || '',
      operador: r[col('Operador')] || '',
      tracto:   r[col('Tracto')]   || '',
      lugar:    r[col('Lugar')]    || '',
      comida:   parseFloat(r[col('Comida')]) || 0,
      aguas:    parseFloat(r[col('Aguas')])  || 0,
    })).reverse();
    res.json({ ok: true, cargas });
  } catch (e) {
    console.error('Error API cargas:', e.message);
    res.json({ ok: false, error: e.message });
  }
});
 
app.get('/api/admin/semanal', async (req, res) => {
  if (req.query.token !== DASH_TOKEN()) return res.status(401).json({ ok: false });
  try {
    const ref = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ref || '') ? req.query.ref : null;
    const datos = await dashboard.datosSemanales({ getSheets, spreadsheetId: SHEET_BOT, tab: DASH_TAB, ref });
    res.json({ ok: true, ...datos });
  } catch (e) {
    console.error('Error API semanal:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//   ARRANQUE
// ═══════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`🚛 Servidor en puerto ${PORT}`);
  console.log(`👥 Admins: ${ADMIN_IDS.length} — ${ADMIN_IDS.join(', ')}`);
  console.log(vale.disponible() ? '🔎 Lectura automática de vales: ACTIVA' : '🔎 Lectura automática de vales: desactivada (falta ANTHROPIC_API_KEY)');
  try {
    dashboard.programar({ bot, chatIds: ADMIN_IDS, getSheets, spreadsheetId: SHEET_BOT, tab: DASH_TAB, panelUrl: panelUrl(), expr: DASH_CRON });
  } catch (e) { console.error('❌ No se pudo programar el resumen semanal:', e.message); }
 
  if (!WEBHOOK_URL) {
    console.error('❌ Falta WEBHOOK_URL en variables de entorno.');
    return;
  }
  try {
    await bot.deleteWebHook();
    await new Promise(r => setTimeout(r, 1000));
    const wh = `${WEBHOOK_URL}/bot${TOKEN}`;
    await bot.setWebHook(wh);
    console.log(`✅ Webhook: ${wh}`);
  } catch(e) {
    console.error('❌ Error webhook:', e.message);
  }
});
