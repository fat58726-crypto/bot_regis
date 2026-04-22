'use strict';
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;

// ── CORRECCIÓN #1: Limpieza robusta de ADMIN_IDS
// Se eliminan espacios, saltos de línea, y el símbolo = que puede colarse en Railway
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',')
  .map(s => s.trim().replace(/[^0-9]/g, ''))  // solo deja números
  .filter(s => s.length > 0);

function isAdmin(chatId) { return ADMIN_IDS.includes(String(chatId)); }

function notificarAdmins(mensaje, opciones = {}) {
  ADMIN_IDS.forEach(id => {
    bot.sendMessage(id, mensaje, opciones).catch(e =>
      console.error(`No se pudo notificar admin ${id}:`, e.message));
  });
}

const SHEET_BOT    = '1i7uciYXLNuZ-DPxE8H0TAQyuegqVzegE751tUNhi7Qc';
const SHEET_DIESEL = '1tEmPW1BGE7MgMXD5iOsLwq8G46GxKkT8sRuqBkdFUOk';

const bot = new TelegramBot(TOKEN, { polling: false });

// ── MENÚS ────────────────────────────────────────────────

const MENU_OPERADOR = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Confirmar mi viaje',  callback_data: 'confirmar_viaje' }],
      [{ text: '💰 Reportar mis gastos', callback_data: 'iniciar_gastos'  }],
      [{ text: '📦 Registrar carga',     callback_data: 'iniciar_carga'   }],
    ]
  }
};

const MENU_ADMIN = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📋 Ver viajes',    callback_data: 'ver_viajes'    },
       { text: '➕ Nuevos viajes', callback_data: 'nuevos_viajes' }],
      [{ text: '👥 Operadores',    callback_data: 'ver_operadores'},
       { text: '⛽ Registrar diésel', callback_data: 'iniciar_diesel' }],
      [{ text: '📊 Resumen',       callback_data: 'ver_resumen'   }],
    ]
  }
};

const BTN_CANCELAR = {
  reply_markup: {
    inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancelar' }]]
  }
};

// ── PREGUNTAS ────────────────────────────────────────────

const PREGUNTAS_GASTOS = [
  { campo: 'fecha_viaje', pregunta: '📅 ¿Fecha del viaje?\nEjemplo: 20/Abr' },
  { campo: 'destino',     pregunta: '📍 ¿Origen y destino?\nEjemplo: Irapuato - Guadalajara' },
  { campo: 'dias',        pregunta: '📅 ¿Cuántos días duró el viaje?' },
  { campo: 'anticipo',    pregunta: '💵 ¿Cuánto de anticipo te dieron?' },
  { campo: 'comida',      pregunta: '🍽️ ¿Cuánto gastaste en comidas?\n(Si fue $0 escribe 0)' },
  { campo: 'aguas',       pregunta: '💧 ¿Cuánto gastaste en aguas?\n(Si fue $0 escribe 0)' },
  { campo: 'casetas',     pregunta: '🛣️ ¿Cuánto pagaste en casetas?\n(Si fue $0 escribe 0)' },
  { campo: 'pension',     pregunta: '🅿️ ¿Cuánto de pensión?\n(Si fue $0 escribe 0)' },
  { campo: 'federales',   pregunta: '👮 ¿Cuánto de federales?\n(Si fue $0 escribe 0)' },
  { campo: 'otros',       pregunta: '📦 ¿Algún otro gasto?\n(Si fue $0 escribe 0)' },
];

const PREGUNTAS_CARGA = [
  { campo: 'fecha_carga', pregunta: '📅 ¿Fecha de la carga?\nEjemplo: 20/Abr' },
  { campo: 'lugar',       pregunta: '📍 ¿En dónde cargas?\nEjemplo: Ingenio El Potrero' },
  { campo: 'comida',      pregunta: '🍽️ ¿Cuánto gastaste en comidas?\n(Si fue $0 escribe 0)' },
  { campo: 'aguas',       pregunta: '💧 ¿Cuánto gastaste en aguas?\n(Si fue $0 escribe 0)' },
];

const PREGUNTAS_DIESEL = [
  { campo: 'operador', pregunta: '👤 ¿Qué operador? (Victor, Paco, Rafa, Samuel)' },
  { campo: 'tracto',   pregunta: '🚛 ¿Número de tracto?' },
  { campo: 'km_nuevo', pregunta: '📏 Kilometraje actual del odómetro' },
  { campo: 'km_ant',   pregunta: '📏 Kilometraje anterior' },
  { campo: 'litros',   pregunta: '⛽ ¿Cuántos litros cargó?' },
  { campo: 'vale',     pregunta: '🔢 ¿Número de vale?' },
];

