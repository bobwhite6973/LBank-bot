const { EventEmitter } = require('events');
const config = require('../../config/config');

/**
 * TelegramChannelSource (LBank Futures)
 * ---------------------------------------
 * Parses trading signal messages from alpha channels.
 * For futures, looks for: pair names, LONG/SHORT direction, leverage mentions.
 *
 * Common signal formats:
 *   🟢 LONG BTC/USDT — Entry: 65000, TP: 68000, SL: 63000
 *   🔴 SHORT ETH — target 3200
 *   BTC LONG 4x — entry now
 *   ⚠️ Close BTC position
 */
class TelegramChannelSource extends EventEmitter {
  constructor() {
    super();
    this.client        = null;
    this.channels      = new Set();
    this.ready         = false;
    this.sessionString = config.TG_SESSION || '';
    this.recentSignals = new Map();
    this._pendingLogin = null;

    // Symbol map for channel message parsing
    this.symbols = [
      'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX',
      'LINK', 'DOT', 'MATIC', 'ARB', 'OP', 'SUI', 'APT', 'LTC',
      'ATOM', 'NEAR', 'FTM', 'INJ', 'TIA', 'SEI',
    ];
  }

  isReady()  { return this.ready; }
  addChannel(u) { this.channels.add(String(u).toLowerCase().replace('@', '')); }
  removeChannel(u) { this.channels.delete(String(u).toLowerCase().replace('@', '')); }
  listChannels() { return Array.from(this.channels); }

  async requestCode(apiId, apiHash, phone) {
    const { TelegramClient } = require('telegram');
    const { StringSession }  = require('telegram/sessions');
    const session = new StringSession(this.sessionString);
    const client  = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    if (await client.isUserAuthorized()) { this._finalize(client); return; }
    this._pendingLogin = { client, phone, apiId, apiHash };
    await client.sendCode({ apiId, apiHash }, phone);
  }

  async completeLogin(code) {
    if (!this._pendingLogin) throw new Error('Call requestCode first.');
    const { client, phone, apiId, apiHash } = this._pendingLogin;
    await client.signInUser({ apiId, apiHash }, {
      phoneNumber: async () => phone,
      password:    async () => { throw new Error('2FA not supported — disable 2FA first.'); },
      phoneCode:   async () => code,
      onError:     (e)    => { throw e; },
    });
    this._finalize(client);
    return this.sessionString;
  }

  _finalize(client) {
    this.client        = client;
    this.sessionString = client.session.save();
    this.ready         = true;
    this._pendingLogin = null;
    const { NewMessage } = require('telegram/events');
    client.addEventHandler(async (event) => {
      try { await this._handleMessage(event.message); } catch (_) {}
    }, new NewMessage({}));
    console.log('[TelegramChannel] ready');
  }

  async _handleMessage(message) {
    if (!message?.text) return;
    let identifier = '', channelTitle = '';
    try {
      const chat   = await message.getChat();
      identifier   = (chat.username || String(chat.id)).toLowerCase();
      channelTitle = chat.title || chat.username || identifier;
    } catch { return; }

    if (!this.channels.has(identifier) && !this.channels.has(String(message.chatId))) return;

    const text    = message.text;
    const symbol  = this._extractSymbol(text);
    if (!symbol) return;

    const lbPair  = `${symbol}_USDT`;
    const dedupKey = `${identifier}:${lbPair}`;
    const lastSeen = this.recentSignals.get(dedupKey);
    if (lastSeen && Date.now() - lastSeen < 5 * 60 * 1000) return;
    this.recentSignals.set(dedupKey, Date.now());

    const direction = this._parseDirection(text);
    const score     = this._scoreMessage(text, direction);

    if (score === 0) return;

    this.emit('signal', {
      token:     lbPair,
      symbol:    lbPair,
      action:    'BUY',
      direction,
      score,
      reason:    `${channelTitle}: ${text.slice(0, 100).replace(/\n/g, ' ')}`,
      raw:       text,
      source:    'telegram',
      channelTitle,
    });
  }

  _extractSymbol(text) {
    const upper = text.toUpperCase();
    for (const sym of this.symbols) {
      if (upper.includes(sym)) return sym;
    }
    return null;
  }

  _parseDirection(text) {
    const upper = text.toUpperCase();
    const shorts = ['SHORT', 'SELL', '🔴', 'BEARISH', 'PUT', 'DOWN', 'DUMP'];
    const longs  = ['LONG', 'BUY', '🟢', '🚀', 'BULLISH', 'CALL', 'PUMP', 'UP'];
    for (const kw of shorts) if (upper.includes(kw)) return 'SHORT';
    for (const kw of longs)  if (upper.includes(kw)) return 'LONG';
    return 'LONG'; // default
  }

  _scoreMessage(text, direction) {
    const upper = text.toUpperCase();
    let score = 2; // base score for any signal
    if (/TP\s*[:=]?\s*[\d.]+/i.test(text))  score += 1; // has take profit level
    if (/SL\s*[:=]?\s*[\d.]+/i.test(text))  score += 1; // has stop loss level
    if (/ENTRY\s*[:=]?\s*[\d.]+/i.test(text)) score += 1;
    if (/\d+X/i.test(text))                  score += 1; // mentions leverage
    if (upper.includes('SAFE') || upper.includes('LOW RISK')) score += 1;
    if (upper.includes('SCAM') || upper.includes('FAKE'))     score  = 0;
    return Math.max(0, score);
  }
}

module.exports = { TelegramChannelSource };
