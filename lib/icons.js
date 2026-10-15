/**
 * Значки оформления в одном месте.
 *
 * По умолчанию — обычные эмодзи (на iPhone они выглядят как эмодзи Apple).
 * Если задать EMOJI_PACK — короткое имя набора кастомных эмодзи Telegram
 * (из ссылки t.me/addemoji/ИМЯ), бот подставит эмодзи из набора вместо
 * обычных с тем же значением. Telegram разрешает ботам кастомные эмодзи,
 * только если у владельца бота есть Telegram Premium (Bot API 9.4); если
 * нельзя — сообщение уйдёт с обычными эмодзи (см. stripCustomEmoji).
 */
export const ICON = {
  date: '🗓',
  pair: '▪️',
  teacher: '👤',
  room: '📍',
  group: '👥',
  gap: '☕️',
  now: '🔴',
  total: '🖤',
  day: '▫️',
  today: '◾️',
};

let custom = new Map(); // базовый эмодзи -> custom_emoji_id
let loadedFor = null;

const base = (ch) => ch.replace(/️/g, '');

/** Загружает набор кастомных эмодзи. getStickerSet — функция (name) => StickerSet. */
export async function loadEmojiPack(getStickerSet) {
  const name = process.env.EMOJI_PACK;
  if (!name || loadedFor === name) return;
  try {
    const set = await getStickerSet(name);
    const map = new Map();
    for (const s of set.stickers || []) {
      if (s.custom_emoji_id && s.emoji && !map.has(base(s.emoji))) map.set(base(s.emoji), s.custom_emoji_id);
    }
    custom = map;
    loadedFor = name;
  } catch (e) {
    console.error('EMOJI_PACK load failed:', e.description || e.message || e);
    loadedFor = name; // не пытаемся на каждом сообщении
  }
}

/** Значок: кастомный эмодзи из набора, если он есть, иначе обычный. */
export function ic(key) {
  const ch = ICON[key] ?? key;
  const id = custom.get(base(ch));
  return id ? `<tg-emoji emoji-id="${id}">${ch}</tg-emoji>` : ch;
}

/** Убирает кастомные эмодзи, оставляя обычные — на случай, если Telegram их не принял. */
export function stripCustomEmoji(text) {
  return text.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1');
}

export const hasCustomEmoji = (text) => /<tg-emoji/.test(text);
