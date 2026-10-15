import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import { query } from './db.js';
import { getGroup, listGroups, renameGroup, deleteGroup, getActiveTerm, getLessonsForDay, groupHasSubgroups } from './schedule.js';
import { formatTeacherDay, escapeHtml, splitMessage, DIVIDER, ddmm } from './format.js';
import {
  isValidTime, nowInTimezone, mondayKeyOf, addDays, isoWeekday, parseUserDate, weekParityForDate,
} from './time.js';
import { buildDateView, buildWeekView, groupLessonDates } from './digest.js';
import { findTeacherLessonsOn, teacherLessonDates, listDistinctTeachers, teacherKey } from './teacherSearch.js';
import { getText, setText, resetText, EDITABLE_TEXT_LABELS } from './texts.js';
import { fetchSsaaGroups, SSAA_FORMS, pickPeriod } from './ssaa.js';
import { importSsaaGroup, syncGroup } from './ssaaSync.js';

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
const DEFAULT_MORNING_TIME = '07:00';
const DEFAULT_EVENING_TIME = '20:00';
const TEACHERS_PAGE_SIZE = 16;

// Кто видит /admin и получает обращения в поддержку: ADMIN_TELEGRAM_IDS="123,456".
const BOT_ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const isBotAdmin = (id) => BOT_ADMIN_IDS.includes(Number(id));

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
const KB_TODAY = 'Сегодня';
const KB_TOMORROW = 'Завтра';
const KB_WEEK = 'Неделя';
// Подписи из прошлых версий бота — у кого клавиатура осталась старой, тоже работают.
const LEGACY_KB = {
  '📨 Расписание на сегодня': KB_TODAY, '📨 На завтра': KB_TOMORROW, '🗓 Расписание на неделю': KB_WEEK,
  '📅 Сегодня': KB_TODAY, '🌙 Завтра': KB_TOMORROW, '🗓 Неделя': KB_WEEK,
};
const REPLY_KEYBOARD = {
  keyboard: [[{ text: KB_TODAY }, { text: KB_TOMORROW }, { text: KB_WEEK }]],
  resize_keyboard: true,
  is_persistent: true,
};

const SUPPORT_CONTACT = 'https://t.me/temniy_prinz';
const SUPPORT_NICK = '@temniy_prinz';

