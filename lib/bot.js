import { Bot, InlineKeyboard, Keyboard, GrammyError } from 'grammy';
import { query } from './db.js';
import {
  findGroupByName,
  createGroup,
  renameGroup,
  getGroup,
  deleteGroup,
  listGroups,
  createTerm,
  listTerms,
  getTerm,
  deleteTerm,
  getRelevantTermForViewing,
  replaceScheduleForTerm,
  getFullScheduleForTerm,
  parseScheduleText,
  scheduleTemplate,
  aiPromptTemplate,
} from './schedule.js';
import { formatFullSchedule, formatTeacherSchedule, escapeHtml, splitMessage } from './format.js';
import { fetchSsaaGroups, SSAA_FORMS, pickPeriod } from './ssaa.js';
import { importSsaaGroup, ensureGroupFresh, syncGroup } from './ssaaSync.js';
import { isValidTime, formatDateShort, parseDateInput, nowInTimezone } from './time.js';
import { buildTodayDigest, buildTomorrowDigest, buildWeekDigest } from './digest.js';
import { findTeacherLessonsToday, findTeacherLessonsTomorrow, listDistinctTeachers } from './teacherSearch.js';
import { getText, setText, resetText, EDITABLE_TEXT_LABELS, DEFAULT_TEXTS } from './texts.js';

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
const DEFAULT_MORNING_TIME = '07:30';
const DEFAULT_EVENING_TIME = '20:00';

const QUICK_TODAY_LABEL = '📨 Расписание на сегодня';
const QUICK_TOMORROW_LABEL = '📨 На завтра';
const QUICK_WEEK_LABEL = '🗓 Расписание на неделю';
const TEACHERS_PAGE_SIZE = 25;

// Список telegram_id, кому доступна админ-панель бота (не путать с админом
// группового чата в Telegram!). Задаётся через ADMIN_TELEGRAM_IDS="123,456".
const BOT_ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

function isBotAdmin(telegramId) {
  return BOT_ADMIN_IDS.includes(Number(telegramId));
}

