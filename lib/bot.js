import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import { query } from './db.js';
import { getGroup, listGroups, renameGroup, deleteGroup, getActiveTerm, getLessonsForDay, groupHasSubgroups } from './schedule.js';
import { formatTeacherDay, escapeHtml, splitMessage, DIVIDER, ddmm } from './format.js';
import {
  isValidTime, nowInTimezone, mondayKeyOf, addDays, isoWeekday, parseUserDate, weekParityForDate,
} from './time.js';
import { buildDateView, buildWeekView, groupLessonDates, upcomingNote } from './digest.js';
import { findTeacherLessonsOn, teacherLessonDates, listDistinctTeachers, teacherKey } from './teacherSearch.js';
import { getText, setText, resetText, EDITABLE_TEXT_LABELS } from './texts.js';
import { fetchSsaaGroups, SSAA_FORMS, pickPeriod } from './ssaa.js';
import { importSsaaGroup, syncGroup } from './ssaaSync.js';
import { ic, stripCustomEmoji, hasCustomEmoji } from './icons.js';
import {
  FEATURES, hasFeature, featureState, setFeatureState,
  addBetaTester, removeBetaTester, listBetaTesters,
  createInvite, getValidInvite, markInviteUsed, inviteStats,
} from './features.js';
import { MaxBot } from './maxBot.js';
import { canUseScheduleWidget, handleScheduleWidgetQuery, sendScheduleWidget } from './scheduleWidget.js';
import { maxSend } from './max.js';
import { AUDIENCE_LABEL, audienceLabel, countAudience, createBroadcast, runBroadcast, getBroadcast } from './broadcast.js';

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
const DEFAULT_MORNING_TIME = '07:00';
const DEFAULT_EVENING_TIME = '20:00';
const TEACHERS_PAGE_SIZE = 16;

// Кто видит /admin и получает обращения в поддержку: ADMIN_TELEGRAM_IDS="123,456".
// Обращения из MAX тоже приходят этим админам в Telegram.
const idList = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
// Владелец бота (@temniy_prinz) — по умолчанию, если переменная не задана.
const OWNER_TELEGRAM_ID = '8181483439';
const BOT_ADMIN_IDS = idList(process.env.ADMIN_TELEGRAM_IDS || OWNER_TELEGRAM_ID);
const isBotAdmin = (id) => BOT_ADMIN_IDS.includes(Number(id));
// Админ-панель в MAX (необязательно): ADMIN_MAX_IDS="123" — user_id в MAX.
const MAX_ADMIN_IDS = idList(process.env.ADMIN_MAX_IDS);

/**
 * Чем мессенджеры отличаются для экранов бота.
 * - replyKeyboard: закреплённые кнопки внизу экрана есть только в Telegram,
 *   в MAX Сегодня / Завтра / Неделя стоят в главном меню.
 */
const PLATFORMS = {
  telegram: { name: 'telegram', label: 'Telegram', replyKeyboard: true, isAdmin: isBotAdmin },
  max: { name: 'max', label: 'MAX', replyKeyboard: false, isAdmin: (id) => MAX_ADMIN_IDS.includes(Number(id)) },
};

/** Удалённый аккаунт Telegram: остаётся в списках без имени или как «Deleted Account». */
const isDeletedAccount = (u) => !u.username && (!(u.first_name || '').trim() || u.first_name === 'Deleted Account');

/** Отправка в Telegram без grammy — для обращений в поддержку из MAX. */
async function telegramSend(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  if (!r.ok) throw new Error(`Telegram sendMessage ${r.status}: ${await r.text()}`);
}

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DAY_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const SUBGROUP_LABEL = { 0: 'обе подгруппы', 1: '1-я подгруппа', 2: '2-я подгруппа' };

const TIMEZONES = [
  ['Самара', 'Europe/Samara'], ['Москва', 'Europe/Moscow'], ['Калининград', 'Europe/Kaliningrad'],
  ['Екатеринбург', 'Asia/Yekaterinburg'], ['Омск', 'Asia/Omsk'], ['Новосибирск', 'Asia/Novosibirsk'],
];
const MORNING_PRESETS = ['05:30', '06:00', '06:30', '07:00', '07:30', '08:00'];
const EVENING_PRESETS = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];

// Три закреплённые кнопки внизу экрана (обычная клавиатура Telegram).
const KB_TODAY = '☀️ Сегодня';
const KB_TOMORROW = '🌙 Завтра';
const KB_WEEK = '🗓 Неделя';
// Подписи из прошлых версий бота — у кого клавиатура осталась старой, тоже работают.
const LEGACY_KB = {
  '📨 Расписание на сегодня': KB_TODAY, '📨 На завтра': KB_TOMORROW, '🗓 Расписание на неделю': KB_WEEK,
  '📅 Сегодня': KB_TODAY, 'Сегодня': KB_TODAY, 'Завтра': KB_TOMORROW, 'Неделя': KB_WEEK,
};
const REPLY_KEYBOARD = {
  keyboard: [[{ text: KB_TODAY }, { text: KB_TOMORROW }, { text: KB_WEEK }]],
  resize_keyboard: true,
  is_persistent: true,
};


// "2026-10-16" <-> "20261016" — даты в callback_data (лимит 64 байта).
// DATE из Postgres приходит как Date — приводим к «YYYY-MM-DD».
const dkey = (v) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
const pack = (dateKey) => dateKey.replaceAll('-', '');
const unpack = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** Бот для Telegram (grammy). */
export function createBot() {
  const bot = new Bot(process.env.BOT_TOKEN);
  bot.use(async (ctx, next) => {
    if (!ctx.update.widget_query) return next();
    await handleScheduleWidgetQuery(bot.api, ctx.update.widget_query, isBotAdmin);
  });
  return setupBot(bot, PLATFORMS.telegram);
}

/** Тот же бот для MAX: те же экраны и та же база, другой транспорт. */
export function createMaxBot() {
  return setupBot(new MaxBot(), PLATFORMS.max);
}

