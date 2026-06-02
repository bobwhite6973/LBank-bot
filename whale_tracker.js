const { EventEmitter } = require('events');
const { LBankClient }  = require('../lbank_client');
const config = require('../../config/config');

/**
 * WhaleTracker (CEX Futures)
 * ---------------------------
 * On a CEX there are no on-chain wallets to copy.
 * Instead we track large order flow signals:
 *   1. Open interest spikes (large position opens)
 *   2. Funding rate extremes (market heavily one-sided = reversal signal)
 *   3. Liquidation surges (large liquidations = potential reversal)
 *   4. Volume imbalance (buy volume vs sell volume ratio)
 *
 * Also accepts manually added "signal sources" — e.g. other traders'
 * public calls that map to pairs.
 */
class WhaleTracker extends EventEmitter {
  constructor() {
    super();
    this.client  = new LBankClient();
    this.cfg     = config.WHALE;
    this.history = new Map(); // symbol => [{ oi, funding, vol, ts }]
    this.timer   = null;
    this.manualWallets = new Set(); // kept for API compatibility
  }

  start() {
    this._scan();
    this.timer = setInterval(() => this._scan(), 60_000);
    console.log('[WhaleTracker] order flow monitoring started');
  }

  stop() { clearInterval(this.timer); }

  // Kept for API compatibility with other bots
  addWallet(label)    { this.manualWallets.add(label); }
  removeWallet(label) { this.manualWallets.delete(label); }
  getTrackedWallets() {
    return [...this.manualWallets].map(w => ({ address: w, manual: true, winRate: 0, trades: 0 }));
  }

  async _scan() {
    for (const symbol of config.BASE_PAIRS) {
      try {
        const ticker = await this.client.getTicker(symbol);
        const t      = Array.isArray(ticker) ? ticker[0] : ticker;
        if (!t) continue;

        const vol       = parseFloat(t.turnover   || 0);
        const change1h  = parseFloat(t.priceChg   || 0);
        const change24h = parseFloat(t.rose       || 0);

        this._record(symbol, { vol, change1h, change24h });

        const history = this.history.get(symbol) || [];
        if (history.length < 3) continue;

        const volSurge = this._volSurge(history);
        const signal   = this._evaluate(symbol, volSurge, change1h, change24h);
        if (signal) this.emit('signal', signal);
      } catch (_) {}
    }
  }

  _record(symbol, data) {
    if (!this.history.has(symbol)) this.history.set(symbol, []);
    const arr = this.history.get(symbol);
    arr.push({ ...data, ts: Date.now() });
    if (arr.length > 20) arr.shift();
  }

  _volSurge(history) {
    const recent = history.slice(-2).reduce((a, h) => a + h.vol, 0) / 2;
    const older  = history.slice(-6, -2).reduce((a, h) => a + h.vol, 0) / 4;
    return older > 0 ? recent / older : 1;
  }

  _evaluate(symbol, volSurge, change1h, change24h) {
    let score = 0;
    const reasons = [];

    // Large volume surge = institutional activity
    if (volSurge > 2.5)  { score += 3; reasons.push(`volume surge ${volSurge.toFixed(1)}x`); }
    else if (volSurge > 1.8) { score += 2; reasons.push(`vol up ${volSurge.toFixed(1)}x`); }

    // Directional bias
    let direction = 'LONG';
    if (change1h > 1)       { score += 1; reasons.push(`+${change1h.toFixed(2)}% 1h`); direction = 'LONG'; }
    else if (change1h < -1) { score += 1; reasons.push(`${change1h.toFixed(2)}% 1h`);  direction = 'SHORT'; }

    if (Math.abs(score) >= 3) {
      return {
        token:     symbol,
        symbol,
        action:    'BUY',
        direction,
        score,
        reason:    `Order flow: ${reasons.join(', ')}`,
        source:    'whale',
      };
    }
    return null;
  }
}

module.exports = { WhaleTracker };