const CAMPOS_NUMERICOS = ['anticipo','comida','aguas','casetas','pension','federales','otros','dias','km_nuevo','km_ant','litros'];

function esNumeroValido(txt) { return /^\d+(\.\d+)?$/.test(txt.trim()); }
function parsearNumero(v)    { return parseFloat(v) || 0; }

// ── GOOGLE SHEETS ────────────────────────────────────────

function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendRow(sheetId, tab, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

async function getRows(sheetId, tab) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A1:Z1000`,
  });
  return res.data.values || [];
}

async function getOperadores() {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  const ops  = {};
  rows.forEach(r => {
    if (r[0] && r[0] !== 'chatId') ops[r[0]] = { chatId: r[0], nombre: r[1], tracto: r[2] };
  });
  return ops;
}

async function saveOperador(chatId, nombre, tracto) {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  if (rows.length === 0) await appendRow(SHEET_BOT, 'Operadores', ['chatId','nombre','tracto']);
  const existing = rows.findIndex(r => r[0] === String(chatId));
  if (existing >= 0) {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_BOT,
      range: `Operadores!A${existing + 1}:C${existing + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[String(chatId), nombre, tracto]] },
    });
  } else {
    await appendRow(SHEET_BOT, 'Operadores', [String(chatId), nombre, tracto]);
  }
}

async function getViajes() {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  return rows
    .filter(r => r[0] && r[0] !== 'idx')
    .map(r => ({
      idx:        r[0],
      fecha:      r[1],
      cliente:    r[2],
      destino:    r[3],
      hora:       r[4],
      operador:   r[5] || '',
      confirmado: r[6] || '',
    }));
}

async function saveViaje(v) {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  if (rows.length === 0) await appendRow(SHEET_BOT, 'Viajes', ['idx','fecha','cliente','destino','hora','operador','confirmado']);
  const idx = rows.filter(r => r[0] !== 'idx').length + 1;
  await appendRow(SHEET_BOT, 'Viajes', [idx, v.fecha, v.cliente, v.destino, v.hora, v.operador, '']);
}

async function borrarViaje(idx) {
  const sheets = getSheetsClient();
  const rows   = await getRows(SHEET_BOT, 'Viajes');
  const rowIdx = rows.findIndex(r => r[0] === String(idx));
  if (rowIdx < 0) return false;

  const meta  = await sheets.spreadsheets.get({ spreadsheetId: SHEET_BOT });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'Viajes');
  if (!sheet) return false;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_BOT,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    sheet.properties.sheetId,
            dimension:  'ROWS',
            startIndex: rowIdx,
            endIndex:   rowIdx + 1,
          }
        }
      }]
    }
  });
  return true;
}

async function ensureGastosHeader() {
  const rows = await getRows(SHEET_BOT, 'Gastos');
  if (rows.length === 0) {
    await appendRow(SHEET_BOT, 'Gastos', [
      'Fecha','Operador','Tracto','Destino','Días',
      'Anticipo','Comida','Aguas','Casetas','Pensión',
      'Federales','Otros','Total','Diferencia'
    ]);
  }
}

// ── ESTADO DE USUARIO ────────────────────────────────────
const userState = {};

// ── INICIO BOT ───────────────────────────────────────────
async function iniciarBot() {
  try {
    await bot.deleteWebHook();
    await new Promise(r => setTimeout(r, 2000));
    bot.startPolling({ interval: 300, params: { timeout: 10 } });
    console.log('🚛 Bot Transportes Regis iniciado...');
    console.log(`👥 Administradores: ${ADMIN_IDS.length}`);
    ADMIN_IDS.forEach(id => console.log(`   - Admin ID: ${id}`));
  } catch (e) {
    console.error('Error iniciando bot:', e.message);
    process.exit(1);
  }
}

// ── HELPERS ──────────────────────────────────────────────

