'use strict';
/**
 * Lectura automática de vales y tickets de diésel a partir de una foto.
 * Proveedores (se usa el primero que tenga llave en Railway):
 *   1) Claude  → variable ANTHROPIC_API_KEY
 *   2) Gemini  → variable GEMINI_API_KEY
 * Sin ninguna de las dos el bot sigue funcionando: guarda la foto y pregunta los datos por texto.
 */
const API = 'https://api.anthropic.com/v1/messages';
const modelo = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const GEMINI_API = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const modelosGemini = () => process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-3.5-flash', 'gemini-2.5-flash'];
const proveedor = () => process.env.ANTHROPIC_API_KEY ? 'Claude' : process.env.GEMINI_API_KEY ? 'Gemini' : null;
const disponible = () => !!proveedor();

const SISTEMA = `Eres un asistente que lee fotos de comprobantes de diésel de una empresa de transporte en México.
Recibirás UNA foto. Puede ser:
- "vale": papel rosa "VALE A: SERVIEXPRESS SANTA ANITA" con folio impreso (Nº), fecha escrita a mano, producto marcado con X y "cantidad en pesos" escrita a mano.
- "ticket": ticket térmico de la gasolinera con Fecha Compra, número de TICKET, producto DIESEL, precio por litro ($xLts), Cantidad (litros) y Pesos.
- "otro": cualquier otra cosa.
La foto puede venir girada; léela en la orientación correcta.

Responde SOLO con un objeto JSON, sin texto antes ni después ni bloques de código, con estas claves:
{
 "tipo": "vale" | "ticket" | "otro",
 "calidad": "buena" | "regular" | "ilegible",
 "folio": string con solo dígitos o null,
 "fecha": "AAAA-MM-DD" o null,
 "importe": número en pesos o null,
 "litros": número o null,
 "precio_litro": número o null,
 "ticket": string o null,
 "producto": "diesel" | "magna" | "premium" | null,
 "vehiculo": texto escrito en el campo Vehículo o null,
 "dudosos": lista con los nombres de las claves que no se leen con certeza
}
Reglas:
- Si la foto está borrosa, movida, cortada o muy oscura, usa calidad "ilegible" (si no se puede leer casi nada) o "regular" (si se leen algunos datos).
- NUNCA adivines. Si un dígito o dato no se ve con certeza, pon null y agrega esa clave a "dudosos".
- En el vale: "folio" es el número rojo junto a "Nº"; "importe" es la cantidad en pesos escrita a mano; "litros" casi siempre va vacío (null).
- En el ticket: "litros" es la columna Cantidad; "importe" es el Total; "precio_litro" es $xLts; "fecha" es Fecha Compra; "ticket" es el número después de TICKET.
- Las fechas mexicanas son día/mes/año (06/10/2026 = 6 de octubre de 2026). Una fecha manuscrita "06-oct-26" es 2026-10-06.`;

function extraerJSON(txt) {
  const limpio = String(txt || '').replace(/```json|```/g, '').trim();
  const a = limpio.indexOf('{'), b = limpio.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('La respuesta no trae datos legibles');
  return JSON.parse(limpio.slice(a, b + 1));
}

const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

/** Normaliza y valida lo que devolvió el modelo; lo dudoso queda en null y en `dudosos`. */
function normalizar(o) {
  const dudosos = new Set(Array.isArray(o.dudosos) ? o.dudosos.map(String) : []);
  const tipo = ['vale', 'ticket'].includes(o.tipo) ? o.tipo : 'otro';
  const calidad = ['buena', 'regular', 'ilegible'].includes(o.calidad) ? o.calidad : 'regular';
  const r = { tipo, calidad, folio: null, fecha: null, importe: null, litros: null, precio_litro: null, ticket: null, producto: null, vehiculo: null };

  const folio = String(o.folio ?? '').replace(/\D/g, '');
  r.folio = /^\d{4,10}$/.test(folio) ? folio : null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(o.fecha || '')) {
    const y = +o.fecha.slice(0, 4);
    if (y >= 2024 && y <= 2035) r.fecha = o.fecha;
  }
  r.importe = num(o.importe);
  r.litros = num(o.litros);
  r.precio_litro = num(o.precio_litro);
  if (r.precio_litro && (r.precio_litro < 10 || r.precio_litro > 60)) { r.precio_litro = null; dudosos.add('precio_litro'); }   // $/lt de diésel fuera de lo creíble
  r.ticket = o.ticket ? String(o.ticket).replace(/\D/g, '') || null : null;
  r.producto = ['diesel', 'magna', 'premium'].includes(o.producto) ? o.producto : null;
  r.vehiculo = o.vehiculo ? String(o.vehiculo).slice(0, 40) : null;

  // todo campo vacío que el modelo marcó como dudoso queda registrado
  for (const k of Object.keys(r)) if (r[k] == null && dudosos.has(k)) dudosos.add(k);
  r.dudosos = [...dudosos];
  return r;
}

async function leerConClaude(buffer, mediaType) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: modelo(), max_tokens: 700, system: SISTEMA,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: 'Extrae los datos de esta foto.' },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Claude respondió ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

async function leerConGemini(buffer, mediaType) {
  const cuerpo = JSON.stringify({
    systemInstruction: { parts: [{ text: SISTEMA }] },
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mediaType, data: buffer.toString('base64') } },
      { text: 'Extrae los datos de esta foto.' },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4096 },
  });
  let ultimoError = null;
  for (const m of modelosGemini()) {                      // si el primer modelo no existe (404), prueba el siguiente
    const res = await fetch(GEMINI_API(m), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: cuerpo,
    });
    if (res.status === 404) { ultimoError = new Error(`Gemini: el modelo ${m} no existe para tu llave (404)`); continue; }
    if (!res.ok) throw new Error(`Gemini respondió ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    const partes = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const txt = partes.filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!txt) throw new Error(`Gemini no devolvió texto${j.promptFeedback && j.promptFeedback.blockReason ? ' (bloqueado: ' + j.promptFeedback.blockReason + ')' : ''}`);
    return txt;
  }
  throw ultimoError || new Error('Gemini: sin modelo disponible');
}

/** buffer = bytes de la imagen (JPEG). Lanza error si la API falla. */
async function leer(buffer, mediaType = 'image/jpeg') {
  const prov = proveedor();
  if (!prov) throw new Error('No hay ANTHROPIC_API_KEY ni GEMINI_API_KEY');
  const txt = prov === 'Claude' ? await leerConClaude(buffer, mediaType) : await leerConGemini(buffer, mediaType);
  return normalizar(extraerJSON(txt));
}

module.exports = { leer, disponible, proveedor, normalizar, extraerJSON };
