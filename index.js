'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { google }  = require('googleapis');
const express     = require('express');

const TOKEN       = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT        = process.env.PORT || 3000;

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map(s => s.trim().replace(/[^0-9]/g, ''))
  .filter(s => s.length > 0);

const SHEET_BOT    = '1i7uciYXLNuZ-DPxE8H0TAQyuegqVzegE751tUNhi7Qc';
const SHEET_DIESEL = '1tEmPW1BGE7MgMXD5iOsLwq8G46GxKkT8sRuqBkdFUOk';

const bot = new TelegramBot(TOKEN, { webHook: false });
const app = express();
app.use(express.json());
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
// Pestaña "Estado": chatId | estado_json
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

// ── MENÚS ─────────────────────────────────────────────────
const MENU_OP = { reply_markup: { inline_keyboard: [
  [{ text: '✅ Confirmar mi viaje',  callback_data: 'confirmar_viaje' }],
  [{ text: '💰 Reportar mis gastos', callback_data: 'iniciar_gastos'  }],
  [{ text: '📦 Registrar carga',     callback_data: 'iniciar_carga'   }],
]}};

const MENU_ADMIN = { reply_markup: { inline_keyboard: [
  [{ text: '📋 Ver viajes',       callback_data: 'ver_viajes'     }, { text: '➕ Nuevos viajes', callback_data: 'nuevos_viajes' }],
  [{ text: '👥 Operadores',       callback_data: 'ver_operadores' }, { text: '⛽ Diésel',        callback_data: 'iniciar_diesel' }],
  [{ text: '📊 Resumen',          callback_data: 'ver_resumen'    }],
]}};

const BTN_CANCELAR         = { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]] }};
const MENU_CONFIRM_GASTOS  = { reply_markup: { inline_keyboard: [[{ text: '✅ Guardar', callback_data: 'gastos_ok' }, { text: '🔄 Repetir', callback_data: 'gastos_repetir' }]] }};
const MENU_CONFIRM_CARGA   = { reply_markup: { inline_keyboard: [[{ text: '✅ Guardar', callback_data: 'carga_ok'  }, { text: '🔄 Repetir', callback_data: 'carga_repetir'  }]] }};

