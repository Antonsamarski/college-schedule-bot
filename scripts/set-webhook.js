// Запуск: node scripts/set-webhook.js https://your-project.vercel.app
// Регистрирует вебхук в Telegram, чтобы апдейты шли на api/webhook.

const url = process.argv[2];
const botToken = process.env.BOT_TOKEN;
const webhookSecret = process.env.WEBHOOK_SECRET;

if (!url || !botToken || !webhookSecret) {
  console.error(
    'Использование: BOT_TOKEN=... WEBHOOK_SECRET=... node scripts/set-webhook.js https://your-project.vercel.app'
  );
  process.exit(1);
}

const webhookUrl = `${url.replace(/\/$/, '')}/api/webhook`;

const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query', 'widget_query'],
  }),
});

const data = await resp.json();
console.log(data);
