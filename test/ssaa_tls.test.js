// Сайт с сертификатом «чужого» УЦ: обычный fetch падает, запасной путь с российским корнем работает.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { _fetchTextForTest as fetchText, _setRussianCaForTest } from '../lib/ssaa.js';

const tlsFile = (n) => readFileSync(new URL(`./fixtures/tls/${n}`, import.meta.url), 'utf8');

function startServer() {
  const server = https.createServer({ key: tlsFile('leaf.key'), cert: tlsFile('leaf.pem') }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/redir') { res.writeHead(302, { Location: '/final' }); return res.end(); }
      if (req.url === '/missing') { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()} Привет`);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('сертификат неизвестного УЦ: без корня ошибка, с корнем GET/POST/редирект работают', async () => {
  const server = await startServer();
  const base = `https://127.0.0.1:${server.address().port}`;
  try {
    // корень не добавлен → падаем с ошибкой доверия, а не зависаем
    _setRussianCaForTest('');
    await assert.rejects(fetchText(`${base}/groups`));

    _setRussianCaForTest(tlsFile('ca.pem'));
    assert.equal(await fetchText(`${base}/groups`), 'GET /groups  Привет');
    // дальше работаем уже через запасной путь
    assert.equal(
      await fetchText(`${base}/shedule`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' }),
      'POST /shedule a=1&b=2 Привет');
    assert.equal(await fetchText(`${base}/redir`), 'GET /final  Привет');
    await assert.rejects(fetchText(`${base}/missing`), /ответил 404/);
  } finally {
    _setRussianCaForTest(readFileSync(new URL('../lib/certs/russian_trusted_ca.pem', import.meta.url), 'utf8'));
    server.close();
  }
});
