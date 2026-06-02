const { EventEmitter } = require('events');
const config = require('../../config/config');

/**
 * DexScreenerSource (CEX/Futures)
 * --------------------------------
 * Polls DEX Screener for trending assets. Since we're trading futures on LBank,
 * we use DEX Screener as a *sentiment* signal — if a token is trending on-chain,
 * there will be momentum on CEX futures too.
 *
 * Maps DEX token symbols to LBank futures pairs (e.g. BTC → BTC_USDT).
 */
class DexScreenerSource extends EventEmitter {
  constructor() {
    super();
    this.cfg   = config.DEXSCREENER;
    this.timer = null;

    // Symbol map: DEX screener symbol → LBank futures pair
    this.symbolMap = {
      BTC:  'BTC_USDT',
      ETH:  'ETH_USDT',
      SOL:  'SOL_USDT',
      BNB:  'BNB_USDT',
      XRP:  'XRP_USDT',
      DOGE: 'DOGE_USDT',
      ADA:  'ADA_USDT',
      AVAX: 'AVAX_USDT',
      LINK: 'LINK_USDT',
      DOT:  'DOT_USDT',
      MATIC:'MATIC_USDT',
      ARB:  'ARB_USDT',
      OP:   'OP_USDT',
      SUI:  'SUI_USDT',
      APT:  'APT_USDT',
    };
  }

  start() {
    this._poll();
    this.timer = setInterval(() => this._poll(), this.cfg.pollIntervalMs);
    console.log('[DexScreener] started');
  }

  stop() { clearInterval(this.timer); }

  async _poll() {
    try {
      // Fetch trending tokens
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list)) return;

      const seenSymbols = new Set();

      for (const token of list.slice(0, 30)) {
        const symbol = token.symbol?.toUpperCase();
        const pair   = this.symbolMap[symbol];
        if (!pair || seenSymbols.has(pair)) continue;
        seenSymbols.add(pair);

        // Also get price data
        await this._enrichAndEmit(token, pair);
      }

      // Also fetch trending search results for broader coverage
      await this._fetchTrendingSearch();
    } catch (err) {
      console.error('[DexScreener] poll error:', err.message);
    }
  }

  async _fetchTrendingSearch() {
    try {
      const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=btc eth sol', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const pairs = data.pairs || [];

      const seen = new Set();
      for (const pair of pairs.slice(0, 20)) {
        const symbol = pair.baseToken?.symbol?.toUpperCase();
        const lbPair = this.symbolMap[symbol];
        if (!lbPair || seen.has(lbPair)) continue;
        seen.add(lbPair);

        const priceChange1h  = parseFloat(pair.priceChange?.h1  || 0);
        const priceChange24h = parseFloat(pair.priceChange?.h24 || 0);
        const volume24h      = parseFloat(pair.volume?.h24      || 0);

        if (volume24h < this.cfg.minVolume24hUsd) continue;

        let score = 0;
        const reasons = [];

        if (priceChange1h > 3)        { score += 2; reasons.push(`+${priceChange1h.toFixed(1)}% 1h`); }
        else if (priceChange1h > 1.5) { score += 1; reasons.push(`+${priceChange1h.toFixed(1)}% 1h`); }
        if (priceChange24h > 8)       { score += 2; reasons.push(`+${priceChange24h.toFixed(1)}% 24h`); }
        if (priceChange1h < -3)       { score -= 2; reasons.push(`${priceChange1h.toFixed(1)}% 1h dump`); }
        if (priceChange24h < -8)      { score -= 2; reasons.push('24h downtrend'); }

        if (Math.abs(score) >= 2) {
          this.emit('signal', {
            token:     lbPair,
            symbol:    lbPair,
            action:    'BUY',
            direction: score > 0 ? 'LONG' : 'SHORT',
            score,
            reason:    reasons.join(', '),
            source:    'dexscreener',
            priceChange1h,
            priceChange24h,
          });
        }
      }
    } catch (_) {}
  }

  async _enrichAndEmit(token, lbPair) {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${token.tokenAddress}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const pair = data.pairs?.[0];
      if (!pair) return;

      const priceChange1h  = parseFloat(pair.priceChange?.h1  || 0);
      const priceChange24h = parseFloat(pair.priceChange?.h24 || 0);
      const volume24h      = parseFloat(pair.volume?.h24      || 0);

      if (volume24h < this.cfg.minVolume24hUsd) return;

      let score = 0;
      const reasons = ['boosted listing'];

      if (priceChange1h > 3)  { score += 3; reasons.push(`+${priceChange1h.toFixed(1)}% 1h`); }
      if (priceChange24h > 8) { score += 2; reasons.push(`+${priceChange24h.toFixed(1)}% 24h`); }
      if (priceChange1h < -3) { score -= 3; reasons.push('dumping 1h'); }

      if (Math.abs(score) >= 2) {
        this.emit('signal', {
          token:     lbPair,
          symbol:    lbPair,
          action:    'BUY',
          direction: score > 0 ? 'LONG' : 'SHORT',
          score,
          reason:    reasons.join(', '),
          source:    'dexscreener',
          priceChange1h,
          priceChange24h,
        });
      }
    } catch (_) {}
  }
}

module.exports = { DexScreenerSource };
