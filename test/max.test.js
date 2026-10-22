// Запуск: npm test — без базы и интернета: проверяем перевод клавиатур в формат
// MAX и то, как обвязка MAX разбирает обновления и отвечает на нажатия.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InlineKeyboard } from 'grammy';
import { toMaxKeyboard, maxText, setMaxTransport, maxWebhookSecret } from '../lib/max.js';
import { MaxBot } from '../lib/maxBot.js';

test('клавиатура Telegram → inline_keyboard MAX', () => {
  const kb = new InlineKeyboard()
    .text('◀️', 'd:20261021').text(' ', 'noop').row()
    .url('Написать', 'https://t.me/temniy_prinz').row();
  const att = toMaxKeyboard(kb);
  assert.equal(att.type, 'inline_keyboard');
  assert.deepEqual(att.payload.buttons, [
    [{ type: 'callback', text: '◀️', payload: 'd:20261021' }, { type: 'callback', text: '·', payload: 'noop' }],
    [{ type: 'link', text: 'Написать', url: 'https://t.me/temniy_prinz' }],
  ]);
  assert.equal(toMaxKeyboard(undefined), null);
});

test('кастомные эмодзи Telegram в MAX превращаются в обычные', () => {
  assert.equal(maxText('<tg-emoji emoji-id="1">👤</tg-emoji> <b>Иванов</b>'), '👤 <b>Иванов</b>');
});

test('секрет вебхука подходит под правила MAX', () => {
  process.env.MAX_BOT_TOKEN = 'abc';
  assert.match(maxWebhookSecret(), /^[a-zA-Z0-9_-]{5,256}$/);
});

test('MaxBot: команды, кнопки и ответ на нажатие одним вызовом', async () => {
  const calls = [];
  setMaxTransport(async (method, path, opts) => {
    calls.push({ method, path, ...opts });
    return method === 'POST' && path === '/messages' ? { message: { body: { mid: 'mid.1' } } } : { success: true };
  });
  const bot = new MaxBot();
  const seen = [];
  bot.use(async (ctx, next) => { ctx.seen = true; await next(); });
  bot.command(['start', 'menu'], async (ctx) => { seen.push(['start', ctx.chat.type, ctx.from.id]); await ctx.reply('<b>меню</b>'); });
  bot.command('teacher', async (ctx) => { seen.push(['teacher', ctx.match]); });
  bot.callbackQuery(/^d:(\d{8})$/, async (ctx) => {
    seen.push(['day', ctx.match[1]]);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('день', { reply_markup: new InlineKeyboard().text('Назад', 'm') });
  });
  bot.callbackQuery('noop', async (ctx) => { await ctx.answerCallbackQuery(); });
  bot.on('message', async (ctx) => { seen.push(['text', ctx.message.text]); });

  const user = { user_id: 7, first_name: 'А', is_bot: false };
  const dialog = { chat_id: 70, chat_type: 'dialog', user_id: 7 };
  await bot.handleUpdate({ update_type: 'bot_started', chat_id: 70, user });
  await bot.handleUpdate({ update_type: 'message_created', message: { sender: user, recipient: dialog, body: { mid: 'u1', text: '/teacher Иванов' } } });
  await bot.handleUpdate({ update_type: 'message_created', message: { sender: user, recipient: dialog, body: { mid: 'u2', text: '20.10' } } });
  await bot.handleUpdate({ update_type: 'message_callback', callback: { callback_id: 'c1', payload: 'd:20261020', user }, message: { recipient: dialog, body: { mid: 'mid.1' } } });
  await bot.handleUpdate({ update_type: 'message_callback', callback: { callback_id: 'c2', payload: 'noop', user }, message: { recipient: dialog, body: { mid: 'mid.1' } } });
  await bot.handleUpdate({ update_type: 'message_created', message: { sender: { ...user, is_bot: true }, recipient: dialog, body: { mid: 'b', text: 'от бота' } } });

  assert.deepEqual(seen, [['start', 'private', 7], ['teacher', 'Иванов'], ['text', '20.10'], ['day', '20261020']]);
  assert.deepEqual(calls[0].query, { user_id: 7, disable_link_preview: true });
  const answers = calls.filter((c) => c.path === '/answers');
  assert.equal(answers.length, 2, 'на каждое нажатие ровно один ответ');
  assert.equal(answers[0].query.callback_id, 'c1');
  assert.equal(answers[0].body.message.text, 'день');
  assert.equal(answers[0].body.message.attachments[0].payload.buttons[0][0].payload, 'm');
  assert.deepEqual(answers[1].body, {});
  setMaxTransport(null);
});
