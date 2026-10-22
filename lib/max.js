/**
 * Клиент API мессенджера MAX (https://dev.max.ru/docs-api).
 *
 * - Токен — в заголовке Authorization (без "Bearer"), MAX_BOT_TOKEN.
 * - Сервер API подписан российским УЦ Минцифры. В стандартном наборе
 *   сертификатов Node.js его нет, поэтому для запросов к MAX (и только к MAX)
 *   добавляем к стандартным корням Russian Trusted Root CA из lib/certs.
 *   Проверка сертификата остаётся включённой.
 */
import https from 'node:https';
import tls from 'node:tls';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MAX_API_URL = process.env.MAX_API_URL || 'https://platform-api2.max.ru';
export const maxToken = () => process.env.MAX_BOT_TOKEN || '';
export const maxEnabled = () => Boolean(maxToken());

const RUSSIAN_CA = readFileSync(new URL('./certs/russian_trusted_ca.pem', import.meta.url), 'utf8');
let agent;
function getAgent() {
  if (!agent) agent = new https.Agent({ keepAlive: true, ca: [...tls.rootCertificates, RUSSIAN_CA] });
  return agent;
}

export class MaxApiError extends Error {
  constructor(status, data, method, path) {
    const msg = data?.message || data?.code || (typeof data === 'string' ? data : JSON.stringify(data));
    super(`MAX ${method} ${path} → ${status}: ${msg}`);
    this.status = status;
    this.data = data;
    this.description = msg;
  }
}

// Подменяется в тестах: (method, path, { query, body }) => данные ответа.
let transport = null;
export function setMaxTransport(fn) { transport = fn; }

function rawRequest(method, path, { query, body } = {}) {
  const url = new URL(path, MAX_API_URL);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      agent: getAgent(),
      timeout: 10_000,
      headers: {
        Authorization: maxToken(),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : {}; } catch { /* не JSON */ }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`MAX ${method} ${path}: timeout`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Вызов API. Ошибка HTTP или success:false — исключение MaxApiError. */
export async function maxCall(method, path, opts = {}) {
  if (transport) return transport(method, path, opts);
  let res = await rawRequest(method, path, opts);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1100)); // лимит 30 запросов/с и 2 сообщения/с в чат
    res = await rawRequest(method, path, opts);
  }
  if (res.status < 200 || res.status >= 300 || res.data?.success === false) {
    throw new MaxApiError(res.status, res.data, method, path);
  }
  return res.data;
}

// ---------- сообщения ----------

/**
 * Получатель: личный диалог адресуется по user_id, групповой чат — по chat_id.
 * to = { userId } | { chatId }.
 */
const recipientQuery = (to) => (to.userId != null ? { user_id: to.userId } : { chat_id: to.chatId });

/** Кастомные эмодзи Telegram (<tg-emoji>) MAX не понимает — оставляем обычные. */
export const maxText = (text) => String(text ?? '').replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1');

/**
 * Клавиатура в формате Telegram (reply_markup.inline_keyboard, её строит
 * grammy InlineKeyboard) → вложение inline_keyboard для MAX.
 */
export function toMaxKeyboard(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  const buttons = rows
    .filter((r) => r.length > 0)
    .map((r) => r.map((b) => {
      const text = (b.text || '').trim() ? b.text : '·'; // пустые подписи MAX не принимает
      if (b.url) return { type: 'link', text, url: b.url };
      if (b.copy_text) return { type: 'clipboard', text, payload: b.copy_text.text };
      return { type: 'callback', text, payload: b.callback_data ?? 'noop' };
    }));
  return buttons.length ? { type: 'inline_keyboard', payload: { buttons } } : null;
}

/** Тело сообщения MAX из текста в HTML-разметке и клавиатуры в формате Telegram. */
export function maxBody(text, replyMarkup) {
  const kb = toMaxKeyboard(replyMarkup);
  return { text: maxText(text), format: 'html', attachments: kb ? [kb] : [], notify: true };
}

export async function maxSend(to, text, replyMarkup) {
  const data = await maxCall('POST', '/messages', {
    query: { ...recipientQuery(to), disable_link_preview: true },
    body: maxBody(text, replyMarkup),
  });
  return { mid: data?.message?.body?.mid ?? null, message: data?.message };
}

export async function maxEdit(mid, text, replyMarkup) {
  await maxCall('PUT', '/messages', { query: { message_id: mid }, body: maxBody(text, replyMarkup) });
}

export async function maxDelete(mid) {
  await maxCall('DELETE', '/messages', { query: { message_id: mid } });
}

/** Ответ на нажатие кнопки: всплывающее уведомление и/или новое содержимое сообщения. */
export async function maxAnswer(callbackId, { notification, message } = {}) {
  const body = {};
  if (notification) body.notification = notification;
  if (message) body.message = message;
  await maxCall('POST', '/answers', { query: { callback_id: callbackId }, body });
}

export async function maxChatAdmins(chatId) {
  const data = await maxCall('GET', `/chats/${chatId}/members/admins`);
  return data?.members || [];
}

// ---------- вебхук ----------

/** Секрет вебхука выводится из токена — отдельная переменная не нужна. */
export function maxWebhookSecret() {
  return createHmac('sha256', maxToken()).update('college-schedule-bot:max-webhook').digest('hex');
}

/** Отпечаток токена (не сам токен) — чтобы заметить, что токен перевыпустили. */
export function maxTokenFingerprint() {
  return createHmac('sha256', maxToken()).update('college-schedule-bot:fingerprint').digest('hex').slice(0, 16);
}

export function maxWebhookUrl() {
  if (process.env.MAX_WEBHOOK_URL) return process.env.MAX_WEBHOOK_URL;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}/api/max` : null;
}

export const MAX_UPDATE_TYPES = ['message_created', 'message_callback', 'bot_started', 'bot_added'];

/**
 * Подписка на вебхук. MAX сам отписывает бота, если сервер 8 часов не
 * отвечал 200, поэтому проверяем подписку на каждом тике и при надобности
 * подписываемся снова. force — переподписаться заново (например, после
 * перевыпуска токена: секрет вебхука от него зависит).
 * Возвращает 'ok' | 'subscribed' | 'skipped'.
 */
export async function ensureMaxSubscription({ force = false } = {}) {
  const url = maxWebhookUrl();
  if (!maxEnabled() || !url) return 'skipped';
  const data = await maxCall('GET', '/subscriptions');
  const subs = data?.subscriptions || [];
  const exists = subs.some((s) => s.url === url);
  if (exists && !force) return 'ok';
  if (exists) await maxCall('DELETE', '/subscriptions', { query: { url } });
  await maxCall('POST', '/subscriptions', {
    body: { url, update_types: MAX_UPDATE_TYPES, secret: maxWebhookSecret() },
  });
  return 'subscribed';
}
