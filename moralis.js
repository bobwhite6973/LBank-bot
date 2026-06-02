const { EventEmitter } = require('events');
const config = require('../../config/config');

/**
 * MoralisSource (CEX Futures)
 * ----------------------------
 * Uses Moralis to detect on-chain activity that predicts CEX futures moves.
 * Large on-chain movements → sentiment signals for futures direction.
 */
class MoralisSource extends EventEmitter {
  constructor() {
    super();
    this.apiKey = config.MORALIS_API_KEY;
    this.timer  = null;

    this.symbolMap = {
      'bitcoin':  'BTC_USDT',
      'ethereum': 'ETH_USDT',
      'solana':   'SOL_USDT',
      'bnb':      'BNB_USDT',
    };
  }

  start() {
    if (!this.apiKey) {
      console.warn('[Moralis] No API key — disabled.');
      return;
    }
    this._poll();
    this.timer = setInterval(() => this._poll(), 120_000); // every 2 min
    console.log('[Moralis] started');
  }

  stop() { clearInterval(this.timer); }

  async _poll() {
    if (!this.apiKey) return;
    try {
      await this._checkEthTrending();
    } catch (err) {
      console.error('[Moralis] error:', err.message);
    }
  }

  async _checkEthTrending() {
    // Check ETH trending tokens as macro sentiment
    try {
      const data = await this._get('/tokens/trending?chain=eth&limit=5');
      const tokens = data?.result || [];

      for (const token of tokens) {
        const name  = (token.name || '').toLowerCase();
        const lbPair = this.symbolMap[name];
        if (!lbPair) continue;

        const priceChange = parseFloat(token.price_change_percentage_24h || 0);
        const volume      = parseFloat(token.volume_24h || 0);

        let score = 0;
        const reasons = [];
        let direction = 'LONG';

        if (priceChange > 5)       { score += 2; reasons.push(`+${priceChange.toFixed(0)}% trending`); direction = 'LONG'; }
        else if (priceChange < -5) { score += 2; reasons.push(`${priceChange.toFixed(0)}% dump`); direction = 'SHORT'; }
        if (volume > 1_000_000_000) { score += 1; reasons.push('massive volume'); }

        if (score >= 2) {
          this.emit('signal', {
            token: lbPair, symbol: lbPair,
            action: 'BUY', direction,
            score,
            reason: `Moralis: ${reasons.join(', ')}`,
            source: 'moralis',
          });
        }
      }
    } catch (_) {}
  }

  async _get(path) {
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2${path}`, {
      headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Moralis ${res.status}`);
    return res.json();
  }
}

module.exports = { MoralisSource };