function generarResumenGastos(d, anticipo, total, diferencia) {
  return (
    `📋 *Revisa tus gastos antes de guardar:*\n\n` +
    `📅 Fecha:       ${d.fecha_viaje}\n` +
    `📍 Destino:     ${d.destino}\n` +
    `📅 Días:        ${d.dias}\n\n` +
    `💵 Anticipo:    $${anticipo.toFixed(2)}\n` +
    `🍽️ Comidas:     $${parsearNumero(d.comida).toFixed(2)}\n` +
    `💧 Aguas:       $${parsearNumero(d.aguas).toFixed(2)}\n` +
    `🛣️ Casetas:     $${parsearNumero(d.casetas).toFixed(2)}\n` +
    `🅿️ Pensión:     $${parsearNumero(d.pension).toFixed(2)}\n` +
    `👮 Federales:   $${parsearNumero(d.federales).toFixed(2)}\n` +
    `📦 Otros:       $${parsearNumero(d.otros).toFixed(2)}\n\n` +
    `💰 *Total:      $${total.toFixed(2)}*\n` +
    `${diferencia >= 0 ? '✅' : '🔴'} *Diferencia:   $${diferencia.toFixed(2)}*\n\n` +
    `¿Todo correcto?`
  );
}

const MENU_CONFIRMAR_GASTOS = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '✅ Sí, guardar',   callback_data: 'gastos_confirmar' },
        { text: '❌ No, repetir',   callback_data: 'gastos_repetir'   },
      ]
    ]
  }
};

const MENU_CONFIRMAR_CARGA = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '✅ Sí, guardar',   callback_data: 'carga_confirmar' },
        { text: '❌ No, repetir',   callback_data: 'carga_repetir'   },
      ]
    ]
  }
};

// ── COMANDO /start ────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  // ── CORRECCIÓN #2: Admin siempre ve menú admin, aunque esté en la hoja de operadores
  if (isAdmin(chatId)) {
    return bot.sendMessage(chatId,
      `👋 *Bienvenido Admin!*\n\n¿Qué quieres hacer?`,
      { parse_mode: 'Markdown', ...MENU_ADMIN });
  }

  const ops      = await getOperadores();
  const operador = ops[String(chatId)];
  if (operador) {
    bot.sendMessage(chatId,
      `👋 Hola *${operador.nombre}* 🚛\n\n¿Qué necesitas?\n\n_Si algo falla escribe /reset_`,
      { parse_mode: 'Markdown', ...MENU_OPERADOR });
  } else {
    bot.sendMessage(chatId,
      `👋 Bienvenido al Bot de Transportes Regis 🚛\n\nPrimero regístrate con tu nombre y número de tracto:\n\n/registrar NOMBRE TRACTO\n\nEjemplo:\n/registrar Rafael 9`);
  }
});

// ── COMANDO /reset ────────────────────────────────────────
bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { estado: null };
  if (isAdmin(chatId)) {
    return bot.sendMessage(chatId, '🔄 Estado reiniciado.', { parse_mode: 'Markdown', ...MENU_ADMIN });
  }
  const ops      = await getOperadores();
  const operador = ops[String(chatId)];
  if (operador) {
    bot.sendMessage(chatId, '🔄 Listo, ¿qué necesitas?', { parse_mode: 'Markdown', ...MENU_OPERADOR });
  }
});

// ── CORRECCIÓN #3: Comando /miadmin — para que el admin vea su ID en cualquier momento
bot.onText(/\/miadmin/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🔎 Tu Telegram ID es: \`${chatId}\`\n\nAdmin reconocido: *${isAdmin(chatId) ? 'SÍ ✅' : 'NO ❌'}*`,
    { parse_mode: 'Markdown' });
});

