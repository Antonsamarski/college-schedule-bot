import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { GrammyError } from 'grammy';
import { anonComposeWidget, anonHomeWidget, anonIncomingWidget, tryAnonWidget } from '../lib/anonWidget.js';

test('anonymous widget payloads fit Telegram limits and keep personal data out of the HTML', () => {
  const link = 'https://t.me/example_bot?start=a_abcdefgh';
  const body = 'я'.repeat(1000);
  const home = anonHomeWidget({ until: '21:30', link, got: 5, sent: 2 });
  const incoming = anonIncomingWidget(false, body);
  for (const { html } of [home, anonHomeWidget({}), anonComposeWidget(true, 1000), incoming]) {
    assert.ok(Buffer.byteLength(html) <= 32768);
    assert.ok(deflateSync(html, { level: 9 }).length <= 4096);
  }
  assert.ok(Buffer.byteLength(home.chat_data) <= 1024);
  assert.ok(!home.html.includes(link));
  assert.ok(!incoming.html.includes(body));
  assert.ok(home.caption.includes(link));
  assert.ok(incoming.caption.endsWith(body));
  assert.ok(incoming.caption.length <= 1024);
});

test('use text fallback only when widget is disabled or definitively rejected', async () => {
  const original = process.env.TELEGRAM_ANON_WIDGETS;
  const widget = anonHomeWidget({});
  const button = { text: 'Назад', callback_data: 'm' };
  const keyboard = { inline_keyboard: [[button], []] };
  const api = { raw: { sendWidget: async (params) => {
    assert.equal(params.chat_id, 12);
    assert.equal(params.protect_content, true);
    assert.deepEqual(params.reply_markup.inline_keyboard, [[button]]);
    return { message_id: 3 };
  } } };
  try {
    delete process.env.TELEGRAM_ANON_WIDGETS;
    assert.equal(await tryAnonWidget(api, 12, widget, keyboard), null);
    process.env.TELEGRAM_ANON_WIDGETS = '1';
    assert.deepEqual(await tryAnonWidget(api, 12, widget, keyboard), { message_id: 3 });
    api.raw.sendWidget = async () => {
      throw new GrammyError('API error', { ok: false, error_code: 400, description: 'unsupported' }, 'sendWidget', {});
    };
    assert.equal(await tryAnonWidget(api, 12, widget, keyboard), null);
    api.raw.sendWidget = async () => { throw new Error('connection interrupted'); };
    await assert.rejects(tryAnonWidget(api, 12, widget, keyboard), /connection interrupted/);
  } finally {
    if (original === undefined) delete process.env.TELEGRAM_ANON_WIDGETS;
    else process.env.TELEGRAM_ANON_WIDGETS = original;
  }
});