// ── PREGUNTAS ─────────────────────────────────────────────
const P_GASTOS = [
  { campo: 'fecha_viaje', pregunta: '📅 ¿Fecha del viaje?\nEjemplo: 20/Abr' },
  { campo: 'destino',     pregunta: '📍 ¿Origen y destino?\nEjemplo: Irapuato - Guadalajara' },
  { campo: 'dias',        pregunta: '📅 ¿Cuántos días duró el viaje?' },
  { campo: 'anticipo',    pregunta: '💵 ¿Cuánto de anticipo te dieron?' },
  { campo: 'comida',      pregunta: '🍽️ ¿Cuánto en comidas? (0 si nada)' },
  { campo: 'aguas',       pregunta: '💧 ¿Cuánto en aguas? (0 si nada)' },
  { campo: 'casetas',     pregunta: '🛣️ ¿Cuánto en casetas? (0 si nada)' },
  { campo: 'pension',     pregunta: '🅿️ ¿Cuánto de pensión? (0 si nada)' },
  { campo: 'federales',   pregunta: '👮 ¿Cuánto de federales? (0 si nada)' },
  { campo: 'otros',       pregunta: '📦 ¿Otro gasto? (0 si nada)' },
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

const NUMERICOS = ['anticipo','comida','aguas','casetas','pension','federales','otros','dias','km_nuevo','km_ant','litros'];

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

// ── GASTOS: RESUMEN ───────────────────────────────────────
function resumenGastos(d, anticipo, total, diferencia) {
  return `📋 *Revisa tus gastos:*\n\n` +
    `📅 Fecha:      ${d.fecha_viaje}\n📍 Destino:    ${d.destino}\n📅 Días:       ${d.dias}\n\n` +
    `💵 Anticipo:   $${anticipo.toFixed(2)}\n🍽️ Comidas:    $${toNum(d.comida).toFixed(2)}\n` +
    `💧 Aguas:      $${toNum(d.aguas).toFixed(2)}\n🛣️ Casetas:    $${toNum(d.casetas).toFixed(2)}\n` +
    `🅿️ Pensión:    $${toNum(d.pension).toFixed(2)}\n👮 Federales:  $${toNum(d.federales).toFixed(2)}\n` +
    `📦 Otros:      $${toNum(d.otros).toFixed(2)}\n\n` +
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
    const rows = await getRows(SHEET_BOT, 'Viajes');
    const viaje = rows[rowIdx];
    const ops   = await getOperadores();
    const op    = Object.values(ops).find(o => o.nombre.toLowerCase() === nombre.toLowerCase());
    bot.sendMessage(chatId, `✅ Viaje #${idx} asignado a *${nombre}*`, { parse_mode:'Markdown', ...MENU_ADMIN });
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

// ═══════════════════════════════════════════════════════════
//   CALLBACKS
// ═══════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  bot.answerCallbackQuery(query.id).catch(()=>{});

  try {
    // ── Cancelar ──
    if (data === 'cancelar') {
      await clearEstado(chatId);
      return isAdmin(chatId)
        ? bot.sendMessage(chatId, '↩️ Cancelado.', MENU_ADMIN)
        : bot.sendMessage(chatId, '↩️ Cancelado.', MENU_OP);
    }

    // ── Confirmar viaje ──
    if (data === 'confirmar_viaje') {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
      const viajes  = await getViajes();
      const miViaje = viajes.find(v =>
        v.operador.toLowerCase().trim() === op.nombre.toLowerCase().trim() &&
        v.confirmado !== 'si'
      );
      if (!miViaje) return bot.sendMessage(chatId, '📋 No tienes viajes pendientes.\n\n¿Qué más necesitas?', MENU_OP);

      // Marcar confirmado en Sheets
      const rowIdx = await getViajeRowIdx(miViaje.idx);
      if (rowIdx >= 0) await updateCell(SHEET_BOT, `Viajes!G${rowIdx+1}`, 'si');

      notificarAdmins(`✅ *${op.nombre}* confirmó su viaje\n📍 ${miViaje.destino} — ${miViaje.fecha}`, { parse_mode:'Markdown' });

      // Guardar estado de remisión en Sheets
      await setEstado(chatId, { estado: 'esperando_remision', viaje: miViaje, operador: op, archivos: [] });

      bot.sendMessage(chatId,
        `✅ ¡Viaje confirmado!\n\n📍 *${miViaje.destino}*\n📅 ${miViaje.fecha}\n\n📋 Ahora envíame tu *remisión y caja* (fotos o números).\nCuando termines escribe *listo*`,
        { parse_mode:'Markdown' });
      return;
    }

    // ── Iniciar gastos ──
    if (data === 'iniciar_gastos') {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
      await setEstado(chatId, { estado: 'gastos', paso: 0, datos: {} });
      bot.sendMessage(chatId, `💰 *Reporte de Gastos*\n\n${P_GASTOS[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }

    // ── Iniciar carga ──
    if (data === 'iniciar_carga') {
      const ops = await getOperadores();
      const op  = ops[String(chatId)];
      if (!op) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
      await setEstado(chatId, { estado: 'carga', paso: 0, datos: {} });
      bot.sendMessage(chatId, `📦 *Registrar Carga*\n\n${P_CARGA[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }

    // ── Gastos: guardar ──
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
      if (rows.length === 0) await appendRow(SHEET_BOT, 'Gastos', ['Fecha','Operador','Tracto','Destino','Días','Anticipo','Comida','Aguas','Casetas','Pensión','Federales','Otros','Total','Diferencia']);
      await appendRow(SHEET_BOT, 'Gastos', [d.fecha_viaje, op.nombre, op.tracto, d.destino, d.dias, anticipo, toNum(d.comida), toNum(d.aguas), toNum(d.casetas), toNum(d.pension), toNum(d.federales), toNum(d.otros), total, diferencia]);
      bot.sendMessage(chatId, `${diferencia>=0?'✅':'🔴'} *Gastos guardados correctamente* 👍`, { parse_mode:'Markdown', ...MENU_OP });
      notificarAdmins(`💰 *Gastos de ${op.nombre}*\n📅 ${d.fecha_viaje} | 📍 ${d.destino} | ${d.dias} día(s)\nAnticipo: $${anticipo} | Total: $${total.toFixed(2)}\n${diferencia>=0?'✅':'🔴'} Diferencia: $${diferencia.toFixed(2)}`, { parse_mode:'Markdown' });
      if (diferencia < 0) notificarAdmins(`⚠️ *ALERTA* ${op.nombre} gastó $${Math.abs(diferencia).toFixed(2)} más del anticipo.`, { parse_mode:'Markdown' });
      return;
    }

    if (data === 'gastos_repetir') {
      await setEstado(chatId, { estado: 'gastos', paso: 0, datos: {} });
      bot.sendMessage(chatId, `🔄 De nuevo.\n\n${P_GASTOS[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }

    // ── Carga: guardar ──
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

    // ── Admin: ver viajes ──
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

    // ── Admin: nuevos viajes ──
    if (data === 'nuevos_viajes') {
      if (!isAdmin(chatId)) return;
      await setEstado(chatId, { estado: 'esperando_viajes' });
      bot.sendMessage(chatId,
        `📋 *Agregar viajes*\n\nUn viaje por línea:\n\`Fecha | Cliente | Destino | Hora\`\n\nEjemplo:\n\`19/Abr | Kerry | Guadalajara | 8:00am\`\n\nEscribe *fin* cuando termines`,
        { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }

    // ── Admin: ver operadores ──
    if (data === 'ver_operadores') {
      if (!isAdmin(chatId)) return;
      const ops = await getOperadores();
      if (!Object.keys(ops).length) return bot.sendMessage(chatId, '❌ No hay operadores.', MENU_ADMIN);
      let lista = `👥 *Operadores:*\n\n`;
      Object.values(ops).forEach(o => { lista += `🚛 *${o.nombre}* — Tracto #${o.tracto}\n`; });
      bot.sendMessage(chatId, lista, { parse_mode:'Markdown', ...MENU_ADMIN });
      return;
    }

    // ── Admin: diesel ──
    if (data === 'iniciar_diesel') {
      if (!isAdmin(chatId)) return;
      await setEstado(chatId, { estado: 'diesel', paso: 0, datos: {} });
      bot.sendMessage(chatId, `⛽ *Registrar Diésel*\n\n${P_DIESEL[0].pregunta}`, { parse_mode:'Markdown', ...BTN_CANCELAR });
      return;
    }

    // ── Admin: resumen ──
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
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith('/')) return;

  try {
    const st     = await getEstado(chatId);
    const estado = st?.estado;

    // ── Admin: agregar viajes ──
    if (estado === 'esperando_viajes') {
      if (msg.text.toLowerCase() === 'fin') {
        await clearEstado(chatId);
        const viajes = await getViajes();
        if (!viajes.length) return bot.sendMessage(chatId, '❌ No hay viajes.', MENU_ADMIN);
        let lista = `✅ *Viajes:*\n\n`;
        viajes.forEach(v => { lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino}\n`; });
        lista += `\n/asignar NUMERO NOMBRE\n/borrar NUMERO`;
        return bot.sendMessage(chatId, lista, { parse_mode:'Markdown', ...MENU_ADMIN });
      }
      const lineas = msg.text.split('\n').filter(l => l.trim());
      let n = 0;
      for (const linea of lineas) {
        const p = linea.split('|').map(x => x.trim());
        if (p.length >= 3) { await saveViaje({ fecha: p[0], cliente: p[1], destino: p[2], hora: p[3]||'Sin cita', operador: '' }); n++; }
      }
      return bot.sendMessage(chatId, `✅ ${n} viaje(s) agregado(s). Sigue o escribe *fin*`, { parse_mode:'Markdown' });
    }

    // ── Remisión y caja ──
    if (estado === 'esperando_remision') {
      const { viaje, operador: op, archivos } = st;

      if (msg.text.toLowerCase().trim() === 'listo') {
        if (!archivos || archivos.length === 0) {
          bot.sendMessage(chatId, '⚠️ No mandaste nada todavía.\nManda fotos o números primero, luego escribe *listo*', { parse_mode:'Markdown' });
          return;
        }
        await clearEstado(chatId);
        notificarAdmins(`📋 *Remisión/Caja de ${op.nombre}*\n📍 ${viaje.destino} — ${viaje.fecha}`, { parse_mode:'Markdown' });
        for (const archivo of archivos) {
          if (archivo.tipo === 'foto') {
            ADMIN_IDS.forEach(id => bot.sendPhoto(id, archivo.fileId).catch(e => console.error('Error foto admin:', e.message)));
          } else {
            notificarAdmins(`📝 ${archivo.texto}`, {});
          }
        }
        bot.sendMessage(chatId, `✅ Listo, le avisé a Fabiola 👍\n\n¡Buen viaje! 🚛`, { parse_mode:'Markdown', ...MENU_OP });
        return;
      }

      // Acumular texto
      const nuevosArchivos = [...(archivos||[]), { tipo: 'texto', texto: msg.text }];
      await setEstado(chatId, { ...st, archivos: nuevosArchivos });
      bot.sendMessage(chatId, `✅ Guardado. Sigue mandando o escribe *listo*`, { parse_mode:'Markdown' });
      return;
    }

    // ── Gastos paso a paso ──
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

    // ── Carga paso a paso ──
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

    // ── Diesel paso a paso ──
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

    // ── Diesel sin foto ──
    if (estado === 'diesel_foto') {
      if (msg.text.toLowerCase().trim() === 'sin foto') {
        await guardarDiesel(chatId, null, st.datos);
      } else {
        bot.sendMessage(chatId, `📸 Manda la foto del vale o escribe *sin foto*`, { parse_mode:'Markdown' });
      }
      return;
    }

    // Mensaje no reconocido
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
});

// ═══════════════════════════════════════════════════════════
//   FOTOS
// ═══════════════════════════════════════════════════════════
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  try {
    const st     = await getEstado(chatId);
    const estado = st?.estado;

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

    bot.sendMessage(chatId, 'Para reportar usa el menú 👇', MENU_OP);
  } catch(e) {
    console.error('Error photo handler:', e.message);
  }
});

// ── GUARDAR DIESEL ────────────────────────────────────────
async function guardarDiesel(chatId, fotoFileId, d) {
  await clearEstado(chatId);
  const fecha = new Date().toLocaleDateString('es-MX');
  const difKM = toNum(d.km_nuevo) - toNum(d.km_ant);
  const rend  = difKM > 0 ? (difKM / toNum(d.litros)).toFixed(2) : '—';
  try {
    const rows = await getRows(SHEET_DIESEL, 'Diesel');
    if (rows.length === 0) await appendRow(SHEET_DIESEL, 'Diesel', ['Fecha','Vale','Operador','Tracto','KM Nuevo','KM Anterior','KM Recorridos','Litros','Rendimiento km/lt']);
    await appendRow(SHEET_DIESEL, 'Diesel', [fecha, d.vale, d.operador, d.tracto, toNum(d.km_nuevo), toNum(d.km_ant), difKM, toNum(d.litros), rend]);
  } catch(e) {
    console.error('Error guardando diesel:', e.message);
    bot.sendMessage(chatId, '⚠️ Error guardando diésel. Verifica que el spreadsheet esté compartido.', MENU_ADMIN);
    return;
  }
  bot.sendMessage(chatId, `⛽ *Diésel registrado* ✅\n\nOperador: ${d.operador}\nTracto: #${d.tracto}\nKM recorridos: ${difKM}\nRendimiento: ${rend} km/lt\nVale: #${d.vale}`, { parse_mode:'Markdown', ...MENU_ADMIN });
  if (fotoFileId) {
    ADMIN_IDS.forEach(id => bot.sendPhoto(id, fotoFileId, { caption: `⛽ Vale — ${d.operador} | Tracto #${d.tracto} | ${fecha}` }).catch(()=>{}));
  }
  notificarAdmins(`⛽ *Diésel* — ${d.operador} | Tracto #${d.tracto} | KM: ${difKM} | ${rend} km/lt | Vale #${d.vale}`, { parse_mode:'Markdown' });
}

// ── ERRORES GLOBALES ──────────────────────────────────────
bot.on('error', e => console.error('Bot error:', e.message));
process.on('uncaughtException',  e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

// ═══════════════════════════════════════════════════════════
//   ARRANQUE
// ═══════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`🚛 Servidor en puerto ${PORT}`);
  console.log(`👥 Admins: ${ADMIN_IDS.length}`);
  ADMIN_IDS.forEach(id => console.log(`   - ${id}`));

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