// ── COMANDO /registrar ────────────────────────────────────
bot.onText(/\/registrar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  // ── CORRECCIÓN #4: Admins no pueden registrarse como operadores accidentalmente
  if (isAdmin(chatId)) {
    return bot.sendMessage(chatId,
      `⚠️ Eres administrador, no necesitas registrarte como operador.\n\n¿Qué necesitas?`,
      { parse_mode: 'Markdown', ...MENU_ADMIN });
  }

  const parts  = match[1].trim().split(' ');
  if (parts.length < 2) {
    return bot.sendMessage(chatId, '❌ Ejemplo correcto:\n/registrar Rafael 9');
  }
  const nombre = parts[0];
  const tracto = parts[1];
  try {
    await saveOperador(chatId, nombre, tracto);
    bot.sendMessage(chatId,
      `✅ Registrado como *${nombre}* — Tracto #${tracto}\n\n¿Qué necesitas?`,
      { parse_mode: 'Markdown', ...MENU_OPERADOR });
    notificarAdmins(`🚛 Nuevo operador: *${nombre}* — Tracto #${tracto}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Error al registrar. Intenta de nuevo.');
  }
});

// ── COMANDO /borrar ───────────────────────────────────────
bot.onText(/\/borrar (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const idx = match[1];
  try {
    const viajes = await getViajes();
    const viaje  = viajes.find(v => v.idx === idx);
    if (!viaje) return bot.sendMessage(chatId, `❌ No existe el viaje #${idx}`);
    const ok = await borrarViaje(idx);
    if (ok) {
      bot.sendMessage(chatId,
        `🗑️ Viaje #${idx} eliminado\n📍 ${viaje.destino} | ${viaje.fecha}`,
        { parse_mode: 'Markdown', ...MENU_ADMIN });
    } else {
      bot.sendMessage(chatId, '❌ No se pudo borrar. Intenta de nuevo.');
    }
  } catch (e) {
    console.error('Error borrando viaje:', e.message);
    bot.sendMessage(chatId, '❌ Error al borrar. Intenta de nuevo.');
  }
});

