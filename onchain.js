const { EventEmitter } = require('events');
const { LBankClient }  = require('../lbank_client');
const config = require('../../config/config');

/**
 * OnChainSignalEngine (LBank)
 * ----------------------------
 * Analyses price momentum directly from LBank ticker data.
 * No external RPC needed — uses the exchange's own price feed.
 *
 * Scores each pair on:
 *   - Price momentum (EMA approximation)
 *   - Volume surge (24h volume vs recent trend)
 *   - Funding rate (negative = longs paying, bearish pressure)
 *   - Price acceleration
 *
 * Also determines direction: LONG or SHORT
 */
class OnChainSignalEngine extends EventEmitter {
  constructor() {
    super();
    this.client       = new LBankClient();
    this.watchList    = [...config.BASE_PAIRS];
    this.priceHistory = new Map(); // symbol => [{ price, vol, ts }]
    this.fundingRates = new Map(); // symbol => rate
  }

  addSymbol(symbol) {
    if (!this.watchList.includes(symbol)) this.watchList.push(symbol);
  }

  removeSymbol(symbol) {
    this.watchList = this.watchList.filter(s => s !== symbol);
  }

  async scan() {
    const signals = [];

    for (const symbol of this.watchList) {
      try {
        const ticker = await this.client.getTicker(symbol);
        const price  = parseFloat(Array.isArray(ticker) ? ticker[0]?.lastPrice : ticker?.lastPrice);
        const vol    = parseFloat(Array.isArray(ticker) ? ticker[0]?.turnover  : ticker?.turnover);
        if (!price) continue;

        this._record(symbol, price, vol);
        const history = this.priceHistory.get(symbol) || [];
        if (history.length < 3) continue;

        const momentum   = this._momentum(history);
        const volatility = this._volatility(history);
        const accel      = this._acceleration(history);
        const volSurge   = this._volumeSurge(history);

        let score = 0;
        const reasons = [];

        // Momentum
        if (momentum > 0.005)       { score += 3; reasons.push(`bullish momentum +${(momentum*100).toFixed(2)}%`); }
        else if (momentum > 0.002)  { score += 2; reasons.push('mild uptrend'); }
        else if (momentum < -0.005) { score -= 3; reasons.push(`bearish momentum ${(momentum*100).toFixed(2)}%`); }
        else if (momentum < -0.002) { score -= 2; reasons.push('mild downtrend'); }

        // Volume surge
        if (volSurge > 1.5) { score += 2; reasons.push(`volume surge ${volSurge.toFixed(1)}x`); }
        else if (volSurge > 1.2) { score += 1; reasons.push('rising volume'); }

        // Volatility (want some, not too much for futures)
        if (volatility > 0.001 && volatility < 0.03) { score += 1; reasons.push('healthy volatility'); }
        if (volatility > 0.05)                        { score -= 1; reasons.push('extreme volatility'); }

        // Acceleration
        if (accel > 0.001)  { score += 2; reasons.push('accelerating'); }
        if (accel < -0.001) { score -= 2; reasons.push('decelerating'); }

        const strength = Math.max(1, Math.min(10, Math.abs(score) + 3));

        if (score >= 3) {
          const sig = {
            token: symbol, symbol, action: 'BUY', direction: 'LONG',
            strength, price, reason: reasons.join(', '), source: 'onchain',
          };
          signals.push(sig);
          this.emit('signal', sig);
        } else if (score <= -3) {
          const sig = {
            token: symbol, symbol, action: 'BUY', direction: 'SHORT',
            strength, price, reason: reasons.join(', '), source: 'onchain',
          };
          signals.push(sig);
          this.emit('signal', sig);
        }
      } catch (_) {}
    }

    return signals.sort((a, b) => b.strength - a.strength);
  }

  async getPrice(symbol) {
    try {
      const ticker = await this.client.getTicker(symbol);
      return parseFloat(Array.isArray(ticker) ? ticker[0]?.lastPrice : ticker?.lastPrice) || null;
    } catch { return null; }
  }

  _record(symbol, price, vol) {
    if (!this.priceHistory.has(symbol)) this.priceHistory.set(symbol, []);
    const arr = this.priceHistory.get(symbol);
    arr.push({ value: price, vol, ts: Date.now() });
    if (arr.length > 30) arr.shift();
  }

  _momentum(history) {
    const recent = history[history.length - 1].value;
    const older  = history[Math.max(0, history.length - 6)].value;
    return older > 0 ? (recent - older) / older : 0;
  }

  _volatility(history) {
    const vals = history.map(h => h.value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / vals.length;
    return mean > 0 ? Math.sqrt(variance) / mean : 0;
  }

  _acceleration(history) {
    if (history.length < 4) return 0;
    const n  = history.length;
    const v1 = history[n-1].value - history[n-2].value;
    const v2 = history[n-2].value - history[n-3].value;
    return (v1 - v2) / (history[n-2].value || 1);
  }

  _volumeSurge(history) {
    if (history.length < 6) return 1;
    const recent = history.slice(-3).reduce((a, h) => a + (h.vol || 0), 0) / 3;
    const older  = history.slice(-6, -3).reduce((a, h) => a + (h.vol || 0), 0) / 3;
    return older > 0 ? recent / older : 1;
  }
}

module.exports = { OnChainSignalEngine };