// "2026-10-16" <-> "20261016" — даты в callback_data (лимит 64 байта).
const pack = (dateKey) => dateKey.replaceAll('-', '');
const unpack = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export function createBot() {
  const bot = new Bot(process.env.BOT_TOKEN);

  bot.catch((err) => {
    console.error('Bot error on update', err.ctx?.update?.update_id, ':', err.error);
    err.ctx?.reply('Что-то пошло не так. Попробуй ещё раз или нажми /menu.').catch(() => {});
  });

  // ---------- подписчик: личный пользователь (users) или групповой чат (group_chats) ----------

  bot.use(async (ctx, next) => {
    if (!ctx.chat) return next();
    if (ctx.chat.type === 'private') {
      const tgId = ctx.from.id;
      let { rows } = await query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      if (!rows[0]) {
        ({ rows } = await query(
          'INSERT INTO users (telegram_id, username, timezone) VALUES ($1, $2, $3) RETURNING *',
          [tgId, ctx.from.username || null, DEFAULT_TZ]
        ));
      } else if ((ctx.from.username || null) !== rows[0].username) {
        await query('UPDATE users SET username = $1 WHERE id = $2', [ctx.from.username || null, rows[0].id]);
      }
      ctx.target = { kind: 'private', table: 'users', row: rows[0] };
    } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      let { rows } = await query('SELECT * FROM group_chats WHERE chat_id = $1', [ctx.chat.id]);
      if (!rows[0]) {
        ({ rows } = await query(
          'INSERT INTO group_chats (chat_id, title, timezone) VALUES ($1, $2, $3) RETURNING *',
          [ctx.chat.id, ctx.chat.title || null, DEFAULT_TZ]
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
  async function canConfigure(ctx) {
    if (ctx.target.kind === 'private') return true;
    try {
      const m = await ctx.getChatMember(ctx.from.id);
      return m.status === 'creator' || m.status === 'administrator';
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

  const isNotModified = (e) => e instanceof GrammyError && /message is not modified/.test(e.description || '');

  async function rememberScreen(ctx, messageId) {
    if (ctx.target.row.state.screenId === messageId) return;
    ctx.target.row.state.screenId = messageId;
    await query(
      `UPDATE ${ctx.target.table} SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{screenId}', to_jsonb($1::bigint)) WHERE id = $2`,
      [messageId, ctx.target.row.id]
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

    if (ctx.callbackQuery?.message && !fresh) {
      try {
        await ctx.editMessageText(text, extra);
        await rememberScreen(ctx, ctx.callbackQuery.message.message_id);
        return;
      } catch (e) {
        if (isNotModified(e)) return;
        // старое сообщение не редактируется — пришлём новое
      }
    }

    const old = ctx.target.row.state.screenId;
    const msg = await ctx.reply(text, extra);
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
      const text = await getText(ctx.target.kind === 'private' ? 'welcome' : 'group_welcome');
      const kb = new InlineKeyboard()
        .text('Выбрать группу', 'ss:start').row()
        .text('Как это работает', 'help').row()
        .text('Поддержка', 'sup').text('Поддержать проект', 'don');
      return render(ctx, text, kb, opts);
    }

    const mailing = [
      row.morning_time ? `утром в ${row.morning_time}` : null,
      row.evening_time ? `вечером в ${row.evening_time}` : null,
    ].filter(Boolean).join(' и ');
    const hasSub = await syncSubgroup(ctx);
    const lines = [
      '<b>Расписание · Самарский ГАУ</b>',
      '',
      `<b>${escapeHtml(group.name)}</b>`,
      hasSub ? capitalizeFirst(SUBGROUP_LABEL[row.subgroup || 0]) : null,
      `Рассылка: ${mailing || 'выключена'}`,
      '',
      `<blockquote>${await todaySummary(ctx)}</blockquote>`,
      '',
      '<i>Сегодня, завтра и неделя — на кнопках внизу экрана</i>',
    ].filter((x) => x !== null);
    const d = today(ctx);
    // Сегодня / Завтра / Неделя — на закреплённых кнопках внизу экрана.
    const kb = new InlineKeyboard()
      .text('Календарь', `c:g:${pack(d).slice(0, 6)}`).text('Преподаватели', 't').row()
      .text('Настройки', 'set').text('Помощь', 'help').row()
      .text('Поддержка', 'sup').text('Поддержать проект', 'don');
    return render(ctx, lines.join('\n'), kb, opts);
  }

  bot.command(['start', 'menu', 'setup'], async (ctx) => {
    await tidy(ctx);
    if (ctx.target.kind === 'private') await installKeyboard(ctx);
    await showMain(ctx);
  });

  /**
   * Закреплённые кнопки внизу. Telegram показывает их только вместе с
   * сообщением, поэтому держим ровно одно служебное сообщение: при новом
   * /start старое удаляем и присылаем свежее.
   */
  async function installKeyboard(ctx) {
    const old = ctx.target.row.state.kbMsgId;
    const m = await ctx.reply('Кнопки <b>Сегодня · Завтра · Неделя</b> закреплены внизу экрана', {
      parse_mode: 'HTML', reply_markup: REPLY_KEYBOARD,
    }).catch(() => null);
    if (!m) return;
    if (old && old !== m.message_id) ctx.api.deleteMessage(ctx.chat.id, old).catch(() => {});
    ctx.target.row.state.kbMsgId = m.message_id;
    await query(
      `UPDATE ${ctx.target.table} SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{kbMsgId}', to_jsonb($1::bigint)) WHERE id = $2`,
      [m.message_id, ctx.target.row.id]
    );
  }

  bot.callbackQuery('m', async (ctx) => { await ack(ctx); await showMain(ctx); });
  // Кнопка «Меню» под рассылкой/ответом поддержки: меню новым сообщением, само сообщение не трогаем.
  bot.callbackQuery('m:new', async (ctx) => { await ack(ctx); await showMain(ctx, { fresh: true }); });

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
      .text('Календарь', `c:g:${pack(dateKey).slice(0, 6)}`)
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
      .text('Календарь', `c:g:${pack(mondayKey).slice(0, 6)}`)
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
      `<b>Календарь</b>  ·  ${MONTHS[m - 1].toLowerCase()} ${y}`,
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
      '<b>Преподаватели</b>',
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
    await render(ctx, `<b>Преподаватели ${title}</b>\n\nВыбери преподавателя.`, kb);
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
      .text('Календарь', `c:t:${pack(dateKey).slice(0, 6)}`)
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

  const pickerHeader = (step, title) => `<b>Выбор группы</b>  ·  шаг ${step} из 3\n\n${title}`;

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
    if (!hasSub) {
      if (ctx.target.row.subgroup) await updateRow(ctx, { subgroup: null });
      return render(ctx, [
        '<b>Группа подключена</b>',
        '',
        `<blockquote><b>${escapeHtml(result.group.name)}</b>\nЗагружено ${result.lessons} пар с сайта ssaa.ru, дальше обновляю сам</blockquote>`,
        firstSetup ? `Рассылка включена: утром в ${DEFAULT_MORNING_TIME} и вечером в ${DEFAULT_EVENING_TIME}. Изменить — в настройках.` : null,
      ].filter((x) => x !== null).join('\n'), new InlineKeyboard().text('Открыть расписание', 'm'));
    }
    const kb = new InlineKeyboard().text('Обе', 'sub:set:0').text('1-я', 'sub:set:1').text('2-я', 'sub:set:2');
    await render(ctx, [
      '<b>Группа подключена</b>',
      '',
      `<blockquote><b>${escapeHtml(result.group.name)}</b>\nЗагружено ${result.lessons} пар с сайта ssaa.ru, дальше обновляю сам</blockquote>`,
      firstSetup ? `Рассылка включена: утром в ${DEFAULT_MORNING_TIME} и вечером в ${DEFAULT_EVENING_TIME}. Изменить — в настройках.` : null,
      '',
      '<b>В какой ты подгруппе?</b>',
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
      '<b>Настройки</b>',
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
    await render(ctx, '<b>Подгруппа</b>\n\nЧьи пары показывать?\n<i>При «Обе» пары подгрупп подписаны отдельно.</i>', kb);
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
    const title = kind === 'morning' ? '<b>Утренняя рассылка</b>\nпары на сегодня' : '<b>Вечерняя рассылка</b>\nпары на завтра';
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
    await render(ctx, '<b>Часовой пояс</b>\n\nВыбери город.\n<i>Или напиши пояс, например Asia/Yekaterinburg</i>', kb);
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
    await render(ctx, await getText('help'), new InlineKeyboard().text('Поддержка', 'sup').text('⬅️ Назад', 'm'));
  }
  bot.callbackQuery('help', async (ctx) => { await ack(ctx); await showHelp(ctx); });
  bot.command('help', async (ctx) => { await tidy(ctx); await showHelp(ctx); });

  async function showSupport(ctx) {
    const viaBot = BOT_ADMIN_IDS.length > 0;
    if (viaBot) await setState(ctx, { step: 'support' });
    const kb = new InlineKeyboard().url(`Написать ${SUPPORT_NICK}`, SUPPORT_CONTACT).row()
      .text('Поддержать проект', 'don').text('⬅️ Назад', 'm');
    await render(ctx, [
      '<b>Поддержка</b>',
      '',
      'Нашёл ошибку в расписании, что-то не работает или есть идея?',
      '',
      viaBot ? '<blockquote>Напиши сюда одним сообщением, можно со скриншотом. Передам разработчику, ответ придёт в этот чат.</blockquote>' : null,
      `Или напрямую: <a href="${SUPPORT_CONTACT}">${SUPPORT_NICK}</a>`,
    ].filter((x) => x !== null).join('\n'), kb);
  }

  bot.callbackQuery('sup', async (ctx) => { await ack(ctx); await showSupport(ctx); });
  bot.command('support', async (ctx) => { await tidy(ctx); await showSupport(ctx); });

  async function showDonate(ctx) {
    await render(ctx, await getText('donate'), new InlineKeyboard().text('Поддержка', 'sup').text('⬅️ Назад', 'm'));
  }
  bot.callbackQuery('don', async (ctx) => { await ack(ctx); await showDonate(ctx); });
  bot.command(['donate', 'donat'], async (ctx) => { await tidy(ctx); await showDonate(ctx); });

  /** Обращение пользователя → всем админам. В подписи — #id, по нему админ отвечает реплаем. */
  async function forwardToSupport(ctx) {
    const u = ctx.from;
    const who = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Пользователь';
    const group = ctx.target.row.group_id ? (await getGroup(ctx.target.row.group_id))?.name : null;
    const header = [
      `📩 <b>Обращение</b> #id${ctx.chat.id}`,
      `👤 ${escapeHtml(who)}${u.username ? ` (@${escapeHtml(u.username)})` : ''}`,
      group ? `👥 ${escapeHtml(group)}` : null,
      '',
    ].filter((x) => x !== null).join('\n');
    const footer = '\n\n<i>↩️ Ответь реплаем на это сообщение — ответ уйдёт пользователю.</i>';
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
    if (!replied || ctx.chat.type !== 'private' || !isBotAdmin(ctx.from.id)) return false;
    const tag = (replied.text || replied.caption || '').match(/#id(-?\d+)/);
    if (!tag) return false;
    const chatId = Number(tag[1]);
    const answerKb = new InlineKeyboard().text('Ответить', 'sup');
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

  const adminOnly = (ctx) => ctx.chat?.type === 'private' && isBotAdmin(ctx.from.id);

  async function showAdmin(ctx) {
    await setState(ctx, {});
    const { rows: [s] } = await query(
      `SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM users WHERE group_id IS NOT NULL) ug,
              (SELECT count(*) FROM group_chats WHERE group_id IS NOT NULL) gc,
              (SELECT count(*) FROM groups WHERE source_key IS NOT NULL) gs, (SELECT count(*) FROM lessons) l`
    );
    const kb = new InlineKeyboard();
    for (const [key, label] of Object.entries(EDITABLE_TEXT_LABELS)) kb.text(`✏️ ${label}`, `a:e:${key}`).row();
    kb.text('📚 Группы', 'a:g').row().text('⬅️ Назад', 'm');
    await render(ctx, [
      '🛠 <b>Админ-панель</b>',
      DIVIDER,
      `👤 Пользователей: ${s.u} (с группой: ${s.ug})`,
      `💬 Групповых чатов: ${s.gc}`,
      `🌐 Групп с сайта: ${s.gs} · пар в базе: ${s.l}`,
      '',
      'Ответы на обращения — реплаем на сообщение «📩 Обращение».',
    ].join('\n'), kb);
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

  // ---------- сообщения: поддержка, ответ админа, ввод даты / фамилии / времени ----------

  bot.on('message', async (ctx) => {
    if (await relayAdminReply(ctx)) return;

    const state = ctx.target.row.state || {};
    const text = ctx.message.text?.trim();

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
          : `Не получилось отправить. Напиши напрямую: ${SUPPORT_NICK}`,
        new InlineKeyboard().text('⬅️ Назад', 'm'));
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