// ── CALLBACKS DE BOTONES ──────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  bot.answerCallbackQuery(query.id);

  // ── CANCELAR cualquier flujo ──
  if (data === 'cancelar') {
    userState[chatId] = { estado: null };
    if (isAdmin(chatId)) {
      return bot.sendMessage(chatId, '↩️ Cancelado.', MENU_ADMIN);
    } else {
      return bot.sendMessage(chatId, '↩️ Cancelado. ¿Qué necesitas?', { parse_mode: 'Markdown', ...MENU_OPERADOR });
    }
  }

  // ── CONFIRMAR GASTOS — guardar ──
  if (data === 'gastos_confirmar') {
    const st = userState[chatId];
    if (!st || st.estado !== 'gastos_revision') return;

    const ops      = await getOperadores();
    const operador = ops[String(chatId)];
    const d        = st.datos;
    userState[chatId] = { estado: null };

    const total      = ['comida','aguas','casetas','pension','federales','otros']
      .reduce((s, k) => s + parsearNumero(d[k]), 0);
    const anticipo   = parsearNumero(d.anticipo);
    const diferencia = anticipo - total;

    try {
      await ensureGastosHeader();
      await appendRow(SHEET_BOT, 'Gastos', [
        d.fecha_viaje, operador.nombre, operador.tracto, d.destino, d.dias,
        anticipo,
        parsearNumero(d.comida), parsearNumero(d.aguas),
        parsearNumero(d.casetas), parsearNumero(d.pension),
        parsearNumero(d.federales),
        parsearNumero(d.otros),
        total, diferencia
      ]);
    } catch (e) {
      console.error('❌ ERROR guardando gastos:', e.message);
      bot.sendMessage(chatId, '⚠️ Error guardando. Avisa a Fabiola.\n\nUsa /reset para reiniciar.', MENU_OPERADOR);
      return;
    }

    const signo = diferencia >= 0 ? '✅' : '🔴';
    bot.sendMessage(chatId,
      `${signo} *Gastos guardados correctamente* 👍`,
      { parse_mode: 'Markdown', ...MENU_OPERADOR });

    const alertaAdmin =
      `💰 *Gastos de ${operador.nombre}*\n` +
      `📅 ${d.fecha_viaje} | 📍 ${d.destino} | ${d.dias} día(s)\n` +
      `Anticipo: $${anticipo} | Total: $${total.toFixed(2)}\n` +
      `${diferencia >= 0 ? '✅' : '🔴'} Diferencia: $${diferencia.toFixed(2)}`;
    notificarAdmins(alertaAdmin, { parse_mode: 'Markdown' });

    if (diferencia < 0) {
      notificarAdmins(
        `⚠️ *ALERTA — Diferencia negativa*\n${operador.nombre} gastó $${Math.abs(diferencia).toFixed(2)} más del anticipo.\n📅 ${d.fecha_viaje} | 📍 ${d.destino}`,
        { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── CONFIRMAR GASTOS — repetir ──
  if (data === 'gastos_repetir') {
    userState[chatId] = { estado: 'gastos', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `🔄 Vamos de nuevo.\n\n${PREGUNTAS_GASTOS[0].pregunta}`,
      { parse_mode: 'Markdown', ...BTN_CANCELAR });
    return;
  }

  // ── CONFIRMAR CARGA — guardar ──
  if (data === 'carga_confirmar') {
    const st = userState[chatId];
    if (!st || st.estado !== 'carga_revision') return;

    const ops      = await getOperadores();
    const operador = ops[String(chatId)];
    const d        = st.datos;
    userState[chatId] = { estado: null };

    const total = parsearNumero(d.comida) + parsearNumero(d.aguas);

    try {
      await appendRow(SHEET_BOT, 'Cargas', [
        d.fecha_carga,
        operador.nombre,
        operador.tracto,
        d.lugar,
        parsearNumero(d.comida),
        parsearNumero(d.aguas),
      ]);
    } catch (e) {
      console.error('❌ ERROR guardando carga:', e.message);
      bot.sendMessage(chatId, '⚠️ Error guardando. Avisa a Fabiola.\n\nUsa /reset para reiniciar.', MENU_OPERADOR);
      return;
    }

    bot.sendMessage(chatId,
      `✅ *Carga registrada correctamente* 👍`,
      { parse_mode: 'Markdown', ...MENU_OPERADOR });

    notificarAdmins(
      `📦 *Carga de ${operador.nombre}*\n` +
      `📅 ${d.fecha_carga} | 📍 ${d.lugar}\n` +
      `🍽️ Comidas: $${parsearNumero(d.comida).toFixed(2)} | 💧 Aguas: $${parsearNumero(d.aguas).toFixed(2)}\n` +
      `💰 Total: $${total.toFixed(2)}`,
      { parse_mode: 'Markdown' });
    return;
  }

  // ── CONFIRMAR CARGA — repetir ──
  if (data === 'carga_repetir') {
    userState[chatId] = { estado: 'carga', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `🔄 Vamos de nuevo.\n\n${PREGUNTAS_CARGA[0].pregunta}`,
      { parse_mode: 'Markdown', ...BTN_CANCELAR });
    return;
  }

  // ── OPERADOR: Confirmar viaje ──
  if (data === 'confirmar_viaje') {
    const ops      = await getOperadores();
    const operador = ops[String(chatId)];
    if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');

    const viajes  = await getViajes();
    const miViaje = viajes.find(v =>
      v.operador.toLowerCase().trim() === operador.nombre.toLowerCase().trim() &&
      v.confirmado !== 'si'
    );

    if (!miViaje) {
      return bot.sendMessage(chatId,
        '📋 No tienes viajes pendientes por confirmar.\n\n¿Qué más necesitas?',
        MENU_OPERADOR);
    }

    try {
      const rows   = await getRows(SHEET_BOT, 'Viajes');
      const rowIdx = rows.findIndex(r => r[0] === String(miViaje.idx));
      if (rowIdx >= 0) {
        const sheets = getSheetsClient();
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_BOT,
          range: `Viajes!G${rowIdx + 1}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['si']] },
        });
      }
    } catch(e) { console.error('Error confirmando viaje:', e.message); }

    notificarAdmins(
      `✅ *${operador.nombre}* confirmó su viaje\n📍 ${miViaje.destino} — ${miViaje.fecha}`,
      { parse_mode: 'Markdown' });

    bot.sendMessage(chatId,
      `✅ ¡Viaje confirmado!\n\n📍 *${miViaje.destino}*\n📅 ${miViaje.fecha}\n\n📋 Ahora envíame tu remisión y caja (fotos o números).\nCuando termines escribe *listo*`,
      { parse_mode: 'Markdown' });

    userState[chatId] = {
      estado:   'esperando_remision',
      viaje:    miViaje,
      operador: operador,
      archivos: []
    };
    return;
  }

  // ── OPERADOR: Iniciar gastos ──
  if (data === 'iniciar_gastos') {
    const ops      = await getOperadores();
    const operador = ops[String(chatId)];
    if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
    userState[chatId] = { estado: 'gastos', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `💰 *Reporte de Gastos*\n\n${PREGUNTAS_GASTOS[0].pregunta}`,
      { parse_mode: 'Markdown', ...BTN_CANCELAR });
    return;
  }

  // ── OPERADOR: Iniciar carga ──
  if (data === 'iniciar_carga') {
    const ops      = await getOperadores();
    const operador = ops[String(chatId)];
    if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
    userState[chatId] = { estado: 'carga', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `📦 *Registrar Carga*\n\n${PREGUNTAS_CARGA[0].pregunta}`,
      { parse_mode: 'Markdown', ...BTN_CANCELAR });
    return;
  }

  // ── ADMIN: Ver viajes ──
  if (data === 'ver_viajes') {
    if (!isAdmin(chatId)) return;
    const viajes = await getViajes();
    if (viajes.length === 0) {
      return bot.sendMessage(chatId, '❌ No hay viajes registrados.', MENU_ADMIN);
    }
    let lista = `📋 *Viajes registrados:*\n\n`;
    viajes.forEach(v => {
      const conf = v.confirmado === 'si' ? '✅' : '⏳';
      lista += `${conf} *${v.idx}.* ${v.fecha} | ${v.cliente} | ${v.destino}`;
      if (v.operador) lista += ` | ${v.operador}`;
      lista += '\n';
    });
    lista += `\nPara asignar: /asignar NUMERO NOMBRE`;
    lista += `\nPara borrar:  /borrar NUMERO`;
    bot.sendMessage(chatId, lista, { parse_mode: 'Markdown', ...MENU_ADMIN });
    return;
  }

  // ── ADMIN: Nuevos viajes ──
  if (data === 'nuevos_viajes') {
    if (!isAdmin(chatId)) return;
    userState[chatId] = { estado: 'esperando_viajes' };
    bot.sendMessage(chatId,
      `📋 *Agregar viajes*\n\nManda uno por línea con este formato:\n\`Fecha | Cliente | Destino | Hora\`\n\nEjemplo:\n\`19/Abr | Kerry | Guadalajara | 8:00am\`\n\nCuando termines escribe *fin*`,
      { parse_mode: 'Markdown', ...BTN_CANCELAR });
    return;
  }

  // ── ADMIN: Ver operadores ──
  if (data === 'ver_operadores') {
    if (!isAdmin(chatId)) return;
    const ops = await getOperadores();
    if (Object.keys(ops).length === 0) {
      return bot.sendMessage(chatId, '❌ No hay operadores registrados.', MENU_ADMIN);
    }
    let lista = `👥 *Operadores registrados:*\n\n`;
    Object.values(ops).forEach(op => {
      lista += `🚛 *${op.nombre}* — Tracto #${op.tracto}\n`;
    });
    bot.sendMessage(chatId, lista, { parse_mode: 'Markdown', ...MENU_ADMIN });
    return;
  }

  // ── ADMIN: Iniciar diesel ──
  if (data === 'iniciar_diesel') {
    if (!isAdmin(chatId)) return;
    userState[chatId] = { estado: 'diesel', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `⛽ *Registrar Diésel*\n\n${PREGUNTAS_DIESEL[0].pregunta}`,
      { parse_mode: 'Markdown', ...BTN_CANCELAR });
    return;
  }

  // ── ADMIN: Ver resumen ──
  if (data === 'ver_resumen') {
    if (!isAdmin(chatId)) return;
    const ops         = await getOperadores();
    const viajes      = await getViajes();
    const confirmados = viajes.filter(v => v.confirmado === 'si').length;
    const pendientes  = viajes.filter(v => v.confirmado !== 'si').length;
    bot.sendMessage(chatId,
      `📊 *Resumen*\n\n🚛 Operadores: ${Object.keys(ops).length}\n📋 Viajes totales: ${viajes.length}\n✅ Confirmados: ${confirmados}\n⏳ Pendientes: ${pendientes}`,
      { parse_mode: 'Markdown', ...MENU_ADMIN });
    return;
  }
});

// ── COMANDO /asignar ──────────────────────────────────────
bot.onText(/\/asignar (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const idx    = match[1];
  const nombre = match[2].trim();
  try {
    const rows   = await getRows(SHEET_BOT, 'Viajes');
    const rowIdx = rows.findIndex(r => r[0] === idx);
    if (rowIdx < 0) return bot.sendMessage(chatId, `❌ No existe el viaje #${idx}`);

    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_BOT,
      range: `Viajes!F${rowIdx + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[nombre]] },
    });

    const viaje = rows[rowIdx];
    const ops   = await getOperadores();
    const op    = Object.values(ops).find(o => o.nombre.toLowerCase() === nombre.toLowerCase());

    bot.sendMessage(chatId, `✅ Viaje #${idx} asignado a *${nombre}*`, { parse_mode: 'Markdown', ...MENU_ADMIN });

    if (op) {
      bot.sendMessage(op.chatId,
        `🚛 *¡Tienes un nuevo viaje!*\n\n📍 *Destino:* ${viaje[3]}\n📅 *Fecha:* ${viaje[1]}\n🕐 *Hora:* ${viaje[4] || 'Por confirmar'}\n🏭 *Cliente:* ${viaje[2]}\n\n¿Puedes confirmarlo?`,
        { parse_mode: 'Markdown', ...MENU_OPERADOR });
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Error al asignar. Intenta de nuevo.');
  }
});

// ── FLUJOS DE TEXTO ───────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;

  // Ignorar comandos
  if (!msg.text || msg.text.startsWith('/')) return;

  // ── Admin: Agregar viajes ──
  if (estado === 'esperando_viajes') {
    if (msg.text.toLowerCase() === 'fin') {
      userState[chatId] = { estado: null };
      const viajes = await getViajes();
      if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.', MENU_ADMIN);
      let lista = `✅ *Viajes registrados:*\n\n`;
      viajes.forEach(v => { lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino}\n`; });
      lista += `\nUsa /asignar NUMERO NOMBRE`;
      lista += `\nUsa /borrar NUMERO`;
      return bot.sendMessage(chatId, lista, { parse_mode: 'Markdown', ...MENU_ADMIN });
    }
    const lineas   = msg.text.split('\n').filter(l => l.trim());
    let agregados  = 0;
    for (const linea of lineas) {
      const partes = linea.split('|').map(p => p.trim());
      if (partes.length >= 3) {
        await saveViaje({ fecha: partes[0], cliente: partes[1], destino: partes[2], hora: partes[3] || 'Sin cita', operador: '' });
        agregados++;
      }
    }
    return bot.sendMessage(chatId,
      `✅ ${agregados} viaje(s) agregado(s). Sigue agregando o escribe *fin*`,
      { parse_mode: 'Markdown' });
  }

  // ── Operador: Remisión y caja ──
  if (estado === 'esperando_remision') {
    const { viaje, operador: op, archivos } = userState[chatId];

    if (msg.text.toLowerCase().trim() === 'listo') {
      userState[chatId] = { estado: null };

      if (archivos.length === 0) {
        bot.sendMessage(chatId,
          '⚠️ No mandaste ninguna foto o número.\nManda tu remisión y caja primero, luego escribe *listo*',
          { parse_mode: 'Markdown' });
        userState[chatId] = { estado: 'esperando_remision', viaje, operador: op, archivos };
        return;
      }

      const caption = `📋 *Remisión/Caja de ${op.nombre}*\n📍 ${viaje.destino} — ${viaje.fecha}`;
      notificarAdmins(caption, { parse_mode: 'Markdown' });

      for (const archivo of archivos) {
        if (archivo.tipo === 'foto') {
          ADMIN_IDS.forEach(id => {
            bot.sendPhoto(id, archivo.fileId).catch(e =>
              console.error(`Error enviando foto a admin ${id}:`, e.message));
          });
        } else {
          notificarAdmins(`📝 ${archivo.texto}`, {});
        }
      }

      bot.sendMessage(chatId,
        `✅ Listo, le avisé a Fabiola 👍\n\n¡Buen viaje! 🚛`,
        { parse_mode: 'Markdown', ...MENU_OPERADOR });
      return;
    }

    userState[chatId].archivos.push({ tipo: 'texto', texto: msg.text });
    bot.sendMessage(chatId,
      `✅ Guardado. Sigue mandando o escribe *listo* cuando termines`,
      { parse_mode: 'Markdown' });
    return;
  }

  // ── Operador: Gastos ──
  if (estado === 'gastos') {
    const paso  = userState[chatId].paso;
    const campo = PREGUNTAS_GASTOS[paso].campo;
    const texto = msg.text.trim();

    if (CAMPOS_NUMERICOS.includes(campo) && !esNumeroValido(texto)) {
      bot.sendMessage(chatId,
        `❌ Solo números.\n\n${PREGUNTAS_GASTOS[paso].pregunta}\n\nEjemplo: 250 o 0`,
        { parse_mode: 'Markdown', ...BTN_CANCELAR });
      return;
    }

    userState[chatId].datos[campo] = texto;
    const sig = paso + 1;

    if (sig < PREGUNTAS_GASTOS.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_GASTOS[sig].pregunta, BTN_CANCELAR);
    } else {
      const d          = userState[chatId].datos;
      const total      = ['comida','aguas','casetas','pension','federales','otros']
        .reduce((s, k) => s + parsearNumero(d[k]), 0);
      const anticipo   = parsearNumero(d.anticipo);
      const diferencia = anticipo - total;

      userState[chatId].estado = 'gastos_revision';

      bot.sendMessage(chatId,
        generarResumenGastos(d, anticipo, total, diferencia),
        { parse_mode: 'Markdown', ...MENU_CONFIRMAR_GASTOS });
    }
    return;
  }

  // ── Operador: Carga ──
  if (estado === 'carga') {
    const paso  = userState[chatId].paso;
    const campo = PREGUNTAS_CARGA[paso].campo;
    const texto = msg.text.trim();

    if (CAMPOS_NUMERICOS.includes(campo) && !esNumeroValido(texto)) {
      bot.sendMessage(chatId,
        `❌ Solo números.\n\n${PREGUNTAS_CARGA[paso].pregunta}\n\nEjemplo: 150 o 0`,
        { parse_mode: 'Markdown', ...BTN_CANCELAR });
      return;
    }

    userState[chatId].datos[campo] = texto;
    const sig = paso + 1;

    if (sig < PREGUNTAS_CARGA.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_CARGA[sig].pregunta, BTN_CANCELAR);
    } else {
      const d     = userState[chatId].datos;
      const total = parsearNumero(d.comida) + parsearNumero(d.aguas);

      userState[chatId].estado = 'carga_revision';

      bot.sendMessage(chatId,
        `📋 *Revisa tu carga antes de guardar:*\n\n` +
        `📅 Fecha:     ${d.fecha_carga}\n` +
        `📍 Lugar:     ${d.lugar}\n` +
        `🍽️ Comidas:   $${parsearNumero(d.comida).toFixed(2)}\n` +
        `💧 Aguas:     $${parsearNumero(d.aguas).toFixed(2)}\n\n` +
        `💰 *Total:    $${total.toFixed(2)}*\n\n` +
        `¿Todo correcto?`,
        { parse_mode: 'Markdown', ...MENU_CONFIRMAR_CARGA });
    }
    return;
  }

  // ── Admin: Diesel ──
  if (estado === 'diesel') {
    const paso  = userState[chatId].paso;
    const campo = PREGUNTAS_DIESEL[paso].campo;
    userState[chatId].datos[campo] = msg.text.trim();
    const sig = paso + 1;

    if (sig < PREGUNTAS_DIESEL.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_DIESEL[sig].pregunta, BTN_CANCELAR);
    } else {
      const d     = userState[chatId].datos;
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      const difKM = parsearNumero(d.km_nuevo) - parsearNumero(d.km_ant);
      const rend  = difKM > 0 ? (difKM / parsearNumero(d.litros)).toFixed(2) : '—';

      await appendRow(SHEET_DIESEL, 'Diesel', [
        fecha, d.vale, d.tracto,
        parsearNumero(d.km_nuevo), parsearNumero(d.km_ant),
        difKM, parsearNumero(d.litros), rend
      ]);

      bot.sendMessage(chatId,
        `⛽ *Diésel registrado*\n\nTracto: #${d.tracto}\nKM recorridos: ${difKM}\nRendimiento: ${rend} km/lt`,
        { parse_mode: 'Markdown', ...MENU_ADMIN });
    }
    return;
  }

  // Mensaje no reconocido → mostrar menú
  if (isAdmin(chatId)) {
    bot.sendMessage(chatId, '¿Qué necesitas?', MENU_ADMIN);
  } else {
    const ops      = await getOperadores();
    const operador = ops[String(chatId)];
    if (operador) {
      bot.sendMessage(chatId, `¿Qué necesitas, ${operador.nombre}?`, MENU_OPERADOR);
    } else {
      bot.sendMessage(chatId,
        `👋 Bienvenido al Bot de Transportes Regis 🚛\n\nPrimero regístrate:\n\n/registrar NOMBRE TRACTO\n\nEjemplo:\n/registrar Rafael 9`);
    }
  }
});

// ── FOTOS ─────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;

  if (estado === 'esperando_remision') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    userState[chatId].archivos.push({ tipo: 'foto', fileId });
    bot.sendMessage(chatId,
      `📸 Foto recibida. Sigue mandando o escribe *listo* cuando termines`,
      { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(chatId, 'Para reportar usa el menú 👇', MENU_OPERADOR);
});

iniciarBot();
