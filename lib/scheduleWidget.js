import { GrammyError } from 'grammy';
import { query } from './db.js';
import { hasFeature, featureState } from './features.js';
import { getActiveTerm, getGroup, getLessonsForDay, groupHasSubgroups } from './schedule.js';
import { addDays, formatHumanDate, isoWeekday, mondayKeyOf, nowInTimezone, weekParityForDate } from './time.js';
import { SCHEDULE_WIDGET_HTML } from './scheduleWidgetHtml.js';

export const SCHEDULE_WIDGET_UPDATE = 'widget_query';
const REQUEST = /^schedule:(?:(w)|(t|n|d[0-6]):(0|[1-9][0-9]{0,2}))$/;
const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const PAGE_SIZE = 2;
const ERROR = 'Расписание временно недоступно.';

export async function canUseScheduleWidget(userId, isOwner) {
  if (await featureState('schedule_widget') === 'off') return false;
  return hasFeature('schedule_widget', { platform: 'telegram', userId, isOwner });
}

async function loadDay(groupId, date, subgroup) {
  const term = await getActiveTerm(groupId, date);
  if (!term) return { empty: 'На эту дату нет учебного периода.', lessons: [] };
  const lessons = await getLessonsForDay(term.id, isoWeekday(date), weekParityForDate(date, term.date_start), date, subgroup);
  return { empty: 'Пар нет.', lessons };
}

function compact(value, maxBytes) {
  const plain = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (Buffer.byteLength(JSON.stringify(plain)) - 2 <= maxBytes) return plain;
  let result = '';
  let bytes = 3; // ellipsis
  for (const char of plain) {
    bytes += Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes > maxBytes) break;
    result += char;
  }
  return result.trimEnd() + '…';
}

function shortDate(date) {
  return date.slice(8, 10) + '.' + date.slice(5, 7);
}

export function scheduleDayData({ route, page, title, group, empty, lessons }) {
  const pages = Math.ceil(lessons.length / PAGE_SIZE);
  const current = Math.min(page, Math.max(0, pages - 1));
  return {
    route, title, group: compact(group, 100), empty, page: current, pages,
    lessons: lessons.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((lesson) => [
      compact([lesson.time_start, lesson.time_end].filter(Boolean).join('–'), 30),
      compact(lesson.subject, 120), compact(lesson.teacher, 80), compact(lesson.room, 50),
      compact(lesson.lesson_type, 40), lesson.subgroup || null,
    ]),
  };
}

async function loadScheduleWidget(sub, group, route, page = 0) {
  const today = nowInTimezone(sub.timezone).dateKey;
  const monday = mondayKeyOf(today);
  const subgroup = sub.subgroup && await groupHasSubgroups(sub.group_id) ? sub.subgroup : null;
  const groupLabel = subgroup ? `${group.name} · подгр. ${subgroup}` : group.name;

  if (route === 'w') {
    const days = await Promise.all(DAY_LABELS.map(async (label, index) => {
      const date = addDays(monday, index);
      const { lessons } = await loadDay(sub.group_id, date, subgroup);
      return [`${label} ${shortDate(date)}`, new Set(lessons.map((lesson) => lesson.time_start)).size];
    }));
    return {
      route, title: `Неделя · ${shortDate(monday)}–${shortDate(addDays(monday, 6))}`,
      group: compact(groupLabel, 100), days,
    };
  }

  const date = route === 't' ? today : route === 'n' ? addDays(today, 1) : addDays(monday, Number(route[1]));
  const title = formatHumanDate(date, isoWeekday(date));
  const day = await loadDay(sub.group_id, date, subgroup);
  return scheduleDayData({ route, page, title, group: groupLabel, ...day });
}

function widgetData(state) {
  const data = JSON.stringify(state);
  return Buffer.byteLength(data) <= 1024 ? data : JSON.stringify({ error: ERROR });
}

let subscription;
let checkedUntil = 0;

export async function subscribeScheduleWidgets(api, secret, signal) {
  const webhook = await api.getWebhookInfo(signal);
  const url = new URL(webhook.url);
  if (url.protocol !== 'https:' || url.pathname !== '/api/webhook' || url.username || url.password) {
    throw new Error('Unexpected Telegram webhook URL');
  }
  const allowed = webhook.allowed_updates;
  if (!allowed?.length || allowed.includes(SCHEDULE_WIDGET_UPDATE)) return;
  if (!secret || webhook.has_custom_certificate) throw new Error('Register widget_query with the webhook setup script');
  await api.setWebhook(webhook.url, {
    allowed_updates: [...allowed, SCHEDULE_WIDGET_UPDATE],
    max_connections: webhook.max_connections,
    secret_token: secret,
  }, signal);
}

function ensureSubscription(api) {
  if (Date.now() < checkedUntil) return Promise.resolve();
  if (!subscription) {
    subscription = subscribeScheduleWidgets(api, process.env.WEBHOOK_SECRET, AbortSignal.timeout(4000))
      .then(() => { checkedUntil = Date.now() + 5 * 60_000; })
      .finally(() => { subscription = null; });
  }
  return subscription;
}

export async function sendScheduleWidget(api, chatId, sub, group, keyboard) {
  const state = await loadScheduleWidget(sub, group, 't');
  try {
    await ensureSubscription(api);
  } catch (error) {
    console.warn('Schedule widget update subscription unavailable:', error.name);
    return null;
  }
  try {
    const payload = {
      chat_id: chatId, html: SCHEDULE_WIDGET_HTML, allow_queries: true,
      protect_content: true, chat_data: widgetData(state),
      caption: 'Расписание СамГАУ · Обычное расписание доступно по кнопкам ниже.',
      reply_markup: keyboard,
    };
    return await api.raw.sendWidget(payload, AbortSignal.timeout(5000));
  } catch (error) {
    if (!(error instanceof GrammyError) || ![400, 403, 404, 405, 501].includes(error.error_code)) throw error;
    const detail = String(error.description || error.message || 'Unknown error').replace(/^Bad Request:\s*/i, '');
    console.warn('Schedule widget rejected by Telegram:', error.error_code, detail);
    throw new Error(`Telegram ${error.error_code}: ${detail}`, { cause: error });
  }
}

export async function handleScheduleWidgetQuery(api, incoming, isAdmin) {
  if (typeof incoming.id !== 'string') return;
  const lookup = typeof incoming.data === 'string' && REQUEST.exec(incoming.data);
  let state = { error: 'Открой новый виджет в личном чате с ботом.' };
  if (lookup && incoming.chat?.type === 'private' && incoming.chat.id === incoming.from?.id && incoming.message_id) {
    const userId = incoming.from.id;
    try {
      if (!await canUseScheduleWidget(userId, isAdmin(userId))) {
        state = { error: 'Виджет доступен только участникам беты.' };
      } else {
        const { rows: [sub] } = await query(
          'SELECT group_id, timezone, subgroup FROM users WHERE platform = $1 AND telegram_id = $2',
          ['telegram', userId],
        );
        const group = sub?.group_id ? await getGroup(sub.group_id) : null;
        state = group ? await loadScheduleWidget(sub, group, lookup[1] || lookup[2], Number(lookup[3] || 0))
          : { error: 'Сначала выбери группу в меню бота.' };
      }
    } catch (error) {
      console.error('Schedule widget lookup failed:', error.name);
      state = { error: ERROR };
    }
  }
  await api.raw.answerWidgetQuery({ widget_query_id: incoming.id, data: widgetData(state) });
}
