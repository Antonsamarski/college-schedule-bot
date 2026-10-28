/**
 * Маленькая обвязка над API MAX с тем же интерфейсом, что у grammy:
 * bot.use / command / callbackQuery / on('message') / catch, а в обработчиках
 * ctx.reply, ctx.editMessageText, ctx.answerCallbackQuery и т.д.
 *
 * Благодаря этому все экраны бота из lib/bot.js работают в MAX без
 * переписывания: обработчики не знают, из какого мессенджера пришло нажатие.
 * Клавиатуры строятся как в Telegram (grammy InlineKeyboard) и переводятся в
 * формат MAX при отправке (lib/max.js → toMaxKeyboard).
 */
import { maxSend, maxEdit, maxDelete, maxAnswer, maxBody, maxChatAdmins } from './max.js';

/** Пользователь MAX → объект в духе Telegram from. */
function toFrom(user) {
  if (!user) return null;
  const first = user.first_name || user.name || '';
  return {
    id: user.user_id,
    first_name: first,
    last_name: user.last_name || undefined,
    username: user.username || undefined,
    is_bot: Boolean(user.is_bot),
  };
}

/** Чат MAX → объект в духе Telegram chat. dialog → private, chat → group. */
function toChat(chatId, chatType, title) {
  if (chatType === 'dialog') return { id: chatId, type: 'private' };
  if (chatType === 'chat') return { id: chatId, type: 'group', title: title || undefined };
  return { id: chatId, type: 'channel' };
}

export class MaxContext {
  constructor(update) {
    this.update = update;
    this.platform = 'max';
    this.match = undefined;
    this._callbackAnswered = true;

    const t = update.update_type;
    if (t === 'message_created') {
      const m = update.message;
      this.from = toFrom(m.sender);
      this.chat = toChat(m.recipient?.chat_id, m.recipient?.chat_type);
      this._userId = m.sender?.user_id;
      this.message = {
        message_id: m.body?.mid,
        text: m.body?.text ?? undefined,
        attachments: m.body?.attachments || [],
        reply_to_message: m.link?.type === 'reply' ? { text: m.link.message?.text } : undefined,
      };
    } else if (t === 'message_callback') {
      const m = update.message;
      this.from = toFrom(update.callback.user);
      this.chat = toChat(m?.recipient?.chat_id, m?.recipient?.chat_type);
      this._userId = update.callback.user?.user_id;
      this.callbackQuery = {
        id: update.callback.callback_id,
        data: update.callback.payload ?? '',
        message: m ? { message_id: m.body?.mid } : undefined,
      };
      this._callbackAnswered = false;
    } else if (t === 'bot_started' || t === 'bot_added') {
      this.from = toFrom(update.user);
      // bot_started приходит только из личного диалога, bot_added — из группы.
      this.chat = toChat(update.chat_id, t === 'bot_started' ? 'dialog' : (update.is_channel ? 'channel' : 'chat'));
      this._userId = update.user?.user_id;
      // Как будто пользователь написал /start — дальше всё как в Telegram.
      // payload из deep-link (?startapp=<token>) превращаем в «/start <token>».
      const p = (update.payload || '').trim();
      this.message = { message_id: null, text: p ? `/start ${p}` : '/start', attachments: [], synthetic: true };
    }

    const self = this;
    this.api = {
      deleteMessage: (_chatId, mid) => maxDelete(mid),
      sendMessage: (_chatId, text, extra = {}) => self.reply(text, extra),
    };
  }

  /** Куда отвечать: в личке — по user_id, в группе — по chat_id. */
  get recipient() {
    return this.chat?.type === 'private' ? { userId: this._userId } : { chatId: this.chat?.id };
  }

  async reply(text, extra = {}) {
    const { mid, message } = await maxSend(this.recipient, text, extra.reply_markup);
    return { message_id: mid, raw: message };
  }