export function createBot() {
  const bot = new Bot(process.env.BOT_TOKEN);

  // Ловит любую необработанную ошибку в любом обработчике, чтобы кнопка
  // никогда не "молчала" — пользователь получит понятное сообщение,
  // а полный текст ошибки попадёт в логи Vercel для разбора.
  bot.catch((err) => {
    console.error('Bot error on update', err.ctx?.update?.update_id, ':', err.error);
    err.ctx?.reply('⚠️ Что-то пошло не так. Попробуй ещё раз или напиши /menu.').catch(() => {});
  });

  // --- middleware: для личных чатов подгружаем/создаём users-строку,
  // для групповых — group_chats-строку (по chat_id, не по человеку). ---
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return next();

    if (ctx.chat.type === 'private') {
      const tgId = ctx.from.id;
      const { rows } = await query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      let user = rows[0];
      if (!user) {
        const inserted = await query(
          `INSERT INTO users (telegram_id, username, timezone) VALUES ($1, $2, $3) RETURNING *`,
          [tgId, ctx.from.username || null, DEFAULT_TZ]
        );
        user = inserted.rows[0];
      }
      ctx.dbUser = user;
    } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const chatId = ctx.chat.id;
      const { rows } = await query('SELECT * FROM group_chats WHERE chat_id = $1', [chatId]);
      let gc = rows[0];
      if (!gc) {
        const inserted = await query(
          `INSERT INTO group_chats (chat_id, title, timezone) VALUES ($1, $2, $3) RETURNING *`,
          [chatId, ctx.chat.title || null, DEFAULT_TZ]
        );
        gc = inserted.rows[0];
      } else if (ctx.chat.title && ctx.chat.title !== gc.title) {
        await query('UPDATE group_chats SET title = $1 WHERE id = $2', [ctx.chat.title, gc.id]);
        gc.title = ctx.chat.title;
      }
      ctx.chatConfig = gc;
    }

    await next();
  });

  // --- абстракция "получатель рассылки": личный пользователь или групповой чат ---
  function getTarget(ctx) {
    if (ctx.chat.type === 'private') {
      return { kind: 'private', table: 'users', row: ctx.dbUser };
    }
    return { kind: 'group', table: 'group_chats', row: ctx.chatConfig };
  }

  async function setTargetState(ctx, target, state) {
    await query(`UPDATE ${target.table} SET state = $1 WHERE id = $2`, [JSON.stringify(state), target.row.id]);
    target.row.state = state;
  }

  async function refreshTarget(target) {
    const { rows } = await query(`SELECT * FROM ${target.table} WHERE id = $1`, [target.row.id]);
    target.row = rows[0];
    return target.row;
  }

  /** В личке разрешено всегда; в групповом чате — только админам чата в Telegram. */
  async function canConfigure(ctx, target) {
    if (target.kind === 'private') return true;
    try {
      const member = await ctx.getChatMember(ctx.from.id);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  }

  async function denyIfNotAllowed(ctx, target) {
    if (await canConfigure(ctx, target)) return false;
    await ctx.answerCallbackQuery({
      text: 'Настраивать бота в этом чате может только администратор чата.',
      show_alert: true,
    });
    return true;
  }

  /** Безопасно редактирует сообщение: игнорирует безобидную ошибку Telegram
   * "message is not modified" (когда текст/клавиатура не изменились). */
  async function safeEditMessageText(ctx, text, extra) {
    try {
      await ctx.editMessageText(text, extra);
    } catch (e) {
      if (e instanceof GrammyError && e.description?.includes('message is not modified')) {
        return;
      }
      throw e;
    }
  }

  /**
   * Показывает "экран" (меню/список/визард-запрос). Если это переход по
   * кнопке — сначала удаляет сообщение с той кнопкой, чтобы в чате не
   * копились старые экраны меню; если это ответ на текстовое сообщение —
   * просто присылает новое (удалять нечего).
   */
  async function sendScreen(ctx, text, extra) {
    if (ctx.callbackQuery) {
      try {
        await ctx.deleteMessage();
      } catch {
        // сообщение уже могло быть удалено/устареть — не критично
      }
    }
    return replyLong(ctx, text, extra);
  }

  /** Как ctx.reply, но текст длиннее лимита Telegram (4096) делит на части;
   * клавиатура прикрепляется к последней части. */
  async function replyLong(ctx, text, extra = {}) {
    const parts = splitMessage(text);
    const { reply_markup, ...rest } = extra;
    let last;
    for (let i = 0; i < parts.length; i++) {
      last = await ctx.reply(parts[i], i === parts.length - 1 ? extra : rest);
    }
    return last;
  }

  function cancelKeyboard(extraRows) {
    const kb = new InlineKeyboard();
    if (extraRows) extraRows(kb);
    kb.text('❌ Отмена', 'wizard:cancel');
    return kb;
  }

  // ---------- Клавиатура быстрых ответов (внизу чата) ----------

  function quickReplyKeyboard() {
    return new Keyboard()
      .text(QUICK_TODAY_LABEL)
      .text(QUICK_TOMORROW_LABEL)
      .row()
      .text(QUICK_WEEK_LABEL)
      .resized();
  }

  async function sendTodayDigest(ctx, target) {
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildTodayDigest(target.row);
    await replyLong(ctx, text, { parse_mode: 'HTML' });
  }

  async function sendTomorrowDigest(ctx, target) {
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildTomorrowDigest(target.row);
    await replyLong(ctx, text, { parse_mode: 'HTML' });
  }

  async function sendWeekDigest(ctx, target) {
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildWeekDigest(target.row);
    await replyLong(ctx, text, { parse_mode: 'HTML' });
  }

  // ---------- Главное меню ----------

  function mainMenuKeyboard() {
    return new InlineKeyboard()
      .text('👥 Учебная группа', 'menu:group').row()
      .text('📅 Расписание', 'menu:schedule').row()
      .text('⏰ Время рассылок', 'menu:times').row()
      .text('🔎 Найти преподавателя', 'menu:teacher').row()
      .text('❓ Помощь', 'menu:help');
  }

  async function showMainMenu(ctx) {
    const target = getTarget(ctx);
    await setTargetState(ctx, target, {});
    const text = target.kind === 'private' ? await getText('welcome') : await getText('group_welcome');
    await sendScreen(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
    // Клавиатуру с быстрыми кнопками присылаем/обновляем отдельным
    // системным сообщением — Telegram не позволяет одновременно и
    // inline-клавиатуру, и обычную (внизу экрана) на одном сообщении.
    await ctx.reply('Быстрые кнопки — внизу 👇', { reply_markup: quickReplyKeyboard() });
  }

  bot.command(['start', 'setup', 'menu'], async (ctx) => {
    await showMainMenu(ctx);
  });

  bot.command('help', async (ctx) => {
    const target = getTarget(ctx);
    const text = target.kind === 'private' ? await getText('help') : await getText('group_welcome');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.command('today', async (ctx) => sendTodayDigest(ctx, getTarget(ctx)));
  bot.command('tomorrow', async (ctx) => sendTomorrowDigest(ctx, getTarget(ctx)));
  bot.command('week', async (ctx) => sendWeekDigest(ctx, getTarget(ctx)));

  async function runTeacherSearch(ctx, target, teacherQuery, exact = false) {
    await setTargetState(ctx, target, { lastTeacherQuery: teacherQuery, lastTeacherExact: exact });
    const { todayLessons, current } = await findTeacherLessonsToday(teacherQuery, target.row.timezone, exact);
    const text = formatTeacherSchedule(teacherQuery, todayLessons, { dayLabel: 'сегодня', current });
    const kb = new InlineKeyboard()
      .text('🔜 Завтра', 'teacher:tomorrow').row()
      .text('🔍 Искать ещё', 'menu:teacher').row()
      .text('⬅️ Назад', 'menu:main');
    await replyLong(ctx, text, { parse_mode: 'HTML', reply_markup: kb });
  }

  async function runTeacherSearchTomorrow(ctx, target, teacherQuery, exact = false) {
    await setTargetState(ctx, target, { lastTeacherQuery: teacherQuery, lastTeacherExact: exact });
    const { lessons } = await findTeacherLessonsTomorrow(teacherQuery, target.row.timezone, exact);
    const text = formatTeacherSchedule(teacherQuery, lessons, { dayLabel: 'завтра' });
    const kb = new InlineKeyboard()
      .text('◀️ Сегодня', 'teacher:today').row()
      .text('🔍 Искать ещё', 'menu:teacher').row()
      .text('⬅️ Назад', 'menu:main');
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }

  /** Показывает список преподавателей кнопками (с пагинацией), плюс можно
   * просто написать фамилию текстом — оба способа работают одновременно. */
  async function showTeacherList(ctx, target, page = 0, reload = false) {
    let teachers = target.row.state?.teacherOptions;
    if (reload || !Array.isArray(teachers)) {
      teachers = await listDistinctTeachers();
      await setTargetState(ctx, target, { step: 'awaiting_teacher_search', teacherOptions: teachers });
    }

    if (teachers.length === 0) {
      await sendScreen(ctx,
        'Пока в расписании ни у одной пары не указан преподаватель — как заполнишь расписание с преподавателями, тут появится список.\n\nМожно попробовать написать фамилию текстом на всякий случай.',
        { reply_markup: cancelKeyboard() }
      );
      return;
    }

    const start = page * TEACHERS_PAGE_SIZE;
    const pageItems = teachers.slice(start, start + TEACHERS_PAGE_SIZE);
    const kb = new InlineKeyboard();
    pageItems.forEach((name, i) => {
      kb.text(name, `teacher:pick:${start + i}`).row();
    });

    if (page > 0) kb.text('◀️ Назад', `teacher:page:${page - 1}`);
    if (start + TEACHERS_PAGE_SIZE < teachers.length) kb.text('▶️ Ещё', `teacher:page:${page + 1}`);
    if (page > 0 || start + TEACHERS_PAGE_SIZE < teachers.length) kb.row();
    kb.text('⬅️ Назад', 'menu:main');

    const pageLabel = teachers.length > TEACHERS_PAGE_SIZE ? ` (стр. ${page + 1})` : '';
    await sendScreen(ctx,
      `Выбери преподавателя${pageLabel} — или просто напиши фамилию текстом:`,
      { reply_markup: kb }
    );
  }

  bot.command('teacher', async (ctx) => {
    const rest = ctx.match?.trim();
    const target = getTarget(ctx);
    if (rest) {
      await runTeacherSearch(ctx, target, rest);
      return;
    }
    await showTeacherList(ctx, target, 0, true);
  });

  bot.callbackQuery('menu:teacher', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    // Список перечитываем при каждом открытии — иначе новые преподаватели
    // (после обновления расписания) не появлялись до сброса меню.
    await showTeacherList(ctx, target, 0, true);
  });

  bot.callbackQuery(/^teacher:page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    await showTeacherList(ctx, target, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^teacher:pick:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    const idx = Number(ctx.match[1]);
    const teachers = target.row.state?.teacherOptions || [];
    const name = teachers[idx];
    if (!name) {
      await setTargetState(ctx, target, {});
      await ctx.reply('Список успел устареть — открой поиск заново.');
      await showMainMenu(ctx);
      return;
    }
    await runTeacherSearch(ctx, target, name, true);
  });

  bot.callbackQuery('teacher:tomorrow', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    const name = target.row.state?.lastTeacherQuery;
    if (!name) {
      await showTeacherList(ctx, target);
      return;
    }
    await runTeacherSearchTomorrow(ctx, target, name, Boolean(target.row.state?.lastTeacherExact));
  });

  bot.callbackQuery('teacher:today', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    const name = target.row.state?.lastTeacherQuery;
    if (!name) {
      await showTeacherList(ctx, target);
      return;
    }
    await runTeacherSearch(ctx, target, name, Boolean(target.row.state?.lastTeacherExact));
  });

  bot.callbackQuery('menu:main', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
  });

  bot.callbackQuery('wizard:cancel', async (ctx) => {
    const target = getTarget(ctx);
    await setTargetState(ctx, target, {});
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    await showMainMenu(ctx);
  });

  bot.callbackQuery('menu:help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    const text = target.kind === 'private' ? await getText('help') : await getText('group_welcome');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ---------- Учебная группа ----------

  async function currentGroup(target) {
    if (!target.row.group_id) return null;
    return getGroup(target.row.group_id);
  }

  const SUBGROUP_LABEL = { 0: 'обе подгруппы', 1: '1-я подгруппа', 2: '2-я подгруппа' };

  function formatSyncInfo(group, timezone = DEFAULT_TZ) {
    if (!group?.source_key) return '';
    const when = group.synced_at
      ? new Date(group.synced_at).toLocaleString('ru-RU', { timeZone: timezone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : 'ещё не загружалось';
    let text = `\n🌐 Расписание берётся с сайта ssaa.ru автоматически (обновлено: ${when}).`;
    if (group.sync_error) text += `\n⚠️ Последнее обновление не удалось: ${escapeHtml(group.sync_error)}`;
    return text;
  }

  async function showGroupMenu(ctx) {
    const target = getTarget(ctx);
    const group = await currentGroup(target);
    const kb = new InlineKeyboard()
      .text('🌐 Выбрать группу с сайта ssaa.ru', 'ss:start').row();

    if (group) {
      kb.text(`👥 Подгруппа: ${SUBGROUP_LABEL[target.row.subgroup || 0]}`, 'sub:ask').row();
      if (group.source_key) kb.text('🔄 Обновить расписание с сайта', 'ss:refresh').row();
    }
    kb.text('🔍 Выбрать из созданных в боте', 'group:pick').row()
      .text('➕ Создать вручную', 'group:create').row();
    if (group) kb.text('🗑 Удалить группу', 'group:delete:ask').row();
    kb.text('⬅️ Назад', 'menu:main');

    const text = group
      ? `Текущая учебная группа: <b>${escapeHtml(group.name)}</b>\nПодгруппа: ${SUBGROUP_LABEL[target.row.subgroup || 0]}${formatSyncInfo(group, target.row.timezone)}`
      : 'Учебная группа ещё не выбрана.\n\nПроще всего — <b>🌐 Выбрать группу с сайта</b>: расписание загрузится само и будет обновляться автоматически.';

    await sendScreen(ctx, text, { parse_mode: 'HTML', reply_markup: kb });
  }

  bot.callbackQuery('menu:group', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGroupMenu(ctx);
  });

  // ---------- Выбор группы с сайта ssaa.ru ----------
  // callback_data в Telegram ограничен 64 байтами, поэтому вместо названий
  // (кириллица) передаём коды: форма обучения, номер факультета в списке,
  // номер курса и номер группы.

  const uniq = (arr) => [...new Set(arr)];
  const numOf = (s) => Number((String(s).match(/\d+/) || [0])[0]);

  async function ssaaRows(form) {
    const all = await fetchSsaaGroups();
    return form ? all.filter((g) => g.form === form) : all;
  }

  function facultiesOf(rows) {
    return uniq(rows.map((g) => g.faculty)).sort((a, b) => a.localeCompare(b, 'ru'));
  }

  async function ssaaUnavailable(ctx, e) {
    console.error('ssaa.ru unavailable:', e);
    await sendScreen(ctx,
      `⚠️ Не получилось открыть сайт ssaa.ru (${escapeHtml(e.message || String(e))}).\nПопробуй через пару минут.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔁 Ещё раз', 'ss:start').row().text('⬅️ Назад', 'menu:group') }
    );
  }

  async function showSsaaForms(ctx) {
    let all;
    try { all = await ssaaRows(); } catch (e) { await ssaaUnavailable(ctx, e); return; }
    const present = new Set(all.map((g) => g.form));
    const kb = new InlineKeyboard();
    for (const f of SSAA_FORMS) if (present.has(f.code)) kb.text(f.label, `ss:f:${f.code}`).row();
    kb.text('⬅️ Назад', 'menu:group');
    await sendScreen(ctx, 'Форма обучения:', { reply_markup: kb });
  }

  async function showSsaaCourses(ctx, form, facIdx) {
    let rows;
    try { rows = await ssaaRows(form); } catch (e) { await ssaaUnavailable(ctx, e); return; }
    const faculty = facultiesOf(rows)[facIdx];
    const courses = uniq(rows.filter((g) => g.faculty === faculty).map((g) => numOf(g.course))).sort((a, b) => a - b);
    const kb = new InlineKeyboard();
    courses.forEach((c, i) => {
      kb.text(`${c} курс`, `ss:k:${form}:${facIdx}:${c}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text('⬅️ Назад', facultiesOf(rows).length > 1 ? `ss:f:${form}` : 'ss:start');
    await sendScreen(ctx, `<b>${escapeHtml(faculty || '')}</b>\nВыбери курс:`, { parse_mode: 'HTML', reply_markup: kb });
  }

  bot.callbackQuery('ss:start', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await showSsaaForms(ctx);
  });

  bot.callbackQuery(/^ss:f:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const form = ctx.match[1];
    let rows;
    try { rows = await ssaaRows(form); } catch (e) { await ssaaUnavailable(ctx, e); return; }
    const faculties = facultiesOf(rows);
    if (faculties.length === 1) {
      await showSsaaCourses(ctx, form, 0); // у колледжа один "факультет" — шаг пропускаем
      return;
    }
    const kb = new InlineKeyboard();
    faculties.forEach((f, i) => kb.text(f, `ss:c:${form}:${i}`).row());
    kb.text('⬅️ Назад', 'ss:start');
    await sendScreen(ctx, 'Факультет:', { reply_markup: kb });
  });

  bot.callbackQuery(/^ss:c:(\d+):(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await showSsaaCourses(ctx, ctx.match[1], Number(ctx.match[2]));
  });

  bot.callbackQuery(/^ss:k:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const [form, facIdx, course] = [ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3])];
    let rows;
    try { rows = await ssaaRows(form); } catch (e) { await ssaaUnavailable(ctx, e); return; }
    const faculty = facultiesOf(rows)[facIdx];
    const groups = uniq(rows.filter((g) => g.faculty === faculty && numOf(g.course) === course).map((g) => numOf(g.group)))
      .sort((a, b) => a - b);
    const kb = new InlineKeyboard();
    groups.forEach((g, i) => {
      kb.text(`${g} группа`, `ss:g:${form}:${facIdx}:${course}:${g}`);
      if (i % 3 === 2) kb.row();
    });
    kb.row().text('⬅️ Назад', `ss:c:${form}:${facIdx}`);
    await sendScreen(ctx, `<b>${escapeHtml(faculty || '')}, ${course} курс</b>\nВыбери группу:`, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery(/^ss:g:(\d+):(\d+):(\d+):(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery({ text: 'Загружаю расписание с сайта…' });
    const [form, facIdx, course, groupNum] = [ctx.match[1], Number(ctx.match[2]), Number(ctx.match[3]), Number(ctx.match[4])];

    let row;
    try {
      const rows = await ssaaRows(form);
      const faculty = facultiesOf(rows)[facIdx];
      const periods = rows.filter((g) => g.faculty === faculty && numOf(g.course) === course && numOf(g.group) === groupNum);
      row = pickPeriod(periods, nowInTimezone(target.row.timezone).dateKey);
    } catch (e) { await ssaaUnavailable(ctx, e); return; }
    if (!row) {
      await sendScreen(ctx, 'Эту группу не нашёл на сайте — возможно, список обновился. Выбери заново.', {
        reply_markup: new InlineKeyboard().text('🌐 Заново', 'ss:start'),
      });
      return;
    }

    let result;
    try {
      result = await importSsaaGroup(row, ctx.from.id);
    } catch (e) {
      await ssaaUnavailable(ctx, e);
      return;
    }
    await query(`UPDATE ${target.table} SET group_id = $1 WHERE id = $2`, [result.group.id, target.row.id]);
    await refreshTarget(target);

    const kb = new InlineKeyboard()
      .text('Обе', 'sub:set:0').text('1-я', 'sub:set:1').text('2-я', 'sub:set:2');
    await sendScreen(ctx,
      [
        `✅ Группа <b>${escapeHtml(result.group.name)}</b> подключена — загрузил ${result.lessons} пар с сайта.`,
        'Расписание будет обновляться само, вручную ничего вводить не нужно.',
        '',
        'В какой ты подгруппе? Тогда буду показывать только твои пары (поменять можно в «👥 Учебная группа»).',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery('ss:refresh', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const group = await currentGroup(target);
    if (!group?.source_key) { await ctx.answerCallbackQuery(); await showGroupMenu(ctx); return; }
    await ctx.answerCallbackQuery({ text: 'Обновляю…' });
    try {
      const r = await syncGroup(group);
      await ctx.reply(`✅ Расписание обновлено с сайта: ${r.lessons} пар.`);
    } catch (e) {
      await query('UPDATE groups SET sync_error = $1, sync_attempted_at = now() WHERE id = $2', [String(e.message || e).slice(0, 500), group.id]);
      await ctx.reply(`⚠️ Не получилось обновить: ${e.message || e}. Пока показываю сохранённое расписание.`);
    }
    await showGroupMenu(ctx);
  });

  // ---------- Подгруппа ----------

  bot.callbackQuery('sub:ask', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('Обе', 'sub:set:0').text('1-я', 'sub:set:1').text('2-я', 'sub:set:2').row()
      .text('⬅️ Назад', 'menu:group');
    await sendScreen(ctx, 'Чьи пары показывать? При «Обе» пары подгрупп подписаны отдельно.', { reply_markup: kb });
  });

  bot.callbackQuery(/^sub:set:([012])$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const value = Number(ctx.match[1]) || null;
    await query(`UPDATE ${target.table} SET subgroup = $1 WHERE id = $2`, [value, target.row.id]);
    await refreshTarget(target);
    await ctx.answerCallbackQuery({ text: `Готово: ${SUBGROUP_LABEL[value || 0]}` });
    await showMainMenu(ctx);
  });

  // ---------- Учебная группа: созданные вручную ----------

  bot.callbackQuery('group:create', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_new_group_name' });
    await sendScreen(ctx, 'Напиши название новой учебной группы (например: ИС-21):', {
      reply_markup: cancelKeyboard(),
    });
  });

  bot.callbackQuery('group:pick', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const groups = await listGroups();
    const kb = new InlineKeyboard();
    for (const g of groups) {
      kb.text(g.name, `group:set:${g.id}`).row();
    }
    kb.text('⬅️ Назад', 'menu:group');
    const text = groups.length > 0
      ? 'Выбери учебную группу:'
      : 'Пока нет ни одной созданной группы. Выбери с сайта или создай вручную.';
    await sendScreen(ctx, text, { reply_markup: kb });
  });

  bot.callbackQuery(/^group:set:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const groupId = Number(ctx.match[1]);
    await query(`UPDATE ${target.table} SET group_id = $1 WHERE id = $2`, [groupId, target.row.id]);
    await ctx.answerCallbackQuery({ text: 'Группа выбрана!' });
    await showMainMenu(ctx);
  });

  bot.callbackQuery('group:delete:ask', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const group = await currentGroup(target);
    if (!group) {
      await showGroupMenu(ctx);
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Да, удалить', 'group:delete:confirm').row()
      .text('❌ Отмена', 'menu:group');
    await safeEditMessageText(ctx,
      `Точно удалить группу <b>${escapeHtml(group.name)}</b>? Расписание и все семестры удалятся безвозвратно, у всех подписчиков группа снимется.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery('group:delete:confirm', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const groupId = target.row.group_id;
    if (!groupId) {
      await ctx.answerCallbackQuery();
      await showGroupMenu(ctx);
      return;
    }
    await deleteGroup(groupId);
    await refreshTarget(target);
    await ctx.answerCallbackQuery({ text: 'Группа удалена' });
    await showGroupMenu(ctx);
  });

  // ---------- Расписание: просмотр ----------

  async function showScheduleMenu(ctx) {
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await sendScreen(ctx, 'Сначала выбери учебную группу в меню «Учебная группа».', {
        reply_markup: new InlineKeyboard().text('👥 Учебная группа', 'menu:group').row().text('⬅️ Назад', 'menu:main'),
      });
      return;
    }

    await ensureGroupFresh(target.row.group_id);
    const group = await getGroup(target.row.group_id);
    const { dateKey } = nowInTimezone(target.row.timezone);
    const relevant = await getRelevantTermForViewing(target.row.group_id, dateKey);

    const kb = new InlineKeyboard().text('📆 Семестры', 'terms:list').row();
    if (group?.source_key) {
      // Расписание с сайта при обновлении перезаписывается, поэтому ручное
      // редактирование тут не предлагаем — только обновление.
      kb.text('🔄 Обновить с сайта', 'ss:refresh').row();
    } else {
      kb.text('✏️ Заполнить/изменить расписание', 'schedule:edit:pick').row()
        .text('🌐 Взять с сайта ssaa.ru', 'ss:start').row();
    }
    kb.text('⬅️ Назад', 'menu:main');

    if (!relevant) {
      await sendScreen(ctx,
        'Для этой группы ещё не добавлено ни одного семестра. Начни с кнопки «📆 Семестры».',
        { reply_markup: kb }
      );
      return;
    }

    const subgroup = target.row.subgroup || null;
    const byDay = await getFullScheduleForTerm(relevant.term.id, subgroup);
    let text = formatFullSchedule(byDay, relevant.term, subgroup);
    if (relevant.status === 'upcoming') {
      text = `<i>Сейчас между семестрами — показываю ближайший.</i>\n\n${text}`;
    } else if (relevant.status === 'past') {
      text = `<i>Сейчас нет активного семестра — показываю последний прошедший.</i>\n\n${text}`;
    }

    await sendScreen(ctx, text, { parse_mode: 'HTML', reply_markup: kb });
  }

  bot.callbackQuery('menu:schedule', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showScheduleMenu(ctx);
  });

  // ---------- Семестры (для обычного пользователя/чата, по своей группе) ----------

  async function showTermsList(ctx) {
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await sendScreen(ctx, 'Сначала выбери учебную группу.', {
        reply_markup: new InlineKeyboard().text('⬅️ Назад', 'menu:main'),
      });
      return;
    }
    const terms = await listTerms(target.row.group_id);
    const kb = new InlineKeyboard();
    for (const t of terms) {
      kb.text(`${t.name} (${formatDateShort(t.date_start)}–${formatDateShort(t.date_end)})`, `terms:open:${t.id}`).row();
    }
    kb.text('➕ Добавить семестр', 'terms:add').row();
    kb.text('⬅️ Назад', 'menu:schedule');

    const text = terms.length > 0
      ? 'Семестры (периоды обучения) этой группы:'
      : 'У этой группы пока нет ни одного семестра. Добавь первый — например, "Осень 2026" с 1 сентября по 31 декабря.';

    await sendScreen(ctx, text, { reply_markup: kb });
  }

  bot.callbackQuery('terms:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTermsList(ctx);
  });

  bot.callbackQuery('terms:add', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_term_name' });
    await sendScreen(ctx, 'Как назвать семестр? Например: "Осень 2026" или "Весна 2027".', {
      reply_markup: cancelKeyboard(),
    });
  });

  bot.callbackQuery(/^terms:open:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    const term = await getTerm(termId);
    if (!term) {
      await showTermsList(ctx);
      return;
    }
    const kb = new InlineKeyboard();
    if (!term.source_period) {
      kb.text('✏️ Заполнить расписание этого семестра', `schedule:edit:term:${term.id}`).row();
    }
    kb.text('🗑 Удалить семестр', `terms:delete:ask:${term.id}`).row()
      .text('⬅️ Назад', 'terms:list');
    const fromSite = term.source_period ? '\n🌐 Загружен с сайта ssaa.ru и обновляется автоматически.' : '';
    await sendScreen(ctx,
      `<b>${escapeHtml(term.name)}</b>\n${formatDateShort(term.date_start)} – ${formatDateShort(term.date_end)}${fromSite}`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^terms:delete:ask:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    const term = await getTerm(termId);
    if (!term) {
      await showTermsList(ctx);
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Да, удалить', `terms:delete:confirm:${term.id}`).row()
      .text('❌ Отмена', `terms:open:${term.id}`);
    await safeEditMessageText(ctx,
      `Точно удалить семестр <b>${escapeHtml(term.name)}</b> и всё его расписание?`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^terms:delete:confirm:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const termId = Number(ctx.match[1]);
    await deleteTerm(termId);
    await ctx.answerCallbackQuery({ text: 'Семестр удалён' });
    await showTermsList(ctx);
  });

  // ---------- Редактирование расписания (выбор семестра → способ ввода) ----------
  // Эти обработчики группо-независимы (работают по termId), поэтому их же
  // напрямую переиспользует и админ-панель ниже.

  bot.callbackQuery('schedule:edit:pick', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    if (!target.row.group_id) {
      await showScheduleMenu(ctx);
      return;
    }
    const terms = await listTerms(target.row.group_id);
    if (terms.length === 0) {
      await setTargetState(ctx, target, { step: 'awaiting_term_name' });
      await sendScreen(ctx,
        'Сначала добавь семестр (период обучения) — например, "Осень 2026".\nКак его назвать?',
        { reply_markup: cancelKeyboard() }
      );
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of terms) {
      kb.text(`${t.name} (${formatDateShort(t.date_start)}–${formatDateShort(t.date_end)})`, `schedule:edit:term:${t.id}`).row();
    }
    kb.text('➕ Новый семестр', 'terms:add').row();
    kb.text('⬅️ Назад', 'menu:schedule');
    await sendScreen(ctx, 'Для какого семестра заполняем расписание?', { reply_markup: kb });
  });

  bot.callbackQuery(/^schedule:edit:term:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    const kb = new InlineKeyboard()
      .text('🤖 Промпт для нейросети (по скриншоту)', `schedule:edit:ai:${termId}`).row()
      .text('✍️ Ввести вручную по шаблону', `schedule:edit:manual:${termId}`).row()
      .text('⬅️ Назад', 'schedule:edit:pick');
    await sendScreen(ctx, 'Как удобнее заполнить расписание этого семестра?', { reply_markup: kb });
  });

  bot.callbackQuery(/^schedule:edit:manual:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    await setTargetState(ctx, target, { step: 'awaiting_schedule_text', termId });
    await sendScreen(ctx,
      [
        'Пришли расписание одним сообщением по такому шаблону:',
        '',
        `<pre>${scheduleTemplate()}</pre>`,
        '',
        'Аудитория и преподаватель — необязательны (раздели их через "|").',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
    );
  });

  bot.callbackQuery(/^schedule:edit:ai:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    await setTargetState(ctx, target, { step: 'awaiting_schedule_text', termId });
    await sendScreen(ctx,
      [
        '1️⃣ Скопируй промпт из следующего сообщения.',
        '2️⃣ Открой любую нейросеть (Claude, ChatGPT и т.п.), вставь промпт и приложи скриншот своего расписания.',
        '3️⃣ Ответ нейросети целиком пришли сюда, мне, одним сообщением — я его сохраню.',
      ].join('\n'),
      { reply_markup: cancelKeyboard() }
    );
    await ctx.reply(`<pre>${aiPromptTemplate()}</pre>`, { parse_mode: 'HTML' });
  });

  // ---------- Обработка фото (только в личке — в группе не спамим) ----------

  bot.on('message:photo', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(
      [
        'Сам я скриншот не прочитаю 🙈. Но если ты учишься в Самарском ГАУ — скриншот не нужен:',
        'открой «👥 Учебная группа» → «🌐 Выбрать группу с сайта ssaa.ru», и расписание загрузится само.',
        '',
        'Для другого расписания — через любую нейросеть:',
        '',
        '1️⃣ Зайди в меню «📅 Расписание» → «✏️ Заполнить/изменить расписание» → выбери семестр → «🤖 Промпт для нейросети».',
        '2️⃣ Отправь этот промпт вместе с этим скриншотом в Claude, ChatGPT или любую другую нейросеть.',
        '3️⃣ Полученный ответ пришли сюда — я сохраню расписание.',
      ].join('\n')
    );
  });

  // ---------- Время рассылок ----------

  function timesMenuKeyboard(row) {
    const eveningOn = Boolean(row.evening_time);
    const morningOn = Boolean(row.morning_time);
    return new InlineKeyboard()
      .text(`🌙 Вечером: ${row.evening_time || '—'}`, 'time:set:evening')
      .text(eveningOn ? '🟢 Вкл' : '⚪ Выкл', 'time:toggle:evening')
      .row()
      .text(`☀️ Утром: ${row.morning_time || '—'}`, 'time:set:morning')
      .text(morningOn ? '🟢 Вкл' : '⚪ Выкл', 'time:toggle:morning')
      .row()
      .text('🌍 Часовой пояс: ' + row.timezone, 'time:set:tz').row()
      .text('⬅️ Назад', 'menu:main');
  }

  async function showTimesMenu(ctx) {
    const target = getTarget(ctx);
    const text = 'Настрой время ежедневных напоминаний.\n\nНажми на время, чтобы изменить его, или на переключатель, чтобы включить/выключить рассылку.';
    await sendScreen(ctx, text, { reply_markup: timesMenuKeyboard(target.row) });
  }

  async function refreshTimesMenuInPlace(ctx, target) {
    const text = 'Настрой время ежедневных напоминаний.\n\nНажми на время, чтобы изменить его, или на переключатель, чтобы включить/выключить рассылку.';
    await safeEditMessageText(ctx, text, { reply_markup: timesMenuKeyboard(target.row) });
  }

  bot.callbackQuery('menu:times', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTimesMenu(ctx);
  });

  // Мгновенное включение/выключение без ввода времени — жмёшь и сообщение
  // сразу обновляется на месте (без отправки нового).
  bot.callbackQuery(/^time:toggle:(morning|evening)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const kind = ctx.match[1];
    const row = target.row;

    if (kind === 'evening') {
      if (row.evening_time) {
        await query(
          `UPDATE ${target.table} SET evening_time = NULL, evening_time_last = $1 WHERE id = $2`,
          [row.evening_time, row.id]
        );
      } else {
        const restore = row.evening_time_last || DEFAULT_EVENING_TIME;
        await query(`UPDATE ${target.table} SET evening_time = $1 WHERE id = $2`, [restore, row.id]);
      }
    } else {
      if (row.morning_time) {
        await query(
          `UPDATE ${target.table} SET morning_time = NULL, morning_time_last = $1 WHERE id = $2`,
          [row.morning_time, row.id]
        );
      } else {
        const restore = row.morning_time_last || DEFAULT_MORNING_TIME;
        await query(`UPDATE ${target.table} SET morning_time = $1 WHERE id = $2`, [restore, row.id]);
      }
    }

    await refreshTarget(target);
    await ctx.answerCallbackQuery({
      text: kind === 'evening'
        ? (target.row.evening_time ? `Вечерняя рассылка включена (${target.row.evening_time})` : 'Вечерняя рассылка выключена')
        : (target.row.morning_time ? `Утренняя рассылка включена (${target.row.morning_time})` : 'Утренняя рассылка выключена'),
    });
    await refreshTimesMenuInPlace(ctx, target);
  });

  bot.callbackQuery('time:set:evening', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_evening_time' });
    await sendScreen(ctx, 'Во сколько присылать расписание на завтра вечером? Формат: 20:00\n(Напиши "выкл", чтобы отключить)', {
      reply_markup: cancelKeyboard(),
    });
  });

  bot.callbackQuery('time:set:morning', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_morning_time' });
    await sendScreen(ctx, 'Во сколько присылать расписание на сегодня утром? Формат: 07:30\n(Напиши "выкл", чтобы отключить)', {
      reply_markup: cancelKeyboard(),
    });
  });

  bot.callbackQuery('time:set:tz', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_timezone' });
    await sendScreen(ctx,
      'Напиши свой часовой пояс в формате IANA, например:\nEurope/Moscow, Asia/Yekaterinburg, Europe/Kaliningrad',
      { reply_markup: cancelKeyboard() }
    );
  });

  // ---------- Админ-панель бота (только личка, только BOT_ADMIN_IDS) ----------

  function requireBotAdmin(ctx) {
    return ctx.chat.type === 'private' && isBotAdmin(ctx.from.id);
  }

  function adminMenuKeyboard() {
    const kb = new InlineKeyboard();
    for (const [key, label] of Object.entries(EDITABLE_TEXT_LABELS)) {
      kb.text(`✏️ ${label}`, `admin:edit:${key}`).row();
    }
    kb.text('📚 Группы и расписание', 'admin:groups').row();
    kb.text('❌ Закрыть', 'wizard:cancel');
    return kb;
  }

  bot.command('admin', async (ctx) => {
    if (!requireBotAdmin(ctx)) return;
    await ctx.reply(
      '🛠 <b>Админ-панель</b>\n\nЧто редактируем?',
      { parse_mode: 'HTML', reply_markup: adminMenuKeyboard() }
    );
  });

  bot.callbackQuery('admin:menu', async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await sendScreen(ctx, '🛠 <b>Админ-панель</b>\n\nЧто редактируем?', {
      parse_mode: 'HTML',
      reply_markup: adminMenuKeyboard(),
    });
  });

  bot.callbackQuery(/^admin:edit:(\w+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    const key = ctx.match[1];
    await ctx.answerCallbackQuery();
    const current = await getText(key);
    const target = getTarget(ctx);
    await setTargetState(ctx, target, { step: 'admin_awaiting_text', textKey: key });
    const kb = new InlineKeyboard()
      .text('↩️ Сбросить на значение по умолчанию', `admin:reset:${key}`).row()
      .text('❌ Отмена', 'admin:menu');
    await sendScreen(ctx,
      [
        `Текущий текст «${EDITABLE_TEXT_LABELS[key] || key}»:`,
        '',
        `<pre>${escapeHtml(current)}</pre>`,
        '',
        'Пришли новый текст одним сообщением (поддерживается HTML-разметка Telegram: &lt;b&gt;, &lt;i&gt;, &lt;code&gt; и т.д.).',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^admin:reset:(\w+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    const key = ctx.match[1];
    await resetText(key);
    const target = getTarget(ctx);
    await setTargetState(ctx, target, {});
    await ctx.answerCallbackQuery({ text: 'Сброшено на значение по умолчанию' });
    await sendScreen(ctx,
      `Готово. Текст «${EDITABLE_TEXT_LABELS[key] || key}» возвращён к значению по умолчанию:\n\n<pre>${escapeHtml(DEFAULT_TEXTS[key] || '')}</pre>`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Назад', 'admin:menu') }
    );
  });

  // --- Админ: группы и расписание (любая группа, не только своя личная) ---

  bot.callbackQuery('admin:groups', async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const groups = await listGroups();
    const kb = new InlineKeyboard();
    for (const g of groups) {
      kb.text(g.name, `admin:group:${g.id}`).row();
    }
    kb.text('➕ Создать группу', 'admin:group:create').row();
    kb.text('⬅️ Назад', 'admin:menu');
    const text = groups.length > 0 ? 'Все учебные группы:' : 'Групп пока нет.';
    await sendScreen(ctx, text, { reply_markup: kb });
  });

  bot.callbackQuery('admin:group:create', async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    await setTargetState(ctx, target, { step: 'admin_awaiting_new_group_name' });
    await sendScreen(ctx, 'Название новой группы:', { reply_markup: cancelKeyboard() });
  });

  bot.callbackQuery(/^admin:group:(\d+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const groupId = Number(ctx.match[1]);
    const group = await getGroup(groupId);
    if (!group) {
      await sendScreen(ctx, 'Эта группа уже не существует.', { reply_markup: new InlineKeyboard().text('⬅️ Назад', 'admin:groups') });
      return;
    }
    const kb = new InlineKeyboard()
      .text('📆 Семестры и расписание', `admin:group:terms:${groupId}`).row()
      .text('✏️ Переименовать', `admin:group:rename:${groupId}`).row()
      .text('🗑 Удалить группу', `admin:group:delete:ask:${groupId}`).row()
      .text('⬅️ Назад', 'admin:groups');
    await sendScreen(ctx, `<b>${escapeHtml(group.name)}</b>${formatSyncInfo(group)}`, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:group:rename:(\d+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const groupId = Number(ctx.match[1]);
    const target = getTarget(ctx);
    await setTargetState(ctx, target, { step: 'admin_awaiting_group_rename', adminGroupId: groupId });
    await sendScreen(ctx, 'Новое название группы:', { reply_markup: cancelKeyboard() });
  });

  bot.callbackQuery(/^admin:group:delete:ask:(\d+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const groupId = Number(ctx.match[1]);
    const group = await getGroup(groupId);
    if (!group) { await showAdminGroupsList(ctx); return; }
    const kb = new InlineKeyboard()
      .text('✅ Да, удалить', `admin:group:delete:confirm:${groupId}`).row()
      .text('❌ Отмена', `admin:group:${groupId}`);
    await safeEditMessageText(ctx,
      `Точно удалить группу <b>${escapeHtml(group.name)}</b> и всё её расписание?`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^admin:group:delete:confirm:(\d+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    const groupId = Number(ctx.match[1]);
    await deleteGroup(groupId);
    await ctx.answerCallbackQuery({ text: 'Группа удалена' });
    const kb = new InlineKeyboard().text('⬅️ К списку групп', 'admin:groups');
    await safeEditMessageText(ctx, 'Группа удалена.', { reply_markup: kb });
  });

  bot.callbackQuery(/^admin:group:terms:(\d+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const groupId = Number(ctx.match[1]);
    const group = await getGroup(groupId);
    if (!group) { await showAdminGroupsList(ctx); return; }
    const terms = await listTerms(groupId);
    const kb = new InlineKeyboard();
    for (const t of terms) {
      kb.text(`${t.name} (${formatDateShort(t.date_start)}–${formatDateShort(t.date_end)})`, `terms:open:${t.id}`).row();
    }
    kb.text('➕ Добавить семестр', `admin:term:add:${groupId}`).row();
    kb.text('⬅️ Назад', `admin:group:${groupId}`);
    const text = terms.length > 0
      ? `Семестры группы <b>${escapeHtml(group.name)}</b>:`
      : `У группы <b>${escapeHtml(group.name)}</b> пока нет семестров.`;
    await sendScreen(ctx, text, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery(/^admin:term:add:(\d+)$/, async (ctx) => {
    if (!requireBotAdmin(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    const groupId = Number(ctx.match[1]);
    const target = getTarget(ctx);
    await setTargetState(ctx, target, { step: 'awaiting_term_name', adminGroupId: groupId });
    await sendScreen(ctx, 'Как назвать семестр? Например: "Осень 2026" или "Весна 2027".', {
      reply_markup: cancelKeyboard(),
    });
  });

  async function showAdminGroupsList(ctx) {
    const groups = await listGroups();
    const kb = new InlineKeyboard();
    for (const g of groups) {
      kb.text(g.name, `admin:group:${g.id}`).row();
    }
    kb.text('➕ Создать группу', 'admin:group:create').row();
    kb.text('⬅️ Назад', 'admin:menu');
    await sendScreen(ctx, 'Все учебные группы:', { reply_markup: kb });
  }

  // ---------- Текстовые сообщения (шаги визарда + быстрые кнопки) ----------

  bot.on('message:text', async (ctx) => {
    const target = getTarget(ctx);
    const rawText = ctx.message.text.trim();

    // Быстрые кнопки "на сегодня/на завтра/на неделю" — работают всегда,
    // вне очереди визарда, и в личке, и в группе.
    if (rawText === QUICK_TODAY_LABEL) {
      await sendTodayDigest(ctx, target);
      return;
    }
    if (rawText === QUICK_TOMORROW_LABEL) {
      await sendTomorrowDigest(ctx, target);
      return;
    }
    if (rawText === QUICK_WEEK_LABEL) {
      await sendWeekDigest(ctx, target);
      return;
    }

    const state = target.row.state || {};

    // В групповом чате не реагируем на обычную переписку — только когда
    // реально ждём ответ по активному шагу визарда.
    if (target.kind === 'group' && !state.step) return;

    // Повторная проверка прав — на случай если кто-то другой в группе
    // отвечает на активный шаг визарда вместо админа, который его начал.
    if (target.kind === 'group' && state.step && !(await canConfigure(ctx, target))) {
      return;
    }

    const text = rawText;

    switch (state.step) {
      case 'admin_awaiting_text': {
        if (!requireBotAdmin(ctx)) { await showMainMenu(ctx); return; }
        await setText(state.textKey, ctx.message.text);
        await setTargetState(ctx, target, {});
        await ctx.reply(`✅ Текст «${EDITABLE_TEXT_LABELS[state.textKey] || state.textKey}» обновлён.`, {
          reply_markup: new InlineKeyboard().text('⬅️ В админ-панель', 'admin:menu'),
        });
        break;
      }

      case 'admin_awaiting_new_group_name': {
        if (!requireBotAdmin(ctx)) { await showMainMenu(ctx); return; }
        const existing = await findGroupByName(text);
        if (existing) {
          await ctx.reply(`Группа "${text}" уже существует.`);
        } else {
          await createGroup(text, ctx.from.id);
          await ctx.reply(`✅ Создал группу "${text}".`);
        }
        await setTargetState(ctx, target, {});
        await showAdminGroupsList(ctx);
        break;
      }

      case 'admin_awaiting_group_rename': {
        if (!requireBotAdmin(ctx)) { await showMainMenu(ctx); return; }
        const renamed = await renameGroup(state.adminGroupId, text);
        await setTargetState(ctx, target, {});
        if (renamed) {
          await ctx.reply(`✅ Группа переименована в "${text}".`);
        } else {
          await ctx.reply('Эта группа уже не существует.');
        }
        await showAdminGroupsList(ctx);
        break;
      }

      case 'awaiting_new_group_name': {
        const existing = await findGroupByName(text);
        let groupId;
        if (existing) {
          groupId = existing.id;
          await ctx.reply(`Группа "${text}" уже существует — подключил(а) к ней.`);
        } else {
          const created = await createGroup(text, ctx.from.id);
          groupId = created.id;
          await ctx.reply(`Создал(а) группу "${text}". Теперь добавь для неё семестр и расписание.`);
        }
        await query(`UPDATE ${target.table} SET group_id = $1 WHERE id = $2`, [groupId, target.row.id]);
        await showMainMenu(ctx);
        break;
      }

      case 'awaiting_term_name': {
        await setTargetState(ctx, target, { step: 'awaiting_term_start', termName: text, adminGroupId: state.adminGroupId });
        await ctx.reply('С какого числа начинается семестр? Формат: 01.09.2026', { reply_markup: cancelKeyboard() });
        break;
      }

      case 'awaiting_term_start': {
        const dateStart = parseDateInput(text);
        if (!dateStart) {
          await ctx.reply('Не понял дату. Формат: 01.09.2026 (день.месяц.год). Попробуй ещё раз.');
          return;
        }
        await setTargetState(ctx, target, {
          step: 'awaiting_term_end',
          termName: state.termName,
          dateStart,
          adminGroupId: state.adminGroupId,
        });
        await ctx.reply('А по какое число (включительно)? Формат: 31.12.2026', { reply_markup: cancelKeyboard() });
        break;
      }

      case 'awaiting_term_end': {
        const dateEnd = parseDateInput(text);
        if (!dateEnd) {
          await ctx.reply('Не понял дату. Формат: 31.12.2026 (день.месяц.год). Попробуй ещё раз.');
          return;
        }
        if (dateEnd < state.dateStart) {
          await ctx.reply('Дата окончания раньше даты начала — проверь и пришли ещё раз дату окончания.');
          return;
        }
        const groupId = state.adminGroupId || target.row.group_id;
        if (!groupId) {
          await ctx.reply('Сначала выбери учебную группу.');
          await showMainMenu(ctx);
          return;
        }
        const term = await createTerm(groupId, state.termName, state.dateStart, dateEnd);
        await setTargetState(ctx, target, {});
        const kb = new InlineKeyboard()
          .text('🤖 Промпт для нейросети (по скриншоту)', `schedule:edit:ai:${term.id}`).row()
          .text('✍️ Ввести вручную по шаблону', `schedule:edit:manual:${term.id}`);
        await ctx.reply(
          `✅ Семестр «${term.name}» добавлен (${formatDateShort(term.date_start)}–${formatDateShort(term.date_end)}).\n\nЗаполним для него расписание?`,
          { reply_markup: kb }
        );
        break;
      }

      case 'awaiting_schedule_text': {
        try {
          const parsed = parseScheduleText(text);
          await replaceScheduleForTerm(state.termId, parsed);
          await ctx.reply('✅ Расписание сохранено!');
          if (requireBotAdmin(ctx) && state.adminGroupId) {
            // если правил через админ-панель — вернёмся туда, а не в личное меню
          }
          await showMainMenu(ctx);
        } catch (e) {
          await ctx.reply(`⚠️ ${e.message}\n\nПопробуй ещё раз.`);
        }
        break;
      }

      case 'awaiting_evening_time':
      case 'awaiting_morning_time': {
        const field = state.step === 'awaiting_evening_time' ? 'evening_time' : 'morning_time';
        if (text.toLowerCase() === 'выкл') {
          await query(`UPDATE ${target.table} SET ${field} = NULL WHERE id = $1`, [target.row.id]);
          await ctx.reply('Рассылка отключена.');
        } else if (isValidTime(text)) {
          await query(`UPDATE ${target.table} SET ${field} = $1, ${field}_last = $1 WHERE id = $2`, [text, target.row.id]);
          await ctx.reply(`Готово! Буду присылать в ${text}.`);
        } else {
          await ctx.reply('Не понял время. Формат: 07:30 (часы:минуты), либо "выкл".');
          return;
        }
        await showMainMenu(ctx);
        break;
      }

      case 'awaiting_timezone': {
        try {
          Intl.DateTimeFormat('en-US', { timeZone: text }).format(new Date());
          await query(`UPDATE ${target.table} SET timezone = $1 WHERE id = $2`, [text, target.row.id]);
          await ctx.reply(`Часовой пояс установлен: ${text}`);
        } catch {
          await ctx.reply('Не распознал часовой пояс. Пример правильного: Europe/Moscow');
          return;
        }
        await showMainMenu(ctx);
        break;
      }

      case 'awaiting_teacher_search': {
        await runTeacherSearch(ctx, target, text);
        break;
      }

      default: {
        if (target.kind === 'private') await showMainMenu(ctx);
      }
    }
  });

  return bot;
}
