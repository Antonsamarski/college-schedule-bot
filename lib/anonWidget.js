import { GrammyError } from 'grammy';

// Telegram Web Widgets run in QuickJS with a restricted DOM and no fetch.
const STYLE = `<style>
main{padding:12px;background:var(--tg-theme-secondary-bg-color);border-radius:12px}
h2{font-size:1.15em;margin:0 0 4px}p{margin:0}[hidden]{display:none}
.note,dt{color:var(--tg-theme-subtitle-text-color,var(--tg-theme-text-color))}
dl{display:flex;gap:8px;margin:12px 0}dl div{flex:1;padding:8px;background:var(--tg-theme-bg-color);border-radius:8px}
dd{margin:0;font-size:1.25em;font-weight:700}button{width:100%;padding:10px;min-height:44px}
</style>`;

const HOME = `${STYLE}
<main>
<h2>Анонимки</h2>
<p id="window" class="note"></p>
<dl id="counts" hidden>
<div><dt>Получено</dt><dd id="got"></dd></div>
<div><dt>Отправлено</dt><dd id="sent"></dd></div>
</dl>
<button id="copy" type="button" hidden>Скопировать ссылку</button>
</main>
<script>
const W = window.TelegramWidget;
const byId = (id) => document.getElementById(id);
const state = JSON.parse(W.chatData || '{}');
const open = Boolean(state.until);
byId('window').textContent = open ? 'Открыто до ' + state.until : 'Сейчас закрыто';
if (open) {
  byId('got').textContent = String(state.got);
  byId('sent').textContent = String(state.sent);
  byId('counts').removeAttribute('hidden');
}
if (open && state.link) {
  const copy = byId('copy');
  copy.removeAttribute('hidden');
  copy.addEventListener('click', () => W.copyText(state.link));
}
W.ready();
</script>`;

function panel(title, note) {
  return `${STYLE}<main><h2>${title}</h2><p class="note">${note}</p></main>`;
}

export function anonHomeWidget({ until, link, got, sent }) {
  const caption = until
    ? [
        `Анонимки открыты до ${until} · получено ${got}, отправлено ${sent}`,
        link && `Твоя ссылка: ${link}`,
        'Владелец бота видит автора при жалобе.',
      ].filter(Boolean).join('\n')
    : 'Анонимки сейчас закрыты. Бот сообщит об открытии.';
  return { html: HOME, chat_data: JSON.stringify({ until, link, got, sent }), caption };
}

export function anonComposeWidget(reply, maxLength) {
  const title = reply ? 'Анонимный ответ' : 'Новое анонимное сообщение';
  const note = `Введи текст в поле чата · до ${maxLength} символов`;
  return {
    html: panel(title, note),
    caption: `${title}. ${note}. Получатель не увидит имя. Владелец бота видит автора при жалобе.`,
  };
}

export function anonIncomingWidget(reply, body) {
  const title = reply ? 'Анонимный ответ' : 'Анонимное сообщение';
  return {
    html: panel(title, 'Ответ и жалоба доступны под сообщением'),
    caption: `${title}\n\n${body}`,
  };
}

export async function tryAnonWidget(api, chatId, widget, keyboard) {
  if (process.env.TELEGRAM_ANON_WIDGETS !== '1' || !api) return null;
  try {
    return await api.raw.sendWidget({
      chat_id: chatId,
      ...widget,
      protect_content: true,
      reply_markup: { inline_keyboard: keyboard.inline_keyboard.filter((row) => row.length) },
    });
  } catch (error) {
    // A widget method rejected by Telegram can safely fall back to a text message.
    // A transport error is ambiguous: retrying delivery could duplicate a message.
    if (!(error instanceof GrammyError) || ![400, 404, 405, 501].includes(error.error_code)) throw error;
    console.warn('Telegram rejected sendWidget; using text fallback', error.error_code);
    return null;
  }
}
