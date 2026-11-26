export const SCHEDULE_WIDGET_HTML = `
<style>
main{padding:12px;border-radius:12px;background:var(--tg-theme-secondary-bg-color)}
nav,footer,.days{display:flex;gap:5px;flex-wrap:wrap}
nav{padding-bottom:12px}footer{margin-top:10px}
button{min-height:40px;padding:6px 8px;flex:1}
.active{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
h2{margin:0 0 3px;font-size:1.15em}
p{margin:4px 0}small{color:var(--tg-theme-subtitle-text-color,var(--tg-theme-text-color))}
article{margin-top:8px;padding:8px;border-radius:8px;background:var(--tg-theme-bg-color)}
article strong{display:block;margin:3px 0}
.days button{flex-basis:27%}
[hidden]{display:none}
</style>
<main>
<nav>
<button id="today" type="button">Сегодня</button>
<button id="tomorrow" type="button">Завтра</button>
<button id="week" type="button">Неделя</button>
</nav>
<h2 id="title">Расписание</h2>
<small id="group"></small>
<section id="schedule"></section>
<footer id="pages" hidden>
<button id="previous" type="button">Назад</button>
<button id="next" type="button">Дальше</button>
</footer>
<p id="status"></p>
</main>
<script>
const W = TelegramWidget;
const el = (id) => document.getElementById(id);
const selectors = [['today', 't'], ['tomorrow', 'n'], ['week', 'w']];
let state = JSON.parse(W.chatData);
let pending = false;
function add(parent, tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  parent.appendChild(node);
  return node;
}
function open(route) {
  if (pending) return;
  pending = true;
  el('status').textContent = 'Загрузка…';
  W.request('schedule:' + route).then((answer) => {
    const data = JSON.parse(answer.result);
    if (!data || data.error) {
      el('status').textContent = data && data.error || 'Расписание временно недоступно';
      return;
    }
    state = data;
    el('status').textContent = '';
    render();
  }).catch(() => {
    el('status').textContent = 'Не удалось обновить. Повтори или открой обычное расписание ниже.';
  }).finally(() => { pending = false; });
}
function show(id, visible) {
  if (visible) el(id).removeAttribute('hidden');
  else el(id).setAttribute('hidden', '');
}
function render() {
  const route = state.route;
  const tab = route.startsWith('d') ? 'w' : route;
  for (const [id, key] of selectors) el(id).className = tab === key ? 'active' : '';
  el('title').textContent = state.title;
  el('group').textContent = state.group;
  const list = el('schedule');
  list.textContent = '';
  if (state.days) {
    const days = add(list, 'div', '');
    days.className = 'days';
    state.days.forEach(([label, count], i) => {
      const button = add(days, 'button', label + ' · ' + count);
      button.addEventListener('click', () => open('d' + i + ':0'));
    });
  } else if (!state.lessons.length) {
    add(list, 'p', state.empty);
  } else {
    for (const [time, name, teacher, room, type, subgroup] of state.lessons) {
      const row = add(list, 'article', '');
      add(row, 'small', time + (subgroup ? ' · подгр. ' + subgroup : ''));
      add(row, 'strong', name);
      if (teacher || room || type) add(row, 'small', [teacher, room, type].filter(Boolean).join(' · '));
    }
    if (state.pages > 1) add(list, 'p', (state.page + 1) + ' / ' + state.pages);
  }
  show('pages', state.pages > 1);
  show('previous', state.page > 0);
  show('next', state.page + 1 < state.pages);
}
for (const [id, route] of selectors) {
  el(id).addEventListener('click', () => open(route === 'w' ? route : route + ':0'));
}
el('previous').addEventListener('click', () => {
  if (state.page > 0) open(state.route + ':' + (state.page - 1));
});
el('next').addEventListener('click', () => {
  if (state.page + 1 < state.pages) open(state.route + ':' + (state.page + 1));
});
render();
W.ready();
</script>`;
