import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import { query } from './db.js';
import {
  findGroupByName,
  createGroup,
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
import { formatFullSchedule } from './format.js';
import { isValidTime, formatDateShort, parseDateInput, nowInTimezone } from './time.js';
import { buildTodayDigest, buildTomorrowDigest } from './digest.js';
import { getText, setText, resetText, EDITABLE_TEXT_LABELS, DEFAULT_TEXTS } from './texts.js';

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
const DEFAULT_MORNING_TIME = '07:30';
const DEFAULT_EVENING_TIME = '20:00';

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

  // ---------- Главное меню ----------

  function mainMenuKeyboard() {
    return new InlineKeyboard()
      .text('📨 Расписание на сегодня', 'menu:today')
      .text('📨 На завтра', 'menu:tomorrow')
      .row()
      .text('👥 Учебная группа', 'menu:group').row()
      .text('📅 Расписание', 'menu:schedule').row()
      .text('⏰ Время рассылок', 'menu:times').row()
      .text('❓ Помощь', 'menu:help');
  }

  async function showMainMenu(ctx) {
    const target = getTarget(ctx);
    await setTargetState(ctx, target, {});
    const text = target.kind === 'private' ? await getText('welcome') : await getText('group_welcome');
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() });
  }

  bot.command(['start', 'setup', 'menu'], async (ctx) => {
    await showMainMenu(ctx);
  });

  bot.command('help', async (ctx) => {
    const target = getTarget(ctx);
    const text = target.kind === 'private' ? await getText('help') : await getText('group_welcome');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.command('today', async (ctx) => {
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildTodayDigest(target.row.group_id, target.row.timezone);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.command('tomorrow', async (ctx) => {
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildTomorrowDigest(target.row.group_id, target.row.timezone);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('menu:main', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
  });

  bot.callbackQuery('menu:help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    const text = target.kind === 'private' ? await getText('help') : await getText('group_welcome');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('menu:today', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildTodayDigest(target.row.group_id, target.row.timezone);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('menu:tomorrow', async (ctx) => {
    await ctx.answerCallbackQuery();
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }
    const text = await buildTomorrowDigest(target.row.group_id, target.row.timezone);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // ---------- Учебная группа ----------

  async function currentGroupName(target) {
    if (!target.row.group_id) return null;
    const { rows } = await query('SELECT name FROM groups WHERE id = $1', [target.row.group_id]);
    return rows[0]?.name || null;
  }

  async function showGroupMenu(ctx, { edit = false } = {}) {
    const target = getTarget(ctx);
    const kb = new InlineKeyboard()
      .text('🔍 Выбрать существующую', 'group:pick').row()
      .text('➕ Создать новую', 'group:create').row();

    const currentName = await currentGroupName(target);
    if (currentName) {
      kb.text('🗑 Удалить группу', 'group:delete:ask').row();
    }
    kb.text('⬅️ Назад', 'menu:main');

    const text = currentName
      ? `Текущая учебная группа: <b>${currentName}</b>\n\nМожешь выбрать другую, создать новую или удалить эту (расписание и все семестры удалятся для всех, кто ей пользуется).`
      : 'Учебная группа ещё не выбрана.';

    if (edit) {
      await safeEditMessageText(ctx, text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  bot.callbackQuery('menu:group', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGroupMenu(ctx);
  });

  bot.callbackQuery('group:create', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_new_group_name' });
    await ctx.reply('Напиши название новой учебной группы (например: ИС-21):');
  });

  bot.callbackQuery('group:pick', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const groups = await listGroups();
    if (groups.length === 0) {
      await ctx.reply('Пока нет ни одной созданной группы. Создай первую!');
      return;
    }
    const kb = new InlineKeyboard();
    for (const g of groups) {
      kb.text(g.name, `group:set:${g.id}`).row();
    }
    kb.text('⬅️ Назад', 'menu:group');
    await ctx.reply('Выбери учебную группу:', { reply_markup: kb });
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
    const currentName = await currentGroupName(target);
    if (!currentName) {
      await showGroupMenu(ctx, { edit: true });
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Да, удалить', 'group:delete:confirm').row()
      .text('❌ Отмена', 'menu:group');
    await safeEditMessageText(ctx, 
      `Точно удалить группу <b>${currentName}</b>? Расписание и все семестры удалятся безвозвратно, у всех подписчиков группа снимется.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery('group:delete:confirm', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    const groupId = target.row.group_id;
    if (!groupId) {
      await ctx.answerCallbackQuery();
      await showGroupMenu(ctx, { edit: true });
      return;
    }
    await query('DELETE FROM groups WHERE id = $1', [groupId]);
    await refreshTarget(target);
    await ctx.answerCallbackQuery({ text: 'Группа удалена' });
    await showGroupMenu(ctx, { edit: true });
  });

  // ---------- Расписание: просмотр ----------

  async function showScheduleMenu(ctx) {
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу в меню «Учебная группа».');
      return;
    }

    const { dateKey } = nowInTimezone(target.row.timezone);
    const relevant = await getRelevantTermForViewing(target.row.group_id, dateKey);

    const kb = new InlineKeyboard()
      .text('📆 Семестры', 'terms:list').row()
      .text('✏️ Заполнить/изменить расписание', 'schedule:edit:pick').row()
      .text('⬅️ Назад', 'menu:main');

    if (!relevant) {
      await ctx.reply(
        'Для этой группы ещё не добавлено ни одного семестра. Начни с кнопки «📆 Семестры».',
        { reply_markup: kb }
      );
      return;
    }

    const byDay = await getFullScheduleForTerm(relevant.term.id);
    let text = formatFullSchedule(byDay, relevant.term);
    if (relevant.status === 'upcoming') {
      text = `<i>Сейчас между семестрами — показываю ближайший.</i>\n\n${text}`;
    } else if (relevant.status === 'past') {
      text = `<i>Сейчас нет активного семестра — показываю последний прошедший.</i>\n\n${text}`;
    }

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }

  bot.callbackQuery('menu:schedule', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showScheduleMenu(ctx);
  });

  // ---------- Семестры ----------

  async function showTermsList(ctx) {
    const target = getTarget(ctx);
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу.');
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

    await ctx.reply(text, { reply_markup: kb });
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
    await ctx.reply('Как назвать семестр? Например: "Осень 2026" или "Весна 2027".');
  });

  bot.callbackQuery(/^terms:open:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    const term = await getTerm(termId);
    if (!term) {
      await showTermsList(ctx);
      return;
    }
    const kb = new InlineKeyboard()
      .text('✏️ Заполнить расписание этого семестра', `schedule:edit:term:${term.id}`).row()
      .text('🗑 Удалить семестр', `terms:delete:ask:${term.id}`).row()
      .text('⬅️ Назад', 'terms:list');
    await ctx.reply(
      `<b>${term.name}</b>\n${formatDateShort(term.date_start)} – ${formatDateShort(term.date_end)}`,
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
      `Точно удалить семестр <b>${term.name}</b> и всё его расписание?`,
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

  bot.callbackQuery('schedule:edit:pick', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    if (!target.row.group_id) {
      await ctx.reply('Сначала выбери учебную группу.');
      return;
    }
    const terms = await listTerms(target.row.group_id);
    if (terms.length === 0) {
      await setTargetState(ctx, target, { step: 'awaiting_term_name' });
      await ctx.reply(
        'Сначала добавь семестр (период обучения) — например, "Осень 2026".\nКак его назвать?'
      );
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of terms) {
      kb.text(`${t.name} (${formatDateShort(t.date_start)}–${formatDateShort(t.date_end)})`, `schedule:edit:term:${t.id}`).row();
    }
    kb.text('➕ Новый семестр', 'terms:add').row();
    kb.text('⬅️ Назад', 'menu:schedule');
    await ctx.reply('Для какого семестра заполняем расписание?', { reply_markup: kb });
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
    await ctx.reply(
      'Как удобнее заполнить расписание этого семестра?',
      { reply_markup: kb }
    );
  });

  bot.callbackQuery(/^schedule:edit:manual:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    await setTargetState(ctx, target, { step: 'awaiting_schedule_text', termId });
    await ctx.reply(
      [
        'Пришли расписание одним сообщением по такому шаблону:',
        '',
        `<pre>${scheduleTemplate()}</pre>`,
        '',
        'Аудитория и преподаватель — необязательны (раздели их через "|").',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery(/^schedule:edit:ai:(\d+)$/, async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    const termId = Number(ctx.match[1]);
    await setTargetState(ctx, target, { step: 'awaiting_schedule_text', termId });
    await ctx.reply(
      [
        '1️⃣ Скопируй промпт ниже.',
        '2️⃣ Открой любую нейросеть (Claude, ChatGPT и т.п.), вставь промпт и приложи скриншот своего расписания.',
        '3️⃣ Ответ нейросети целиком пришли сюда, мне, одним сообщением — я его сохраню.',
      ].join('\n')
    );
    await ctx.reply(`<pre>${aiPromptTemplate()}</pre>`, { parse_mode: 'HTML' });
  });

  // ---------- Обработка фото (только в личке — в группе не спамим) ----------

  bot.on('message:photo', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(
      [
        'Сам я скриншот не прочитаю 🙈, но это легко решить через любую нейросеть:',
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

  async function showTimesMenu(ctx, { edit = false } = {}) {
    const target = getTarget(ctx);
    const text = 'Настрой время ежедневных напоминаний.\n\nНажми на время, чтобы изменить его, или на переключатель, чтобы включить/выключить рассылку.';
    const kb = timesMenuKeyboard(target.row);
    if (edit) {
      await safeEditMessageText(ctx, text, { reply_markup: kb });
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
  }

  bot.callbackQuery('menu:times', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTimesMenu(ctx);
  });

  // Мгновенное включение/выключение без ввода времени — жмёшь и сообщение
  // сразу обновляется на месте (без нового сообщения).
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
    await showTimesMenu(ctx, { edit: true });
  });

  bot.callbackQuery('time:set:evening', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_evening_time' });
    await ctx.reply('Во сколько присылать расписание на завтра вечером? Формат: 20:00\n(Напиши "выкл", чтобы отключить)');
  });

  bot.callbackQuery('time:set:morning', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_morning_time' });
    await ctx.reply('Во сколько присылать расписание на сегодня утром? Формат: 07:30\n(Напиши "выкл", чтобы отключить)');
  });

  bot.callbackQuery('time:set:tz', async (ctx) => {
    const target = getTarget(ctx);
    if (await denyIfNotAllowed(ctx, target)) return;
    await ctx.answerCallbackQuery();
    await setTargetState(ctx, target, { step: 'awaiting_timezone' });
    await ctx.reply(
      'Напиши свой часовой пояс в формате IANA, например:\nEurope/Moscow, Asia/Yekaterinburg, Europe/Kaliningrad'
    );
  });

  // ---------- Админ-панель бота (только личка, только BOT_ADMIN_IDS) ----------

  function adminMenuKeyboard() {
    const kb = new InlineKeyboard();
    for (const [key, label] of Object.entries(EDITABLE_TEXT_LABELS)) {
      kb.text(`✏️ ${label}`, `admin:edit:${key}`).row();
    }
    return kb;
  }

  bot.command('admin', async (ctx) => {
    if (ctx.chat.type !== 'private' || !isBotAdmin(ctx.from.id)) return;
    await ctx.reply(
      '🛠 <b>Админ-панель</b>\n\nВыбери, какой текст бота отредактировать:',
      { parse_mode: 'HTML', reply_markup: adminMenuKeyboard() }
    );
  });

  bot.callbackQuery(/^admin:edit:(\w+)$/, async (ctx) => {
    if (ctx.chat.type !== 'private' || !isBotAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const key = ctx.match[1];
    await ctx.answerCallbackQuery();
    const current = await getText(key);
    const target = getTarget(ctx);
    await setTargetState(ctx, target, { step: 'admin_awaiting_text', textKey: key });
    const kb = new InlineKeyboard().text('↩️ Сбросить на значение по умолчанию', `admin:reset:${key}`);
    await ctx.reply(
      [
        `Текущий текст «${EDITABLE_TEXT_LABELS[key] || key}»:`,
        '',
        `<pre>${current}</pre>`,
        '',
        'Пришли новый текст одним сообщением (поддерживается HTML-разметка Telegram: &lt;b&gt;, &lt;i&gt;, &lt;code&gt; и т.д.), либо нажми кнопку ниже, чтобы вернуть текст по умолчанию.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^admin:reset:(\w+)$/, async (ctx) => {
    if (ctx.chat.type !== 'private' || !isBotAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const key = ctx.match[1];
    await resetText(key);
    const target = getTarget(ctx);
    await setTargetState(ctx, target, {});
    await ctx.answerCallbackQuery({ text: 'Сброшено на значение по умолчанию' });
    await ctx.reply(`Готово. Текст «${EDITABLE_TEXT_LABELS[key] || key}» возвращён к значению по умолчанию:\n\n<pre>${DEFAULT_TEXTS[key] || ''}</pre>`, { parse_mode: 'HTML' });
  });

  // ---------- Текстовые сообщения (шаги визарда) ----------

  bot.on('message:text', async (ctx) => {
    const target = getTarget(ctx);
    const state = target.row.state || {};

    // В групповом чате не реагируем на обычную переписку — только когда
    // реально ждём ответ по активному шагу визарда.
    if (target.kind === 'group' && !state.step) return;

    // Повторная проверка прав — на случай если кто-то другой в группе
    // отвечает на активный шаг визарда вместо админа, который его начал.
    if (target.kind === 'group' && state.step && !(await canConfigure(ctx, target))) {
      return;
    }

    const text = ctx.message.text.trim();

    switch (state.step) {
      case 'admin_awaiting_text': {
        if (ctx.chat.type !== 'private' || !isBotAdmin(ctx.from.id)) {
          await showMainMenu(ctx);
          return;
        }
        await setText(state.textKey, ctx.message.text);
        await setTargetState(ctx, target, {});
        await ctx.reply(`✅ Текст «${EDITABLE_TEXT_LABELS[state.textKey] || state.textKey}» обновлён.`);
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
        await setTargetState(ctx, target, { step: 'awaiting_term_start', termName: text });
        await ctx.reply('С какого числа начинается семестр? Формат: 01.09.2026');
        break;
      }

      case 'awaiting_term_start': {
        const dateStart = parseDateInput(text);
        if (!dateStart) {
          await ctx.reply('Не понял дату. Формат: 01.09.2026 (день.месяц.год). Попробуй ещё раз.');
          return;
        }
        await setTargetState(ctx, target, { step: 'awaiting_term_end', termName: state.termName, dateStart });
        await ctx.reply('А по какое число (включительно)? Формат: 31.12.2026');
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
        if (!target.row.group_id) {
          await ctx.reply('Сначала выбери учебную группу.');
          await showMainMenu(ctx);
          return;
        }
        const term = await createTerm(target.row.group_id, state.termName, state.dateStart, dateEnd);
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

      default: {
        if (target.kind === 'private') await showMainMenu(ctx);
      }
    }
  });

  return bot;
}