  /**
   * Редактирование сообщения, на кнопке которого нажали. Если на нажатие ещё
   * не ответили — отвечаем и меняем сообщение одним вызовом /answers.
   */
  async editMessageText(text, extra = {}) {
    if (this.callbackQuery && !this._callbackAnswered) {
      this._callbackAnswered = true;
      await maxAnswer(this.callbackQuery.id, { message: maxBody(text, extra.reply_markup) });
      return true;
    }
    const mid = this.callbackQuery?.message?.message_id;
    if (!mid) throw new Error('nothing to edit');
    await maxEdit(mid, text, extra.reply_markup);
    return true;
  }

  /**
   * Ответ на нажатие. С текстом — сразу показываем уведомление. Без текста —
   * откладываем: если следом будет editMessageText, ответим вместе с ним
   * (меньше запросов), иначе ответим пустым в конце обработки.
   */
  async answerCallbackQuery(opts) {
    if (!this.callbackQuery || this._callbackAnswered) return true;
    const text = typeof opts === 'string' ? opts : opts?.text;
    if (!text) return true;
    this._callbackAnswered = true;
    await maxAnswer(this.callbackQuery.id, { notification: text });
    return true;
  }

  async finishCallback() {
    if (this.callbackQuery && !this._callbackAnswered) {
      this._callbackAnswered = true;
      await maxAnswer(this.callbackQuery.id).catch((e) => console.error('MAX answer failed', e.description || e));
    }
  }

  /** Сообщения пользователя в MAX бот удалить не может — тихо пропускаем. */
  async deleteMessage() {
    if (!this.message?.message_id || this.chat?.type === 'private') return false;
    await maxDelete(this.message.message_id);
    return true;
  }

  async getChatAdministrators() {
    const admins = await maxChatAdmins(this.chat.id);
    return admins.map((a) => ({
      status: a.is_owner ? 'creator' : 'administrator',
      user: { id: a.user_id, is_bot: Boolean(a.is_bot), first_name: a.first_name || a.name || a.alias || 'admin', username: a.username },
    }));
  }

  async getChatMember(userId) {
    const admins = await maxChatAdmins(this.chat.id);
    const a = admins.find((m) => Number(m.user_id) === Number(userId));
    return { status: a ? (a.is_owner ? 'creator' : 'administrator') : 'member' };
  }
}

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/;

export class MaxBot {
  constructor() {
    this.middlewares = [];
    this.commands = [];
    this.callbacks = [];
    this.messageHandlers = [];
    this.errorHandler = (err) => console.error('MAX bot error', err.error);
    this.platform = 'max';
  }

  use(fn) { this.middlewares.push(fn); }
  catch(fn) { this.errorHandler = fn; }

  command(names, fn) {
    this.commands.push({ names: (Array.isArray(names) ? names : [names]).map((n) => n.toLowerCase()), fn });
  }

  callbackQuery(trigger, fn) { this.callbacks.push({ trigger, fn }); }

  on(filter, fn) {
    if (filter !== 'message') throw new Error(`MaxBot.on: unsupported filter ${filter}`);
    this.messageHandlers.push(fn);
  }

  async dispatch(ctx) {
    if (ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      for (const { trigger, fn } of this.callbacks) {
        if (typeof trigger === 'string' ? trigger === data : trigger.test(data)) {
          ctx.match = typeof trigger === 'string' ? data : data.match(trigger);
          return fn(ctx);
        }
      }
      return undefined;
    }
    if (ctx.message) {
      const m = (ctx.message.text || '').trim().match(COMMAND_RE);
      if (m) {
        const name = m[1].toLowerCase();
        const cmd = this.commands.find((c) => c.names.includes(name));
        if (cmd) {
          ctx.match = (m[2] || '').trim();
          return cmd.fn(ctx);
        }
      }
      for (const fn of this.messageHandlers) await fn(ctx);
    }
    return undefined;
  }

  async handleUpdate(update) {
    const ctx = new MaxContext(update);
    if (!ctx.chat || ctx.from?.is_bot) return;
    try {
      let i = 0;
      const next = async () => {
        const mw = this.middlewares[i++];
        if (mw) return mw(ctx, next);
        return this.dispatch(ctx);
      };
      await next();
    } catch (error) {
      await this.errorHandler({ ctx, error });
    } finally {
      await ctx.finishCallback();
    }
  }
}