function setupBot(bot, P) {
  /** Тексты из настроек написаны для Telegram — в MAX поправим пару слов. */
  const adapt = (text) => (P.name !== 'max' ? text : text
    .replace(/прямо в Telegram/g, 'прямо в MAX')
    .replace(/в Telegram/g, 'в MAX')
    .replace(/кнопки внизу экрана/g, 'кнопки в главном меню'));

  const featCtx = (ctx) => ({ platform: P.name, userId: ctx.from?.id, isOwner: P.isAdmin(ctx.from?.id) });
  const canUse = (ctx, key) => hasFeature(key, featCtx(ctx));
  /** Ссылка-приглашение в deep-link мессенджера. */
  function inviteLink(ctx, token) {
    if (P.name === 'max') return process.env.MAX_BOT_LINK ? `${process.env.MAX_BOT_LINK}?startapp=${token}` : null;
    const u = ctx.me?.username || ctx.botInfo?.username;
    return u ? `https://t.me/${u}?start=${token}` : null;
  }

  bot.catch((err) => {
    console.error('Bot error on update', err.ctx?.update?.update_id, ':', err.error);
    err.ctx?.reply('Что-то пошло не так. Попробуй ещё раз или нажми /menu.').catch(() => {});
  });

  // ---------- подписчик: личный пользователь (users) или групповой чат (group_chats) ----------

  bot.use(async (ctx, next) => {
    if (!ctx.chat) return next();
    if (ctx.chat.type === 'private') {
      const tgId = ctx.from.id;
      let { rows } = await query('SELECT * FROM users WHERE platform = $1 AND telegram_id = $2', [P.name, tgId]);
      if (!rows[0]) {
        ({ rows } = await query(
          `INSERT INTO users (platform, telegram_id, username, timezone) VALUES ($1, $2, $3, $4)
           ON CONFLICT (platform, telegram_id) DO UPDATE SET username = EXCLUDED.username RETURNING *`,
          [P.name, tgId, ctx.from.username || null, DEFAULT_TZ]
        ));
      } else if ((ctx.from.username || null) !== rows[0].username) {
        await query('UPDATE users SET username = $1 WHERE id = $2', [ctx.from.username || null, rows[0].id]);
      }
      ctx.target = { kind: 'private', table: 'users', row: rows[0] };
    } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      let { rows } = await query('SELECT * FROM group_chats WHERE platform = $1 AND chat_id = $2', [P.name, ctx.chat.id]);
      if (!rows[0]) {
        ({ rows } = await query(
          `INSERT INTO group_chats (platform, chat_id, title, timezone) VALUES ($1, $2, $3, $4)
           ON CONFLICT (platform, chat_id) DO UPDATE SET title = COALESCE(EXCLUDED.title, group_chats.title) RETURNING *`,
          [P.name, ctx.chat.id, ctx.chat.title || null, DEFAULT_TZ]
        ));
      } else if (ctx.chat.title && ctx.chat.title !== rows[0].title) {
        await query('UPDATE group_chats SET title = $1 WHERE id = $2', [ctx.chat.title, rows[0].id]);
      }
      ctx.target = { kind: 'group', table: 'group_chats', row: rows[0] };
    } else {
      return; // каналы не обслуживаем
    }
    ctx.target.row.state = ctx.target.row.state || {};
    await next();
  });

  // Ключи состояния, которые переживают смену шага диалога.
  const STICKY_STATE = ['screenId', 'lastDigestId', 'teacher', 'teacherOptions', 'kbMsgId'];

  async function setState(ctx, state) {
    const t = ctx.target;
    const kept = Object.fromEntries(STICKY_STATE.filter((k) => t.row.state[k] !== undefined).map((k) => [k, t.row.state[k]]));
    const next = { ...kept, ...state };
    await query(`UPDATE ${t.table} SET state = $1 WHERE id = $2`, [JSON.stringify(next), t.row.id]);
    t.row.state = next;
  }

  async function updateRow(ctx, fields) {
    const t = ctx.target;
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await query(`UPDATE ${t.table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...Object.values(fields), t.row.id]);
    t.row = rows[0];
    t.row.state = t.row.state || {};
  }

  /** В личке настраивать можно всегда, в групповом чате — только админам чата. */
  /**
   * В личке настраивать можно всегда. В групповом чате — администратору чата
   * или владельцу бота (ADMIN_TELEGRAM_IDS / ADMIN_MAX_IDS). Если живых
   * администраторов в чате не осталось (создатель удалил аккаунт, в админах
   * только боты) — любому участнику, иначе чат навсегда остался бы без настроек.
   */
  async function canConfigure(ctx) {
    if (ctx.target.kind === 'private') return true;
    if (P.isAdmin(ctx.from.id)) return true;
    try {
      const m = await ctx.getChatMember(ctx.from.id);
      if (m.status === 'creator' || m.status === 'administrator') return true;
    } catch {
      return false;
    }
    try {
      const admins = await ctx.getChatAdministrators();
      return !admins.some((a) => a.user && !a.user.is_bot && !isDeletedAccount(a.user));
    } catch {
      return false;
    }
  }

  async function denied(ctx) {
    if (await canConfigure(ctx)) return false;
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Настраивать бота в этом чате может только администратор чата.', show_alert: true });
    }
    return true;
  }

  // ---------- экран: одно сообщение, которое редактируется на месте ----------

  const isNotModified = (e) => /message is not modified/.test(e?.description || '');

  async function rememberScreen(ctx, messageId) {
    if (ctx.target.row.state.screenId === messageId) return;
    ctx.target.row.state.screenId = messageId;
    await query(
      `UPDATE ${ctx.target.table} SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{screenId}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(messageId), ctx.target.row.id]
    );
  }

  /**
   * Показывает экран. Нажатие кнопки — редактируем то же сообщение (чат не
   * растёт). Команда или текст — присылаем экран вниз чата, а прошлый экран
   * удаляем. fresh: true — всегда новым сообщением (кнопка под рассылкой:
   * саму рассылку не затираем).
   */
  async function render(ctx, text, kb, { fresh = false } = {}) {
    if (text.length > 4000) text = `${splitMessage(text, 3900)[0]}\n\n<i>…сообщение сокращено</i>`;
    // Пустые строки кнопок (после .row() в конце ряда) Telegram может не принять.
    if (kb?.inline_keyboard) kb.inline_keyboard = kb.inline_keyboard.filter((r) => r.length > 0);
    const extra = { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } };

    const send = async (fn) => {
      try {
        return await fn(text);
      } catch (e) {
        if (!hasCustomEmoji(text) || !(e instanceof GrammyError) || isNotModified(e)) throw e;
        console.error('custom emoji rejected, sending plain:', e.description);
        return fn(stripCustomEmoji(text));
      }
    };

    if (ctx.callbackQuery?.message && !fresh) {
      try {
        await send((t) => ctx.editMessageText(t, extra));
        await rememberScreen(ctx, ctx.callbackQuery.message.message_id);
        return;
      } catch (e) {
        if (isNotModified(e)) return;
        // старое сообщение не редактируется — пришлём новое
      }
    }

    const old = ctx.target.row.state.screenId;
    const msg = await send((t) => ctx.reply(t, extra));
    await rememberScreen(ctx, msg.message_id);
    // Прошлый экран удаляем, но не рассылку, из-под которой нажали кнопку.
    const pressedOn = ctx.callbackQuery?.message?.message_id;
    if (old && old !== msg.message_id && !(fresh && old === pressedOn)) {
      ctx.api.deleteMessage(ctx.chat.id, old).catch(() => {});
    }
  }

  /** Убрать сообщение пользователя (команду, дату, фамилию), чтобы не копилось. */
  async function tidy(ctx) {
    if (!ctx.message) return;
    try {
      await ctx.deleteMessage();
    } catch {
      // в группе без прав администратора удалить нельзя — не страшно
    }
  }

  const today = (ctx) => nowInTimezone(ctx.target.row.timezone).dateKey;
  const capitalizeFirst = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);

  async function ack(ctx, text) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
  }

  // ---------- главное меню ----------

  async function todaySummary(ctx) {
    const row = ctx.target.row;
    const d = today(ctx);
    const term = await getActiveTerm(row.group_id, d);
    if (!term) return 'Сегодня по расписанию каникулы';
    const lessons = await getLessonsForDay(term.id, isoWeekday(d), weekParityForDate(d, term.date_start), d, row.subgroup ?? null);
    if (!lessons.length) return 'Сегодня пар нет';
    const slots = [...new Set(lessons.map((l) => l.time_start))].sort();
    const last = lessons.reduce((a, l) => ((l.time_end || '') > a ? l.time_end : a), '');
    const n = slots.length;
    const word = n === 1 ? 'пара' : n < 5 ? 'пары' : 'пар';
    return `Сегодня <b>${n} ${word}</b>, с ${slots[0]} до ${last || slots[n - 1]}`;
  }

  /**
   * Подгруппы есть не у всех групп. Если у группы их нет — выбранную когда-то
   * подгруппу сбрасываем (иначе в расписании висела бы лишняя пометка).
   */
  async function syncSubgroup(ctx) {
    const has = await groupHasSubgroups(ctx.target.row.group_id);
    if (!has && ctx.target.row.subgroup) await updateRow(ctx, { subgroup: null });
    return has;
  }

  async function showMain(ctx, opts) {
    await setState(ctx, {});
    const row = ctx.target.row;
    const group = row.group_id ? await getGroup(row.group_id) : null;

    if (!group) {
      const text = adapt(await getText(ctx.target.kind === 'private' ? 'welcome' : 'group_welcome'));
      const kb = new InlineKeyboard()
        .text('▪️ Выбрать группу', 'ss:start').row()
        .text('❔ Как это работает', 'help').row()
        .text('💬 Поддержка', 'sup').text('🖤 Поддержать', 'don');
      return render(ctx, text, kb, opts);
    }

    const mailing = [
      row.morning_time ? `утром в ${row.morning_time}` : null,
      row.evening_time ? `вечером в ${row.evening_time}` : null,
    ].filter(Boolean).join(' и ');
    const hasSub = await syncSubgroup(ctx);
    const lines = [
      '<b>РАСПИСАНИЕ · САМАРСКИЙ ГАУ</b>',
      '',
      `${ic('group')} <b>${escapeHtml(group.name)}</b>`,
      hasSub ? capitalizeFirst(SUBGROUP_LABEL[row.subgroup || 0]) : null,
      `Рассылка: ${mailing || 'выключена'}`,
      '',
      `<blockquote>${await todaySummary(ctx)}</blockquote>`,
      P.replyKeyboard ? '' : null,
      P.replyKeyboard ? '<i>Сегодня, завтра и неделя — на кнопках внизу экрана</i>' : null,
    ].filter((x) => x !== null);
    const d = today(ctx);
    // Сегодня / Завтра / Неделя — в Telegram на закреплённых кнопках внизу
    // экрана, в MAX таких кнопок нет — ставим их первой строкой меню.
    const kb = new InlineKeyboard();
    if (!P.replyKeyboard) {
      kb.text(KB_TODAY, `d:${pack(d)}`).text(KB_TOMORROW, `d:${pack(addDays(d, 1))}`).text(KB_WEEK, `w:${pack(mondayKeyOf(d))}`).row();
    }
    if (P.name === 'telegram' && ctx.target.kind === 'private' && await canUseScheduleWidget(ctx.from.id, P.isAdmin(ctx.from.id))) {
      kb.text('Открыть виджет расписания', 'schedule:widget').row();
    }
    if (ctx.target.kind === 'private' && await canUse(ctx, 'invite')) kb.text('🤝 Позвать одногруппников', 'inv:new').row();
    kb
      .text('🗓 Календарь', `c:g:${pack(d).slice(0, 6)}`).text('👤 Преподаватели', 't').row()
      .text('⚙️ Настройки', 'set').text('❔ Помощь', 'help').row()
      .text('💬 Поддержка', 'sup').text('🖤 Поддержать', 'don');
    return render(ctx, lines.join('\n'), kb, opts);
  }

  bot.command(['start', 'menu', 'setup'], async (ctx) => {
    await tidy(ctx);
    if (ctx.target.kind === 'private') await installKeyboard(ctx);
    const payload = ctx.match?.trim();
    if (payload && !payload.startsWith('a_') && ctx.target.kind === 'private') {
      if (await redeemInvite(ctx, payload)) return;
    }
    await showMain(ctx);
  });

  /** Подключить пользователя к уже загруженной группе (по приглашению). */
  async function attachExistingGroup(ctx, groupId, invToken) {
    const group = await getGroup(groupId);
    if (!group) return false;
    const r = ctx.target.row;
    const firstSetup = !r.morning_time && !r.evening_time && !r.morning_time_last && !r.evening_time_last;
    const fields = firstSetup
      ? { group_id: group.id, morning_time: DEFAULT_MORNING_TIME, evening_time: DEFAULT_EVENING_TIME }
      : { group_id: group.id };
    if (invToken && !r.invited_by) fields.invited_by = invToken;
    await updateRow(ctx, fields);
    if (ctx.target.kind === 'private' && !ctx.target.row.state.kbMsgId) await installKeyboard(ctx);
    const hasSub = await groupHasSubgroups(group.id);
    const head = [
      '🖤 <b>ГРУППА ПОДКЛЮЧЕНА</b>',
      '',
      `<blockquote><b>${escapeHtml(group.name)}</b>\nРасписание беру с сайта ssaa.ru и обновляю сам</blockquote>`,
      firstSetup ? `Рассылка включена: ☀️ утром в ${DEFAULT_MORNING_TIME} и 🌙 вечером в ${DEFAULT_EVENING_TIME}. Изменить — в настройках.` : null,
    ].filter((x) => x !== null);
    if (!hasSub) {
      if (ctx.target.row.subgroup) await updateRow(ctx, { subgroup: null });
      await render(ctx, head.join('\n'), new InlineKeyboard().text('▪️ Открыть расписание', 'm'));
      return true;
    }
    await render(ctx, [...head, '', '👥 <b>В какой ты подгруппе?</b>', 'Буду показывать только твои пары.'].join('\n'),
      new InlineKeyboard().text('Обе', 'sub:set:0').text('1-я', 'sub:set:1').text('2-я', 'sub:set:2'));
    return true;
  }

  /** Применить приглашение-ссылку. Возвращает true, если показали свой экран. */
  async function redeemInvite(ctx, token) {
    const inv = await getValidInvite(token);
    if (!inv) return false;
    if (inv.kind === 'group' && inv.group_id) {
      const ok = await attachExistingGroup(ctx, inv.group_id, inv.token);
      if (ok) await markInviteUsed(inv.token);
      return ok;
    }
    if (inv.kind === 'beta') {
      await addBetaTester(P.name, ctx.from.id);
      await markInviteUsed(inv.token);
      await render(ctx,
        '🧪 <b>ТЫ ТЕПЕРЬ БЕТА-ТЕСТЕР</b>\n\nБудешь видеть новые функции раньше всех. Если что-то работает не так — пиши в поддержку.',
        new InlineKeyboard().text('▪️ Открыть бота', 'm'));
      return true;
    }
    return false;
  }

  /**
   * Закреплённые кнопки внизу. Telegram показывает их только вместе с
   * сообщением, поэтому держим ровно одно служебное сообщение: при новом
   * /start старое удаляем и присылаем свежее.
   */
  async function installKeyboard(ctx) {
    if (!P.replyKeyboard) return;
    const old = ctx.target.row.state.kbMsgId;
    const m = await ctx.reply('☀️ 🌙 🗓  Кнопки <b>Сегодня · Завтра · Неделя</b> — внизу экрана', {
      parse_mode: 'HTML', reply_markup: REPLY_KEYBOARD,
    }).catch(() => null);
    if (!m) return;
    if (old && old !== m.message_id) ctx.api.deleteMessage(ctx.chat.id, old).catch(() => {});
    ctx.target.row.state.kbMsgId = m.message_id;
    await query(
      `UPDATE ${ctx.target.table} SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{kbMsgId}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(m.message_id), ctx.target.row.id]
    );
  }

  bot.callbackQuery('m', async (ctx) => { await ack(ctx); await showMain(ctx); });
  // Кнопка «Меню» под рассылкой/ответом поддержки: меню новым сообщением, само сообщение не трогаем.
  bot.callbackQuery('m:new', async (ctx) => { await ack(ctx); await showMain(ctx, { fresh: true }); });

  if (P.name === 'telegram') {
    const panelTabs = [
      ['today', 'Сегодня'],
      ['tomorrow', 'Завтра'],
      ['week', 'Неделя'],
    ];

    async function allowSchedulePanel(ctx) {
      if (ctx.chat?.type === 'private' && await canUseScheduleWidget(ctx.from.id, P.isAdmin(ctx.from.id))) {
        await ack(ctx);
        return true;
      }
      if (ctx.callbackQuery) await ack(ctx, 'Виджет доступен в личке участникам беты');
      else await ctx.reply('Виджет доступен в личном чате участникам беты.');
      return false;
    }

    function schedulePanelKeyboard(tab, monday = null, selectedDate = null) {
      const kb = new InlineKeyboard();
      for (const [key, label] of panelTabs) {
        kb.text(key === tab ? `• ${label} •` : label, `schedule:panel:${key}`);
      }
      kb.row();
      if (monday) {
        for (let i = 0; i < 7; i++) {
          const date = addDays(monday, i);
          const label = DAY_SHORT[i + 1];
          kb.text(date === selectedDate ? `• ${label} •` : label, `schedule:panel:${pack(date)}`);
          if (i === 3 || i === 6) kb.row();
        }
      }
      return kb.text('Меню', 'm');
    }

    async function showSchedulePanel(ctx, view) {
      if (await needGroup(ctx)) return;
      await setState(ctx, { step: 'date', dateMode: 'g' });
      const row = ctx.target.row;
      const date = today(ctx);
      if (view === 'week') {
        const monday = mondayKeyOf(date);
        return render(ctx, await buildWeekView(row, monday), schedulePanelKeyboard('week', monday));
      }
      const selected = view === 'today' ? date : view === 'tomorrow' ? addDays(date, 1) : unpack(view);
      const pickedDay = /^\d{8}$/.test(view);
      const kb = pickedDay ? schedulePanelKeyboard('week', mondayKeyOf(selected), selected) : schedulePanelKeyboard(view);
      return render(ctx, await buildDateView(row, selected), kb);
    }

    async function openScheduleWidget(ctx) {
      if (!await allowSchedulePanel(ctx)) return;
      if (process.env.TELEGRAM_NATIVE_WIDGETS !== '1') return showSchedulePanel(ctx, 'today');

      const row = ctx.target.row;
      const group = row.group_id ? await getGroup(row.group_id) : null;
      if (!group) return showMain(ctx);
      await setState(ctx, {});
      let message;
      try {
        message = await sendScheduleWidget(ctx.api, ctx.chat.id, row, group, schedulePanelKeyboard(null));
      } catch (error) {
        console.warn('Schedule widget could not open:', error.name);
      }
      if (!message) return showSchedulePanel(ctx, 'today');
      const old = row.state.screenId;
      await rememberScreen(ctx, message.message_id);
      if (old && old !== message.message_id) await ctx.api.deleteMessage(ctx.chat.id, old).catch(() => {});
    }

    bot.callbackQuery('schedule:widget', openScheduleWidget);
    bot.command('widget', openScheduleWidget);
    bot.callbackQuery(/^schedule:panel:(today|tomorrow|week|\d{8})$/, async (ctx) => {
      if (await allowSchedulePanel(ctx)) await showSchedulePanel(ctx, ctx.match[1]);
    });
  }

  // ---------- день: листание ◀️ ▶️ ----------

  async function needGroup(ctx) {
    if (ctx.target.row.group_id) return false;
    await showMain(ctx);
    return true;
  }

  async function showDay(ctx, dateKey, back = null) {
    if (await needGroup(ctx)) return;
    await setState(ctx, { step: 'date', dateMode: 'g' });
    const text = await buildDateView(ctx.target.row, dateKey);
    const prev = addDays(dateKey, -1);
    const next = addDays(dateKey, 1);
    const kb = new InlineKeyboard()
      .text(`◀️ ${DAY_SHORT[isoWeekday(prev)]} ${ddmm(prev)}`, `d:${pack(prev)}`)
      .text('🗓', `c:g:${pack(dateKey).slice(0, 6)}`)
      .text(`${DAY_SHORT[isoWeekday(next)]} ${ddmm(next)} ▶️`, `d:${pack(next)}`).row();
    if (dateKey !== today(ctx)) kb.text('К сегодня', `d:${pack(today(ctx))}`);
    kb.text('⬅️ Назад', back || 'm');
    await render(ctx, text, kb);
  }

  bot.callbackQuery(/^d:(\d{8})(?::(c|w))?$/, async (ctx) => {
    await ack(ctx);
    const date = unpack(ctx.match[1]);
    const back = ctx.match[2] === 'c' ? `c:g:${ctx.match[1].slice(0, 6)}` : ctx.match[2] === 'w' ? `w:${pack(mondayKeyOf(date))}` : null;
    await showDay(ctx, date, back);
  });
  bot.command('today', async (ctx) => { await tidy(ctx); await showDay(ctx, today(ctx)); });
  bot.command('tomorrow', async (ctx) => { await tidy(ctx); await showDay(ctx, addDays(today(ctx), 1)); });

  // ---------- неделя ----------

  async function showWeek(ctx, mondayKey) {
    if (await needGroup(ctx)) return;
    await setState(ctx, { step: 'date', dateMode: 'g' });
    const text = await buildWeekView(ctx.target.row, mondayKey);
    const prev = addDays(mondayKey, -7);
    const next = addDays(mondayKey, 7);
    const t = today(ctx);
    const kb = new InlineKeyboard();
    for (let i = 0; i < 6; i++) {
      const d = addDays(mondayKey, i);
      kb.text(d === t ? `• ${DAY_SHORT[i + 1]} •` : DAY_SHORT[i + 1], `d:${pack(d)}:w`);
    }
    kb.row()
      .text(`◀️ ${ddmm(prev)}`, `w:${pack(prev)}`)
      .text('🗓', `c:g:${pack(mondayKey).slice(0, 6)}`)
      .text(`${ddmm(next)} ▶️`, `w:${pack(next)}`).row();
    if (mondayKey !== mondayKeyOf(t)) kb.text('К этой неделе', `w:${pack(mondayKeyOf(t))}`);
    kb.text('⬅️ Назад', 'm');
    await render(ctx, text, kb);
  }

  bot.callbackQuery(/^w:(\d{8})$/, async (ctx) => { await ack(ctx); await showWeek(ctx, unpack(ctx.match[1])); });
  bot.command('week', async (ctx) => { await tidy(ctx); await showWeek(ctx, mondayKeyOf(today(ctx))); });

  // ---------- календарь (сетка месяца из кнопок) ----------

  /** mode: 'g' — своя группа, 't' — выбранный преподаватель. ym: "202610". */
  async function showCalendar(ctx, mode, ym) {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(4, 6));
    const yy = ym.slice(0, 4);
    const mm = ym.slice(4, 6);
    const first = `${yy}-${mm}-01`;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${yy}-${mm}-${String(daysInMonth).padStart(2, '0')}`;
    const t = today(ctx);

    const teacher = ctx.target.row.state.teacher;
    if (mode === 't' && !teacher) return showTeacherLetters(ctx);
    if (mode === 'g' && (await needGroup(ctx))) return;
    await setState(ctx, { step: 'date', dateMode: mode });

    let marked = new Set();
    try {
      marked = mode === 't'
        ? await teacherLessonDates(teacher.name, first, last, teacher.exact)
        : await groupLessonDates(ctx.target.row, first, last);
    } catch (e) {
      console.error('calendar marks failed', e);
    }

    const prevYm = m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, '0')}`;
    const nextYm = m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`;
    const dayCb = mode === 't' ? 'td' : 'd';

    const kb = new InlineKeyboard()
      .text('‹', `c:${mode}:${prevYm}`).text(`${MONTHS[m - 1]} ${y}`, 'noop').text('›', `c:${mode}:${nextYm}`).row();
    DAY_SHORT.slice(1).forEach((d) => kb.text(d, 'noop'));
    kb.row();
    const offset = isoWeekday(first) - 1;
    for (let i = 0; i < offset; i++) kb.text(' ', 'noop');
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${yy}-${mm}-${String(day).padStart(2, '0')}`;
      const label = key === t ? `[${day}]` : marked.has(key) ? `${day}•` : String(day);
      kb.text(label, `${dayCb}:${pack(key)}:c`);
      if ((offset + day) % 7 === 0) kb.row();
    }
    const tail = (offset + daysInMonth) % 7;
    if (tail) for (let i = tail; i < 7; i++) kb.text(' ', 'noop');
    kb.row().text('К сегодня', `${dayCb}:${pack(t)}:c`);
    kb.text('⬅️ Назад', mode === 't' ? `td:${pack(t)}` : 'm');

    const who = mode === 't'
      ? escapeHtml(teacher.name)
      : escapeHtml((await getGroup(ctx.target.row.group_id))?.name || '');
    const text = [
      `🗓 <b>КАЛЕНДАРЬ</b>  ·  ${MONTHS[m - 1].toLowerCase()} ${y}`,
      who,
      '',
      'Дни с парами отмечены точкой, сегодня — в скобках.',
      '<i>Дату можно написать в чат, например 20.10</i>',
    ].join('\n');
    await render(ctx, text, kb);
  }

  bot.callbackQuery(/^c:([gt]):(\d{6})$/, async (ctx) => { await ack(ctx); await showCalendar(ctx, ctx.match[1], ctx.match[2]); });
  bot.callbackQuery('noop', (ctx) => ack(ctx));

  bot.command('date', async (ctx) => {
    await tidy(ctx);
    const arg = ctx.match?.trim();
    const d = arg ? parseUserDate(arg, today(ctx)) : null;
    if (d) return showDay(ctx, d);
    return showCalendar(ctx, 'g', pack(today(ctx)).slice(0, 6));
  });

  // ---------- преподаватели: буквы → фамилии → день с листанием и календарём ----------

  async function teacherOptions(ctx, reload) {
    let list = ctx.target.row.state.teacherOptions;
    if (reload || !Array.isArray(list)) {
      list = await listDistinctTeachers();
      await setState(ctx, { ...ctx.target.row.state, teacherOptions: list });
    }
    return list;
  }

  const firstLetter = (name) => name.trim()[0]?.toUpperCase().replace('Ё', 'Е') || '?';

  async function showTeacherLetters(ctx) {
    const list = await teacherOptions(ctx, true);
    await setState(ctx, { step: 'teacher' });
    if (list.length === 0) {
      return render(ctx,
        '<b>Преподаватели</b>\n\nСписок пока пуст — он появится, когда загрузится расписание групп.',
        new InlineKeyboard().text('⬅️ Назад', 'm'));
    }
    const letters = [...new Set(list.map(firstLetter))].sort((a, b) => a.localeCompare(b, 'ru'));
    const kb = new InlineKeyboard();
    letters.forEach((l, i) => {
      kb.text(l, `tl:${l}:0`);
      if (i % 6 === 5) kb.row();
    });
    kb.row().text('⬅️ Назад', 'm');
    const text = [
      '👤 <b>ПРЕПОДАВАТЕЛИ</b>',
      '',
      `Расписание ${list.length} преподавателей по всем группам — на любой день.`,
      '',
      'Выбери первую букву фамилии.',
      '<i>Или напиши фамилию в чат</i>',
    ].join('\n');
    await render(ctx, text, kb);
  }

  async function showTeacherNames(ctx, letter, page, names = null) {
    const list = await teacherOptions(ctx, false);
    await setState(ctx, { step: 'teacher' });
    const filtered = names || list.filter((n) => firstLetter(n) === letter);
    const start = page * TEACHERS_PAGE_SIZE;
    const kb = new InlineKeyboard();
    for (const name of filtered.slice(start, start + TEACHERS_PAGE_SIZE)) kb.text(name, `tp:${list.indexOf(name)}`).row();
    const pages = Math.ceil(filtered.length / TEACHERS_PAGE_SIZE);
    if (pages > 1 && letter) {
      if (page > 0) kb.text('◀️', `tl:${letter}:${page - 1}`);
      kb.text(`${page + 1} / ${pages}`, 'noop');
      if (page < pages - 1) kb.text('▶️', `tl:${letter}:${page + 1}`);
      kb.row();
    }
    kb.text('⬅️ Назад', 't');
    const title = letter ? `на «${letter}»` : 'по запросу';
    await render(ctx, `👤 <b>ПРЕПОДАВАТЕЛИ ${title.toLocaleUpperCase('ru-RU')}</b>\n\nВыбери преподавателя.`, kb);
  }

  async function showTeacherDay(ctx, dateKey, back = null) {
    const teacher = ctx.target.row.state.teacher;
    if (!teacher) return showTeacherLetters(ctx);
    await setState(ctx, { step: 'date', dateMode: 't' });
    const t = today(ctx);
    const { lessons, current } = await findTeacherLessonsOn(teacher.name, dateKey, ctx.target.row.timezone, teacher.exact);
    const rel = { [t]: 'сегодня', [addDays(t, 1)]: 'завтра', [addDays(t, -1)]: 'вчера' }[dateKey] || null;
    const dateLabel = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(new Date(`${dateKey}T12:00:00Z`));
    const text = formatTeacherDay(teacher.name, lessons, { dateLabel, relLabel: rel, current });
    const prev = addDays(dateKey, -1);
    const next = addDays(dateKey, 1);
    const kb = new InlineKeyboard()
      .text(`◀️ ${DAY_SHORT[isoWeekday(prev)]} ${ddmm(prev)}`, `td:${pack(prev)}`)
      .text('🗓', `c:t:${pack(dateKey).slice(0, 6)}`)
      .text(`${DAY_SHORT[isoWeekday(next)]} ${ddmm(next)} ▶️`, `td:${pack(next)}`).row();
    if (dateKey !== t) kb.text('К сегодня', `td:${pack(t)}`);
    kb.text('⬅️ Назад', back || 't');
    await render(ctx, text, kb);
  }

  /** Поиск по фамилии, введённой текстом. */
  async function searchTeacher(ctx, q) {
    const list = await teacherOptions(ctx, true);
    const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
    const found = list.filter((n) => norm(n).includes(norm(q)) || teacherKey(n) === teacherKey(q));
    if (found.length === 1) {
      await setState(ctx, { teacher: { name: found[0], exact: true } });
      return showTeacherDay(ctx, today(ctx));
    }
    if (found.length > 1) return showTeacherNames(ctx, null, 0, found.slice(0, 30));
    await setState(ctx, { step: 'teacher' });
    return render(ctx,
      `<b>Преподаватели</b>\n\nНе нашёл «${escapeHtml(q)}». Проверь фамилию или выбери по первой букве.`,
      new InlineKeyboard().text('⬅️ Назад', 't'));
  }

  bot.callbackQuery('t', async (ctx) => { await ack(ctx); await showTeacherLetters(ctx); });
  bot.callbackQuery(/^tl:(.):(\d+)$/, async (ctx) => { await ack(ctx); await showTeacherNames(ctx, ctx.match[1], Number(ctx.match[2])); });
  bot.callbackQuery(/^tp:(\d+)$/, async (ctx) => {
    await ack(ctx);
    const list = await teacherOptions(ctx, false);
    const name = list[Number(ctx.match[1])];
    if (!name) return showTeacherLetters(ctx);
    await setState(ctx, { teacher: { name, exact: true } });
    await showTeacherDay(ctx, today(ctx));
  });
  bot.callbackQuery(/^td:(\d{8})(?::c)?$/, async (ctx) => {
    await ack(ctx);
    const fromCalendar = ctx.callbackQuery.data.endsWith(':c');
    await showTeacherDay(ctx, unpack(ctx.match[1]), fromCalendar ? `c:t:${ctx.match[1].slice(0, 6)}` : null);
  });

  bot.command('teacher', async (ctx) => {
    await tidy(ctx);
    const q = ctx.match?.trim();
    if (q) return searchTeacher(ctx, q);
    return showTeacherLetters(ctx);
  });

  // ---------- выбор группы с сайта ssaa.ru ----------
  // В callback_data только коды (лимит 64 байта): форма, № факультета, курс, группа.

  const uniq = (arr) => [...new Set(arr)];
  const numOf = (s) => Number((String(s).match(/\d+/) || [0])[0]);
  const facultiesOf = (rows) => uniq(rows.map((g) => g.faculty)).sort((a, b) => a.localeCompare(b, 'ru'));

  async function ssaaRows(form) {
    const all = await fetchSsaaGroups();
    return form ? all.filter((g) => g.form === form) : all;
  }

  async function ssaaUnavailable(ctx, e) {
    console.error('ssaa.ru unavailable:', e);
    await render(ctx,
      `<b>Сайт ssaa.ru не отвечает</b>\n<i>${escapeHtml(e.message || String(e))}</i>\n\nПопробуй через пару минут.`,
      new InlineKeyboard().text('Ещё раз', 'ss:start').text('⬅️ Назад', 'm'));
  }

  const pickerHeader = (step, title) => `▪️ <b>ВЫБОР ГРУППЫ</b>  ·  шаг ${step} из 3\n\n${title}`;

  bot.callbackQuery('ss:start', async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    let all;
    try { all = await ssaaRows(); } catch (e) { return ssaaUnavailable(ctx, e); }
    const present = new Set(all.map((g) => g.form));
    const kb = new InlineKeyboard();
    for (const f of SSAA_FORMS) if (present.has(f.code)) kb.text(f.label, `ss:f:${f.code}`).row();
    kb.text('⬅️ Назад', ctx.target.row.group_id ? 'set' : 'm');
    await render(ctx, pickerHeader(1, 'Форма обучения:'), kb);
  });

  async function showCourses(ctx, form, facIdx) {
    let rows;
    try { rows = await ssaaRows(form); } catch (e) { return ssaaUnavailable(ctx, e); }
    const faculties = facultiesOf(rows);
    const faculty = faculties[facIdx];
    const courses = uniq(rows.filter((g) => g.faculty === faculty).map((g) => numOf(g.course))).sort((a, b) => a - b);
    const kb = new InlineKeyboard();
    courses.forEach((c, i) => { kb.text(`${c} курс`, `ss:k:${form}:${facIdx}:${c}`); if (i % 3 === 2) kb.row(); });
    kb.row().text('⬅️ Назад', faculties.length > 1 ? `ss:f:${form}` : 'ss:start');
    await render(ctx, pickerHeader(2, `<b>${escapeHtml(faculty || '')}</b>\nВыбери курс:`), kb);
  }

  bot.callbackQuery(/^ss:f:(\d+)$/, async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    const form = ctx.match[1];
    let rows;
    try { rows = await ssaaRows(form); } catch (e) { return ssaaUnavailable(ctx, e); }
    const faculties = facultiesOf(rows);
    if (faculties.length === 1) return showCourses(ctx, form, 0); // у колледжа один «факультет»
    const kb = new InlineKeyboard();
    faculties.forEach((f, i) => kb.text(f, `ss:c:${form}:${i}`).row());
    kb.text('⬅️ Назад', 'ss:start');
    await render(ctx, pickerHeader(2, 'Факультет:'), kb);
  });

  bot.callbackQuery(/^ss:c:(\d+):(\d+)$/, async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    await showCourses(ctx, ctx.match[1], Number(ctx.match[2]));
  });

  bot.callbackQuery(/^ss:k:(\d+):(\d+):(\d+)$/, async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    const [form, facIdx, course] = [ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3])];
    let rows;
    try { rows = await ssaaRows(form); } catch (e) { return ssaaUnavailable(ctx, e); }
    const faculty = facultiesOf(rows)[facIdx];
    const groups = uniq(rows.filter((g) => g.faculty === faculty && numOf(g.course) === course).map((g) => numOf(g.group))).sort((a, b) => a - b);
    const kb = new InlineKeyboard();
    groups.forEach((g, i) => { kb.text(`${g} группа`, `ss:g:${form}:${facIdx}:${course}:${g}`); if (i % 3 === 2) kb.row(); });
    kb.row().text('⬅️ Назад', `ss:c:${form}:${facIdx}`);
    await render(ctx, pickerHeader(3, `<b>${escapeHtml(faculty || '')} · ${course} курс</b>\nВыбери группу:`), kb);
  });

  bot.callbackQuery(/^ss:g:(\d+):(\d+):(\d+):(\d+)$/, async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx, 'Загружаю расписание с сайта…');
    const [form, facIdx, course, groupNum] = [ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]), Number(ctx.match[4])];
    let row;
    try {
      const rows = await ssaaRows(form);
      const faculty = facultiesOf(rows)[facIdx];
      row = pickPeriod(rows.filter((g) => g.faculty === faculty && numOf(g.course) === course && numOf(g.group) === groupNum), today(ctx));
    } catch (e) { return ssaaUnavailable(ctx, e); }
    if (!row) {
      return render(ctx, 'Эту группу не нашёл на сайте — возможно, список обновился.', new InlineKeyboard().text('Выбрать заново', 'ss:start'));
    }
    let result;
    try { result = await importSsaaGroup(row, ctx.from.id); } catch (e) { return ssaaUnavailable(ctx, e); }
    const r = ctx.target.row;
    const firstSetup = !r.morning_time && !r.evening_time && !r.morning_time_last && !r.evening_time_last;
    // При первой настройке сразу включаем рассылку — её легко поменять в настройках.
    await updateRow(ctx, firstSetup
      ? { group_id: result.group.id, morning_time: DEFAULT_MORNING_TIME, evening_time: DEFAULT_EVENING_TIME }
      : { group_id: result.group.id });
    if (ctx.target.kind === 'private' && !ctx.target.row.state.kbMsgId) await installKeyboard(ctx);
    const hasSub = await groupHasSubgroups(result.group.id);
    // Пар на сайте пока нет (у заочников так бывает) — говорим, когда начнутся, а не «загружено 0».
    const emptyNote = result.lessons === 0
      ? await upcomingNote(result.group.id, today(ctx), await getActiveTerm(result.group.id, today(ctx)), { dayEmpty: false })
      : null;
    const loaded = result.lessons === 0
      ? `${emptyNote || 'Расписание на сайте пока не опубликовано.'}\n<i>Группа подключена — как только расписание появится, пришлю его сам.</i>`
      : `Загружено ${result.lessons} пар с сайта ssaa.ru, дальше обновляю сам`;
    if (!hasSub) {
      if (ctx.target.row.subgroup) await updateRow(ctx, { subgroup: null });
      return render(ctx, [
        '🖤 <b>ГРУППА ПОДКЛЮЧЕНА</b>',
        '',
        `<blockquote><b>${escapeHtml(result.group.name)}</b>\n${loaded}</blockquote>`,
        firstSetup ? `Рассылка включена: ☀️ утром в ${DEFAULT_MORNING_TIME} и 🌙 вечером в ${DEFAULT_EVENING_TIME}. Изменить — в настройках.` : null,
      ].filter((x) => x !== null).join('\n'), new InlineKeyboard().text('▪️ Открыть расписание', 'm'));
    }
    const kb = new InlineKeyboard().text('Обе', 'sub:set:0').text('1-я', 'sub:set:1').text('2-я', 'sub:set:2');
    await render(ctx, [
      '🖤 <b>ГРУППА ПОДКЛЮЧЕНА</b>',
      '',
      `<blockquote><b>${escapeHtml(result.group.name)}</b>\nЗагружено ${result.lessons} пар с сайта ssaa.ru, дальше обновляю сам</blockquote>`,
      firstSetup ? `Рассылка включена: ☀️ утром в ${DEFAULT_MORNING_TIME} и 🌙 вечером в ${DEFAULT_EVENING_TIME}. Изменить — в настройках.` : null,
      '',
      '👥 <b>В какой ты подгруппе?</b>',
      'Буду показывать только твои пары.',
    ].filter((x) => x !== null).join('\n'), kb);
  });

  // ---------- настройки ----------

  async function showSettings(ctx) {
    await setState(ctx, {});
    const row = ctx.target.row;
    const group = row.group_id ? await getGroup(row.group_id) : null;
    const hasSub = await syncSubgroup(ctx);
    const synced = group?.synced_at
      ? new Date(group.synced_at).toLocaleString('ru-RU', { timeZone: row.timezone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : null;
    const lines = [
      '⚙️ <b>НАСТРОЙКИ</b>',
      '',
      `<blockquote>Группа: <b>${group ? escapeHtml(group.name) : 'не выбрана'}</b>`,
      hasSub ? `Подгруппа: <b>${SUBGROUP_LABEL[ctx.target.row.subgroup || 0]}</b>` : null,
      group?.source_key ? `<i>С сайта ssaa.ru${synced ? `, обновлено ${synced}` : ''}</i></blockquote>` : '</blockquote>',
      group?.sync_error ? `<i>Последнее обновление не удалось: ${escapeHtml(group.sync_error)}</i>` : null,
      '',
      `<blockquote>Утром, пары на сегодня: <b>${row.morning_time || 'выключено'}</b>`,
      `Вечером, пары на завтра: <b>${row.evening_time || 'выключено'}</b>`,
      `Часовой пояс: ${escapeHtml(row.timezone)}</blockquote>`,
    ].filter((x) => x !== null);
    const kb = new InlineKeyboard()
      .text('Сменить группу', 'ss:start');
    if (hasSub) kb.text('Подгруппа', 'sub:ask');
    kb.row()
      .text(`Утро · ${row.morning_time || '—'}`, 'tm:morning').text(row.morning_time ? '● включено' : '○ выключено', 'tt:morning').row()
      .text(`Вечер · ${row.evening_time || '—'}`, 'tm:evening').text(row.evening_time ? '● включено' : '○ выключено', 'tt:evening').row()
      .text('Часовой пояс', 'tz');
    if (group?.source_key) kb.text('Обновить с сайта', 'ss:refresh');
    kb.row().text('⬅️ Назад', 'm');
    await render(ctx, lines.join('\n'), kb);
  }

  bot.callbackQuery('set', async (ctx) => { await ack(ctx); await showSettings(ctx); });
  bot.command('settings', async (ctx) => { await tidy(ctx); await showSettings(ctx); });

  bot.callbackQuery('sub:ask', async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    const cur = ctx.target.row.subgroup || 0;
    const mark = (n, label) => (cur === n ? `• ${label} •` : label);
    const kb = new InlineKeyboard()
      .text(mark(0, 'Обе'), 'sub:set:0').text(mark(1, '1-я'), 'sub:set:1').text(mark(2, '2-я'), 'sub:set:2').row()
      .text('⬅️ Назад', 'set');
    await render(ctx, '👥 <b>ПОДГРУППА</b>\n\nЧьи пары показывать?\n<i>При «Обе» пары подгрупп подписаны отдельно.</i>', kb);
  });

  bot.callbackQuery(/^sub:set:([012])$/, async (ctx) => {
    if (await denied(ctx)) return;
    const value = Number(ctx.match[1]) || null;
    await updateRow(ctx, { subgroup: value });
    await ack(ctx, `Готово: ${SUBGROUP_LABEL[value || 0]}`);
    await showMain(ctx);
  });

  bot.callbackQuery('ss:refresh', async (ctx) => {
    if (await denied(ctx)) return;
    const group = ctx.target.row.group_id ? await getGroup(ctx.target.row.group_id) : null;
    if (!group?.source_key) { await ack(ctx); return showSettings(ctx); }
    try {
      const r = await syncGroup(group);
      await ack(ctx, `Обновлено с сайта: ${r.lessons} пар`);
    } catch (e) {
      await query('UPDATE groups SET sync_error = $1, sync_attempted_at = now() WHERE id = $2', [String(e.message || e).slice(0, 500), group.id]);
      await ack(ctx, 'Не получилось обновить');
    }
    await showSettings(ctx);
  });

  // время рассылок: пресеты кнопками или своё текстом
  bot.callbackQuery(/^tm:(morning|evening)$/, async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    const kind = ctx.match[1];
    await setState(ctx, { step: `time:${kind}` });
    const presets = kind === 'morning' ? MORNING_PRESETS : EVENING_PRESETS;
    const cur = ctx.target.row[`${kind}_time`];
    const kb = new InlineKeyboard();
    presets.forEach((t, i) => { kb.text(cur === t ? `• ${t} •` : t, `ts:${kind}:${t.replace(':', '')}`); if (i % 3 === 2) kb.row(); });
    kb.row().text('Выключить', `ts:${kind}:off`).text('⬅️ Назад', 'set');
    const title = kind === 'morning' ? '☀️ <b>УТРЕННЯЯ РАССЫЛКА</b>\nпары на сегодня' : '🌙 <b>ВЕЧЕРНЯЯ РАССЫЛКА</b>\nпары на завтра';
    await render(ctx, `${title}\n\nВыбери время.\n<i>Или напиши своё, например 07:15</i>`, kb);
  });

  async function setTime(ctx, kind, value) {
    const field = `${kind}_time`;
    await updateRow(ctx, value ? { [field]: value, [`${field}_last`]: value } : { [field]: null });
  }

  bot.callbackQuery(/^ts:(morning|evening):(\d{4}|off)$/, async (ctx) => {
    if (await denied(ctx)) return;
    const [kind, v] = [ctx.match[1], ctx.match[2]];
    const value = v === 'off' ? null : `${v.slice(0, 2)}:${v.slice(2)}`;
    await setTime(ctx, kind, value);
    await ack(ctx, value ? `Буду присылать в ${value}` : 'Рассылка выключена');
    await showSettings(ctx);
  });

  bot.callbackQuery(/^tt:(morning|evening)$/, async (ctx) => {
    if (await denied(ctx)) return;
    const kind = ctx.match[1];
    const field = `${kind}_time`;
    const row = ctx.target.row;
    if (row[field]) await updateRow(ctx, { [field]: null, [`${field}_last`]: row[field] });
    else await updateRow(ctx, { [field]: row[`${field}_last`] || (kind === 'morning' ? DEFAULT_MORNING_TIME : DEFAULT_EVENING_TIME) });
    await ack(ctx, ctx.target.row[field] ? `Включено: ${ctx.target.row[field]}` : 'Выключено');
    await showSettings(ctx);
  });

  bot.callbackQuery('tz', async (ctx) => {
    if (await denied(ctx)) return;
    await ack(ctx);
    await setState(ctx, { step: 'timezone' });
    const kb = new InlineKeyboard();
    TIMEZONES.forEach(([label, tz], i) => { kb.text(ctx.target.row.timezone === tz ? `• ${label} •` : label, `tzs:${i}`); if (i % 2 === 1) kb.row(); });
    kb.row().text('⬅️ Назад', 'set');
    await render(ctx, '🌍 <b>ЧАСОВОЙ ПОЯС</b>\n\nВыбери город.\n<i>Или напиши пояс, например Asia/Yekaterinburg</i>', kb);
  });

  bot.callbackQuery(/^tzs:(\d+)$/, async (ctx) => {
    if (await denied(ctx)) return;
    const tz = TIMEZONES[Number(ctx.match[1])]?.[1];
    if (tz) await updateRow(ctx, { timezone: tz });
    await ack(ctx, tz ? `Часовой пояс: ${tz}` : undefined);
    await showSettings(ctx);
  });

  // ---------- помощь, поддержка, донат ----------

  async function showHelp(ctx) {
    await render(ctx, adapt(await getText('help')), new InlineKeyboard().text('💬 Поддержка', 'sup').text('⬅️ Назад', 'm'));
  }
  bot.callbackQuery('help', async (ctx) => { await ack(ctx); await showHelp(ctx); });
  bot.command('help', async (ctx) => { await tidy(ctx); await showHelp(ctx); });

  async function showSupport(ctx) {
    await setState(ctx, { step: 'support' });
    const kb = new InlineKeyboard().text('🖤 Поддержать', 'don').text('⬅️ Назад', 'm');
    await render(ctx, [
      '💬 <b>ПОДДЕРЖКА</b>',
      '',
      'Нашёл ошибку в расписании, что-то не работает или есть идея?',
      '',
      '<blockquote>Напиши сюда одним сообщением, можно со скриншотом. Передам разработчику, ответ придёт в этот чат.</blockquote>',
    ].join('\n'), kb);
  }

  bot.callbackQuery('sup', async (ctx) => { await ack(ctx); await showSupport(ctx); });
  bot.command('support', async (ctx) => { await tidy(ctx); await showSupport(ctx); });

  async function showDonate(ctx) {
    await render(ctx, await getText('donate'), new InlineKeyboard().text('💬 Поддержка', 'sup').text('⬅️ Назад', 'm'));
  }
  bot.callbackQuery('don', async (ctx) => { await ack(ctx); await showDonate(ctx); });
  bot.command(['donate', 'donat'], async (ctx) => { await tidy(ctx); await showDonate(ctx); });

  /**
   * Метка обращения: по ней ответ админа находит пользователя.
   * Telegram — #id<chat_id>, MAX — #maxu<user_id> (личка) или #maxc<chat_id> (группа).
   */
  const supportTag = (ctx) => {
    if (P.name !== 'max') return `#id${ctx.chat.id}`;
    return ctx.chat.type === 'private' ? `#maxu${ctx.from.id}` : `#maxc${ctx.chat.id}`;
  };

  /** Обращение из MAX → админам в Telegram (там же они и отвечают). */
  async function forwardMaxToSupport(ctx, header, footer) {
    const files = (ctx.message.attachments || [])
      .map((a) => (a.payload?.url ? `<a href="${escapeHtml(a.payload.url)}">${escapeHtml(a.type)}</a>` : escapeHtml(a.type || 'вложение')))
      .join(', ');
    const body = [escapeHtml(ctx.message.text || ''), files ? `📎 ${files}` : ''].filter(Boolean).join('\n');
    let delivered = 0;
    for (const adminId of BOT_ADMIN_IDS) {
      try {
        await telegramSend(adminId, `${header}${body}${footer}`.slice(0, 4000));
        delivered++;
      } catch (e) {
        console.error('support forward (MAX→Telegram) failed to', adminId, e.message || e);
      }
    }
    return delivered > 0;
  }

  /** Обращение пользователя → всем админам. В подписи — метка, по ней админ отвечает реплаем. */
  async function forwardToSupport(ctx) {
    const u = ctx.from;
    const who = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Пользователь';
    const group = ctx.target.row.group_id ? (await getGroup(ctx.target.row.group_id))?.name : null;
    const header = [
      `📩 <b>Обращение${P.name === 'max' ? ' из MAX' : ''}</b> ${supportTag(ctx)}`,
      `👤 ${escapeHtml(who)}${u.username ? ` (@${escapeHtml(u.username)})` : ''}`,
      group ? `👥 ${escapeHtml(group)}` : null,
      '',
    ].filter((x) => x !== null).join('\n');
    const footer = '\n\n<i>↩️ Ответь реплаем на это сообщение — ответ уйдёт пользователю.</i>';
    if (P.name === 'max') return forwardMaxToSupport(ctx, header, footer);
    let delivered = 0;
    for (const adminId of BOT_ADMIN_IDS) {
      try {
        if (ctx.message.text) {
          await ctx.api.sendMessage(adminId, `${header}${escapeHtml(ctx.message.text)}${footer}`, { parse_mode: 'HTML' });
        } else {
          await ctx.api.copyMessage(adminId, ctx.chat.id, ctx.message.message_id, {
            caption: `${header}${escapeHtml(ctx.message.caption || '')}${footer}`.slice(0, 1024),
            parse_mode: 'HTML',
          });
        }
        delivered++;
      } catch (e) {
        console.error('support forward failed to', adminId, e.description || e);
      }
    }
    return delivered > 0;
  }

  /** Админ ответил реплаем на обращение — пересылаем ответ пользователю. */
  async function relayAdminReply(ctx) {
    const replied = ctx.message?.reply_to_message;
    if (P.name !== 'telegram' || !replied || ctx.chat.type !== 'private' || !isBotAdmin(ctx.from.id)) return false;
    const answerKb = new InlineKeyboard().text('Ответить', 'sup');
    const maxTag = (replied.text || replied.caption || '').match(/#max([uc])(-?\d+)/);
    if (maxTag) {
      if (!ctx.message.text) {
        await ctx.reply('⚠️ В MAX можно ответить только текстом.');
        return true;
      }
      const to = maxTag[1] === 'u' ? { userId: Number(maxTag[2]) } : { chatId: Number(maxTag[2]) };
      try {
        await maxSend(to, `<b>Ответ поддержки</b>\n\n<blockquote>${escapeHtml(ctx.message.text)}</blockquote>`, answerKb);
        await ctx.reply('✅ Ответ отправлен в MAX', { reply_parameters: { message_id: ctx.message.message_id } });
      } catch (e) {
        await ctx.reply(`⚠️ Не доставлено в MAX: ${e.description || e.message}`);
      }
      return true;
    }
    const tag = (replied.text || replied.caption || '').match(/#id(-?\d+)/);
    if (!tag) return false;
    const chatId = Number(tag[1]);
    try {
      if (ctx.message.text) {
        await ctx.api.sendMessage(chatId, `<b>Ответ поддержки</b>\n\n<blockquote>${escapeHtml(ctx.message.text)}</blockquote>`, { parse_mode: 'HTML', reply_markup: answerKb });
      } else {
        await ctx.api.copyMessage(chatId, ctx.chat.id, ctx.message.message_id, { reply_markup: answerKb });
      }
      await ctx.reply('✅ Ответ отправлен', { reply_parameters: { message_id: ctx.message.message_id } });
    } catch (e) {
      await ctx.reply(`⚠️ Не доставлено: ${e.description || e.message}`);
    }
    return true;
  }

  // ---------- админ-панель (личка, ADMIN_TELEGRAM_IDS) ----------

  const adminOnly = (ctx) => ctx.chat?.type === 'private' && P.isAdmin(ctx.from.id);

  async function showAdmin(ctx) {
    await dropSample(ctx);
    await setState(ctx, {});
    const { rows: [s] } = await query(
      `SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM users WHERE group_id IS NOT NULL) ug,
              (SELECT count(*) FROM users WHERE platform = 'max') um,
              (SELECT count(*) FROM group_chats WHERE group_id IS NOT NULL) gc,
              (SELECT count(*) FROM groups WHERE source_key IS NOT NULL) gs, (SELECT count(*) FROM lessons) l`
    );
    const inv = await inviteStats();
    const kb = new InlineKeyboard();
    kb.text('⚙️ Функции', 'a:ff').text('🧪 Тестеры', 'a:bt').row();
    kb.text('📣 Рассылка', 'a:bc').row();
    for (const [key, label] of Object.entries(EDITABLE_TEXT_LABELS)) kb.text(`✏️ ${label}`, `a:e:${key}`).row();
    kb.text('📚 Группы', 'a:g').row().text('⬅️ Назад', 'm');
    await render(ctx, [
      '🛠 <b>Админ-панель</b>',
      DIVIDER,
      `👤 Пользователей: ${s.u} (с группой: ${s.ug}; в MAX: ${s.um})`,
      `💬 Групповых чатов: ${s.gc}`,
      `🌐 Групп с сайта: ${s.gs} · пар в базе: ${s.l}`,
      (inv.group || inv.beta) ? `🤝 Пришли по приглашениям: ${inv.group || 0}` : null,
      '',
      'Ответы на обращения — реплаем на сообщение «📩 Обращение».',
    ].filter((x) => x !== null).join('\n'), kb);
  }

  async function showAdminGroups(ctx) {
    const groups = await listGroups();
    const kb = new InlineKeyboard();
    for (const g of groups) kb.text(`${g.source_key ? '🌐' : '✍️'} ${g.name}`, `a:g:${g.id}`).row();
    kb.text('⬅️ Назад', 'a');
    await render(ctx, `📚 <b>Группы в боте</b>\n${DIVIDER}\n🌐 — с сайта, ✍️ — старые ручные`, kb);
  }

  bot.command('admin', async (ctx) => { if (!adminOnly(ctx)) return; await tidy(ctx); await showAdmin(ctx); });
  bot.callbackQuery('a', async (ctx) => { await ack(ctx); if (adminOnly(ctx)) await showAdmin(ctx); });
  bot.callbackQuery('a:g', async (ctx) => { await ack(ctx); if (adminOnly(ctx)) await showAdminGroups(ctx); });

  bot.callbackQuery(/^a:e:(\w+)$/, async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx)) return;
    const key = ctx.match[1];
    await setState(ctx, { step: 'admin:text', textKey: key });
    await render(ctx,
      `✏️ <b>${escapeHtml(EDITABLE_TEXT_LABELS[key] || key)}</b>\n${DIVIDER}\n\n<pre>${escapeHtml(await getText(key))}</pre>\n\nПришли новый текст (можно HTML-разметку Telegram).`,
      new InlineKeyboard().text('↩️ Сбросить', `a:r:${key}`).text('❌ Отмена', 'a'));
  });

  bot.callbackQuery(/^a:r:(\w+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    await resetText(ctx.match[1]);
    await ack(ctx, 'Сброшено на значение по умолчанию');
    await showAdmin(ctx);
  });

  bot.callbackQuery(/^a:g:(\d+)$/, async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx)) return;
    const g = await getGroup(Number(ctx.match[1]));
    if (!g) return showAdminGroups(ctx);
    const { rows: [c] } = await query(
      'SELECT (SELECT count(*) FROM users WHERE group_id = $1) + (SELECT count(*) FROM group_chats WHERE group_id = $1) AS subs', [g.id]);
    await render(ctx,
      `<b>${escapeHtml(g.name)}</b>\n${DIVIDER}\nПодписчиков: ${c.subs}\n${g.source_key ? `Источник: ${escapeHtml(g.source_key)}` : 'Заполнена вручную'}`,
      new InlineKeyboard().text('✏️ Переименовать', `a:gr:${g.id}`).text('🗑 Удалить', `a:gd:${g.id}`).row().text('⬅️ Назад', 'a:g'));
  });

  bot.callbackQuery(/^a:gr:(\d+)$/, async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx)) return;
    await setState(ctx, { step: 'admin:rename', groupId: Number(ctx.match[1]) });
    await render(ctx, 'Напиши новое название группы:', new InlineKeyboard().text('❌ Отмена', 'a:g'));
  });

  bot.callbackQuery(/^a:gd:(\d+)$/, async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx)) return;
    const g = await getGroup(Number(ctx.match[1]));
    if (!g) return showAdminGroups(ctx);
    await render(ctx, `Точно удалить <b>${escapeHtml(g.name)}</b> и её расписание? У подписчиков группа снимется.`,
      new InlineKeyboard().text('✅ Да, удалить', `a:gdc:${g.id}`).text('❌ Отмена', `a:g:${g.id}`));
  });

  bot.callbackQuery(/^a:gdc:(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    await deleteGroup(Number(ctx.match[1]));
    await ack(ctx, 'Группа удалена');
    await showAdminGroups(ctx);
  });

  // ---------- админ: переключатели функций (off / beta / all) ----------

  const STATE_LABEL = { off: '⚪️ выключена', beta: '🧪 бета (я и тестеры)', all: '🟢 для всех' };
  const NEXT_STATE = { off: 'beta', beta: 'all', all: 'off' };

  async function showFeatures(ctx) {
    await setState(ctx, {});
    const kb = new InlineKeyboard();
    for (const [key, label] of Object.entries(FEATURES)) {
      const st = await featureState(key);
      kb.text(`${label}: ${STATE_LABEL[st]}`, `a:ff:${key}`).row();
    }
    kb.text('⬅️ Назад', 'a');
    await render(ctx, [
      '⚙️ <b>ФУНКЦИИ</b>',
      DIVIDER,
      'Нажми, чтобы переключить: выключена → бета → для всех.',
      '<i>«Бета» видят только ты и бета-тестеры.</i>',
    ].join('\n'), kb);
  }

  bot.callbackQuery('a:ff', async (ctx) => { await ack(ctx); if (adminOnly(ctx)) await showFeatures(ctx); });
  bot.callbackQuery(/^a:ff:(\w+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    const key = ctx.match[1];
    if (!FEATURES[key]) return ack(ctx);
    const next = NEXT_STATE[await featureState(key)];
    await setFeatureState(key, next);
    await ack(ctx, `${FEATURES[key]}: ${STATE_LABEL[next]}`);
    await showFeatures(ctx);
  });


  // ---------- админ: рассылка от владельца ----------

  /** Убрать образец-фото, оставшийся от предпросмотра рассылки. */
  async function dropSample(ctx) {
    const mid = ctx.target.row.state.sampleMid;
    if (mid) await ctx.api.deleteMessage(ctx.chat.id, mid).catch(() => {});
  }

  async function showBroadcastAudience(ctx) {
    await dropSample(ctx);
    await setState(ctx, {});
    const kb = new InlineKeyboard();
    for (const [type, label] of Object.entries(AUDIENCE_LABEL)) kb.text(label, `a:bc:t:${type}`).row();
    kb.text('📚 Одна группа…', 'a:bc:gl').row().text('⬅️ Назад', 'a');
    await render(ctx, ['📣 <b>РАССЫЛКА</b>', DIVIDER, 'Кому отправить сообщение?',
      '<i>Только личные чаты людей. Кто заблокировал бота — пропускаются.</i>'].join('\n'), kb);
  }

  async function askBroadcastText(ctx, aud) {
    await dropSample(ctx);
    await setState(ctx, { step: 'admin:bc', aud });
    const n = await countAudience(aud);
    await render(ctx, [`📣 <b>РАССЫЛКА</b> · ${escapeHtml(await audienceLabel(aud))}`, DIVIDER,
      `Получателей: <b>${n}</b>`, '', 'Пришли текст сообщения (можно HTML-разметку Telegram) или фото с подписью. Перед отправкой покажу, как оно выглядит.'].join('\n'),
      new InlineKeyboard().text('❌ Отмена', 'a:bc'));
  }

  async function showBroadcastProgress(ctx, b) {
    const left = Math.max(b.total - b.sent - b.failed, 0);
    const kb = new InlineKeyboard();
    if (!b.done) kb.text('▶️ Продолжить', `a:bc:more:${b.id}`).row();
    kb.text('⬅️ В админку', 'a');
    await render(ctx, [b.done ? '✅ <b>РАССЫЛКА ЗАВЕРШЕНА</b>' : '⏳ <b>РАССЫЛКА ИДЁТ</b>', DIVIDER,
      `Получателей: ${b.total}`, `Доставлено: ${b.sent}`, `Не доставлено: ${b.failed}`,
      b.done ? null : `Осталось примерно: ${left}`,
      b.failed ? '<i>Недоставленные — обычно те, кто заблокировал бота; их больше не трогаю.</i>' : null,
    ].filter((x) => x !== null).join('\n'), kb);
  }

  bot.callbackQuery('a:bc', async (ctx) => { await ack(ctx); if (adminOnly(ctx)) await showBroadcastAudience(ctx); });
  bot.callbackQuery(/^a:bc:t:(\w+)$/, async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx) || !AUDIENCE_LABEL[ctx.match[1]]) return;
    await askBroadcastText(ctx, { type: ctx.match[1] });
  });
  bot.callbackQuery('a:bc:gl', async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx)) return;
    const kb = new InlineKeyboard();
    for (const g of await listGroups()) kb.text(g.name, `a:bc:g:${g.id}`).row();
    kb.text('⬅️ Назад', 'a:bc');
    await render(ctx, '📚 <b>Какой группе?</b>', kb);
  });
  bot.callbackQuery(/^a:bc:g:(\d+)$/, async (ctx) => {
    await ack(ctx);
    if (!adminOnly(ctx)) return;
    await askBroadcastText(ctx, { type: 'group', groupId: Number(ctx.match[1]) });
  });
  bot.callbackQuery('a:bc:go', async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    const st = ctx.target.row.state;
    if (st.step !== 'admin:bcp' || !(st.text || st.photo)) return ack(ctx, 'Рассылка уже отправлена или отменена');
    // В состоянии мог остаться предпросмотр автоматически созданного анонса анонимок.
    if (/^🧪 <b>Тест анонимок до |^🎭 <b>Анонимки открыты до /u.test(st.text || '')) {
      await setState(ctx, {});
      return ack(ctx, 'Анонс больше недоступен');
    }
    await ack(ctx, 'Отправляю…');
    const b0 = await createBroadcast(st.aud, st.text, ctx.from.id, st.photo || null);
    await dropSample(ctx);
    await setState(ctx, {}); // повторное нажатие не создаст вторую рассылку
    await showBroadcastProgress(ctx, await runBroadcast(b0.id));
  });
  bot.callbackQuery(/^a:bc:more:(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    await ack(ctx, 'Продолжаю…');
    const b = await getBroadcast(Number(ctx.match[1]));
    if (b) await showBroadcastProgress(ctx, await runBroadcast(b.id));
  });

  // ---------- админ: бета-тестеры ----------

  async function showTesters(ctx) {
    await setState(ctx, {});
    const testers = await listBetaTesters();
    const kb = new InlineKeyboard().text('➕ Пригласить тестера (ссылка)', 'a:bt:new').row();
    for (const t of testers) kb.text(`❌ ${t.platform} ${t.user_id}`, `a:bt:rm:${t.platform}:${t.user_id}`).row();
    kb.text('⬅️ Назад', 'a');
    await render(ctx, [
      '🧪 <b>БЕТА-ТЕСТЕРЫ</b>',
      DIVIDER,
      testers.length ? `Сейчас тестеров: ${testers.length}. Нажми на тестера, чтобы убрать.` : 'Пока тестеров нет.',
      '',
      'Пригласить: пришли человеку ссылку, он откроет — и станет тестером.',
    ].join('\n'), kb);
  }

  bot.callbackQuery('a:bt', async (ctx) => { await ack(ctx); if (adminOnly(ctx)) await showTesters(ctx); });
  bot.callbackQuery('a:bt:new', async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    await ack(ctx);
    const token = await createInvite({ kind: 'beta', createdBy: ctx.from.id, maxUses: 20 });
    const link = inviteLink(ctx, token);
    await render(ctx, [
      '🧪 <b>ССЫЛКА ДЛЯ ТЕСТЕРА</b>',
      DIVIDER,
      link ? `Перешли её тому, кого хочешь сделать тестером (до 20 переходов):\n\n${escapeHtml(link)}`
           : `Ссылку собрать не удалось. Токен для входа: <code>${token}</code>`,
    ].join('\n'), new InlineKeyboard().text('⬅️ Назад', 'a:bt'));
  });
  bot.callbackQuery(/^a:bt:rm:(\w+):(-?\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return ack(ctx);
    await removeBetaTester(ctx.match[1], Number(ctx.match[2]));
    await ack(ctx, 'Тестер убран');
    await showTesters(ctx);
  });



  // ---------- «Позвать одногруппников»: ссылка сразу в свою группу ----------

  bot.callbackQuery('inv:new', async (ctx) => {
    await ack(ctx);
    if (!(await canUse(ctx, 'invite'))) return showMain(ctx);
    const group = ctx.target.row.group_id ? await getGroup(ctx.target.row.group_id) : null;
    if (!group) return showMain(ctx);
    const token = await createInvite({ kind: 'group', groupId: group.id, createdBy: ctx.from.id });
    const link = inviteLink(ctx, token);
    const share = link
      ? `📅 Расписание группы «${group.name}» в боте: ${link}\nЗаходишь — и группа уже выбрана, пары приходят сами утром и вечером.`
      : null;
    await render(ctx, [
      '🤝 <b>ПОЗВАТЬ ОДНОГРУППНИКОВ</b>',
      DIVIDER,
      share ? 'Перешли это сообщение в чат группы. По ссылке бот сразу подключит человека к вашей группе — выбирать курс и группу не нужно.'
            : 'Ссылку собрать не удалось, попробуй позже.',
      share ? `\n<blockquote>${escapeHtml(share)}</blockquote>` : '',
    ].filter(Boolean).join('\n'), new InlineKeyboard().text('⬅️ Назад', 'm'));
  });


  // Подтверждаем нажатия под старыми сообщениями, чтобы Telegram не показывал ожидание.
  bot.callbackQuery(/^(?:an:|a:an(?::|$))/, (ctx) => ack(ctx, 'Анонимки больше недоступны'));

  // ---------- сообщения: поддержка, ответ админа, ввод даты / фамилии / времени ----------

  bot.on('message', async (ctx) => {
    if (await relayAdminReply(ctx)) return;

    const state = ctx.target.row.state || {};
    const text = ctx.message.text?.trim();

    if (state.step === 'anon:write') return showMain(ctx);

    // Закреплённые кнопки внизу (в личке и в группе — работают для всех).
    const kbButton = LEGACY_KB[text] || text;
    if ([KB_TODAY, KB_TOMORROW, KB_WEEK].includes(kbButton)) {
      await tidy(ctx);
      if (LEGACY_KB[text] && ctx.target.kind === 'private') await installKeyboard(ctx); // обновим старую клавиатуру
      if (kbButton === KB_TODAY) return showDay(ctx, today(ctx));
      if (kbButton === KB_TOMORROW) return showDay(ctx, addDays(today(ctx), 1));
      return showWeek(ctx, mondayKeyOf(today(ctx)));
    }

    // Нижних кнопок ещё нет (новый пользователь или старая версия) — поставим.
    if (ctx.target.kind === 'private' && !state.kbMsgId && state.step !== 'support') await installKeyboard(ctx);

    // В групповом чате обычную переписку не трогаем — только активный шаг настройки от админа.
    if (ctx.target.kind === 'group') {
      if (!['time:morning', 'time:evening', 'timezone'].includes(state.step)) return;
      if (!(await canConfigure(ctx))) return;
    }

    if (state.step === 'support') {
      const ok = await forwardToSupport(ctx);
      await tidy(ctx);
      await setState(ctx, {});
      const quote = text ? `\n\n<blockquote>${escapeHtml(text.length > 300 ? `${text.slice(0, 300)}…` : text)}</blockquote>` : '';
      return render(ctx,
        ok
          ? `<b>Сообщение отправлено</b>${quote}\n\nОтвет придёт в этот чат. Спасибо!`
          : 'Не получилось отправить сообщение. Попробуй ещё раз чуть позже.',
        new InlineKeyboard().text('⬅️ Назад', 'm'));
    }

    // Рассылка с фото: владелец присылает картинку, подпись — текст рассылки.
    if (state.step === 'admin:bc' && adminOnly(ctx) && ctx.message.photo?.length) {
      const caption = (ctx.message.caption || '').trim();
      if (caption.length > 1000) {
        await tidy(ctx);
        return render(ctx, `Подпись к фото слишком длинная (до 1000 символов, сейчас ${caption.length}). Сократи и пришли фото ещё раз.`, new InlineKeyboard().text('❌ Отмена', 'a:bc'));
      }
      const photo = ctx.message.photo.at(-1).file_id;
      const n = await countAudience(state.aud);
      await tidy(ctx);
      // Образец ровно как увидят получатели, а под ним — экран с кнопками.
      const sample = await ctx.api.sendPhoto(ctx.chat.id, photo, caption ? { caption, parse_mode: 'HTML' } : {});
      await setState(ctx, { step: 'admin:bcp', aud: state.aud, text: caption, photo, sampleMid: sample.message_id });
      return render(ctx, ['📣 <b>ПРОВЕРЬ ПЕРЕД ОТПРАВКОЙ</b>', DIVIDER,
        `Кому: ${escapeHtml(await audienceLabel(state.aud))} — <b>${n}</b> чел.`, '', 'Фото выше уйдёт именно так. В MAX фото тоже отправляется.'].join('\n'),
        new InlineKeyboard().text(`✅ Отправить (${n})`, 'a:bc:go').row().text('✏️ Заменить', state.aud.type === 'group' ? `a:bc:g:${state.aud.groupId}` : `a:bc:t:${state.aud.type}`).text('❌ Отмена', 'a:bc'),
        { fresh: true });
    }

    if (!text) {
      if (ctx.target.kind === 'private') await tidy(ctx);
      return;
    }

    if (state.step === 'admin:text' && adminOnly(ctx)) {
      await setText(state.textKey, ctx.message.text);
      await tidy(ctx);
      return showAdmin(ctx);
    }
    if (state.step === 'admin:bc' && adminOnly(ctx)) {
      await tidy(ctx);
      const body = ctx.message.text.trim();
      if (body.length > 3900) return render(ctx, 'Слишком длинно (максимум ~3900 символов). Сократи и пришли ещё раз.', new InlineKeyboard().text('❌ Отмена', 'a:bc'));
      await setState(ctx, { step: 'admin:bcp', aud: state.aud, text: body });
      const n = await countAudience(state.aud);
      return render(ctx, [`📣 <b>ПРОВЕРЬ ПЕРЕД ОТПРАВКОЙ</b>`, DIVIDER,
        `Кому: ${escapeHtml(await audienceLabel(state.aud))} — <b>${n}</b> чел.`, '', 'Так увидят получатели:', '', body].join('\n'),
        new InlineKeyboard().text(`✅ Отправить (${n})`, 'a:bc:go').row().text('✏️ Изменить текст', state.aud.type === 'group' ? `a:bc:g:${state.aud.groupId}` : `a:bc:t:${state.aud.type}`).text('❌ Отмена', 'a:bc'));
    }
    if (state.step === 'admin:rename' && adminOnly(ctx)) {
      await renameGroup(state.groupId, text);
      await tidy(ctx);
      return showAdmin(ctx);
    }

    if (state.step === 'time:morning' || state.step === 'time:evening') {
      await tidy(ctx);
      const kind = state.step.split(':')[1];
      const t = text.replace(/[.\-\s]/, ':').replace(/^(\d):/, '0$1:');
      if (/^выкл/i.test(text)) await setTime(ctx, kind, null);
      else if (isValidTime(t)) await setTime(ctx, kind, t);
      else return render(ctx, 'Не понял время. Напиши так: <b>07:30</b>', new InlineKeyboard().text('⬅️ Назад', 'set'));
      return showSettings(ctx);
    }

    if (state.step === 'timezone') {
      await tidy(ctx);
      try {
        Intl.DateTimeFormat('en-US', { timeZone: text }).format(new Date());
        await updateRow(ctx, { timezone: text });
        return showSettings(ctx);
      } catch {
        return render(ctx, 'Не знаю такой часовой пояс. Пример: <b>Europe/Samara</b>', new InlineKeyboard().text('⬅️ Назад', 'set'));
      }
    }

    if (ctx.target.kind !== 'private') return;
    await tidy(ctx);

    // Дата — пары группы или выбранного преподавателя (если открыт его экран).
    const date = parseUserDate(text, today(ctx));
    if (date) {
      if (state.dateMode === 't' && ctx.target.row.state.teacher) return showTeacherDay(ctx, date);
      return showDay(ctx, date);
    }
    if (/^сегодня$/i.test(text)) return showDay(ctx, today(ctx));
    if (/^завтра$/i.test(text)) return showDay(ctx, addDays(today(ctx), 1));

    // Иначе — ищем преподавателя по фамилии.
    if (text.length >= 3 && /^[А-ЯЁа-яё][А-ЯЁа-яё.\s-]+$/.test(text)) return searchTeacher(ctx, text);
    return showMain(ctx);
  });

  return bot;
}
