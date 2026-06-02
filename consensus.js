const { EventEmitter }          = require('events');
const { OnChainSignalEngine }   = require('./onchain');
const { DexScreenerSource }     = require('./dexscreener');
const { TelegramChannelSource } = require('./telegram_channels');
const { WhaleTracker }          = require('./whale_tracker');
const { MoralisSource }         = require('./moralis');
const { LBankClient }           = require('../lbank_client');
const config = require('../../config/config');

/**
 * ConsensusEngine (LBank Futures)
 * ---------------------------------
 * Aggregates signals from 5 sources.
 * For futures, signals carry a DIRECTION (LONG or SHORT).
 *
 * Consensus logic:
 *   - Tallies LONG score and SHORT score separately
 *   - If LONG score ≥ threshold → emit LONG trade signal
 *   - If SHORT score ≥ threshold → emit SHORT trade signal
 *   - Direction conflict (both high) → no trade (market uncertain)
 *
 * Dynamic leverage:
 *   - Score 5-7  → 2x leverage
 *   - Score 8-11 → 3x leverage
 *   - Score 12+  → 4x leverage (user max)
 */
class ConsensusEngine extends EventEmitter {
  constructor() {
    super();
    this.cfg     = config.CONSENSUS;
    this.weights = this.cfg.weights;
    this.client  = new LBankClient();

    this.pending    = new Map();
    this.SIGNAL_TTL = 5 * 60 * 1000;

    this.onchain     = new OnChainSignalEngine();
    this.dexscreener = new DexScreenerSource();
    this.telegram    = new TelegramChannelSource();
    this.whale       = new WhaleTracker();
    this.moralis     = new MoralisSource();

    this._wire();
  }

  start() {
    this.dexscreener.start();
    this.whale.start();
    this.moralis.start();
    setInterval(() => this.cleanup(), 300_000);

    // Auto-discover top pairs and add to watchlist
    this._discoverTopPairs();
    setInterval(() => this._discoverTopPairs(), 3_600_000); // hourly

    console.log('[Consensus] started');
  }

  stop() {
    this.dexscreener.stop();
    this.whale.stop();
    this.moralis.stop();
  }

  getTelegramSource()    { return this.telegram; }
  getWhaleTracker()      { return this.whale; }
  getOnchainEngine()     { return this.onchain; }
  getDexScreenerSource() { return this.dexscreener; }
  getMoralisSource()     { return this.moralis; }
  getLBankClient()       { return this.client; }

  async scan() {
    const sigs = await this.onchain.scan();
    for (const sig of sigs) {
      this._ingest('onchain', sig.symbol, sig.direction, this.weights.onchain, sig.reason, sig);
    }
    return this._getFinalSignals();
  }

  getSourceStatus() {
    return {
      onchain:     { active: true, pairs: this.onchain.watchList.length },
      dexscreener: { active: true },
      telegram:    { active: this.telegram.isReady(), channels: this.telegram.listChannels() },
      whale:       { active: true },
      moralis:     { active: !!config.MORALIS_API_KEY },
    };
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  _wire() {
    this.dexscreener.on('signal', (sig) =>
      this._ingest('dexscreener', sig.symbol, sig.direction, this.weights.dexscreener, sig.reason, sig));

    this.telegram.on('signal', (sig) =>
      this._ingest('telegram', sig.symbol, sig.direction, this.weights.telegram, sig.reason, sig));

    this.whale.on('signal', (sig) =>
      this._ingest('whale', sig.symbol, sig.direction, this.weights.whale, sig.reason, sig));

    this.moralis.on('signal', (sig) =>
      this._ingest('moralis', sig.symbol, sig.direction, this.weights.moralis, sig.reason, sig));
  }

  _ingest(source, symbol, direction, weight, reason, rawSignal) {
    if (!symbol) return;
    const key = symbol.toUpperCase();

    if (!this.pending.has(key)) {
      this.pending.set(key, { symbol: key, signals: {}, firstSeen: Date.now(), lastUpdated: Date.now() });
    }

    const entry = this.pending.get(key);
    entry.lastUpdated = Date.now();
    entry.signals[source] = { direction, weight, reason, ts: Date.now(), raw: rawSignal };

    this.emit('signal_update', { source, symbol: key, direction, weight, reason });
    this._evaluate(key);
  }

  _evaluate(key) {
    const entry = this.pending.get(key);
    if (!entry) return;

    const now = Date.now();
    for (const [src, sig] of Object.entries(entry.signals)) {
      if (now - sig.ts > this.SIGNAL_TTL) delete entry.signals[src];
    }

    let longScore = 0, shortScore = 0;
    const longSrcs = [], shortSrcs = [];

    for (const [src, sig] of Object.entries(entry.signals)) {
      if (sig.direction === 'LONG') {
        longScore += sig.weight;
        longSrcs.push({ src, reason: sig.reason, weight: sig.weight });
      } else {
        shortScore += sig.weight;
        shortSrcs.push({ src, reason: sig.reason, weight: sig.weight });
      }
    }

    const maxScore = Object.values(this.weights).reduce((a, b) => a + b, 0);

    // Conflict check — both sides above threshold = skip
    if (longScore >= this.cfg.minBuyScore && shortScore >= this.cfg.minSellScore) {
      this.emit('signal_update', {
        source: 'consensus', symbol: key,
        direction: 'CONFLICT', weight: 0,
        reason: `Conflicting signals — LONG:${longScore} SHORT:${shortScore} — skipping`,
      });
      this.pending.delete(key);
      return;
    }

    if (longScore >= this.cfg.minBuyScore) {
      const leverage = this._calcLeverage(longScore);
      this.emit('trade_signal', {
        symbol:     key,
        direction:  'LONG',
        totalScore: longScore,
        maxScore,
        leverage,
        sources:    longSrcs.map(s => s.src),
        reasons:    longSrcs.map(s => `[${s.src}+${s.weight}] ${s.reason}`),
        confidence: Math.min(1, longScore / 10),
      });
      this.pending.delete(key);
    } else if (shortScore >= this.cfg.minSellScore) {
      const leverage = this._calcLeverage(shortScore);
      this.emit('trade_signal', {
        symbol:     key,
        direction:  'SHORT',
        totalScore: shortScore,
        maxScore,
        leverage,
        sources:    shortSrcs.map(s => s.src),
        reasons:    shortSrcs.map(s => `[${s.src}+${s.weight}] ${s.reason}`),
        confidence: Math.min(1, shortScore / 10),
      });
      this.pending.delete(key);
    }
  }

  _calcLeverage(score) {
    if (!config.DYNAMIC_LEVERAGE) return config.MAX_LEVERAGE;

    // Walk tiers highest-to-lowest, pick first one score qualifies for
    const tiers = [...config.LEVERAGE_TIERS].sort((a, b) => b.minScore - a.minScore);
    for (const tier of tiers) {
      if (score >= tier.minScore) {
        return Math.min(tier.leverage, config.MAX_LEVERAGE);
      }
    }
    // Floor — never below lowest tier (10x)
    return config.LEVERAGE_TIERS[0].leverage;
  }

  _getFinalSignals() {
    const results = [];
    for (const [, entry] of this.pending) {
      let ls = 0, ss = 0;
      for (const sig of Object.values(entry.signals)) {
        if (sig.direction === 'LONG')  ls += sig.weight;
        else                           ss += sig.weight;
      }
      if (ls >= this.cfg.minBuyScore)  results.push({ symbol: entry.symbol, direction: 'LONG',  strength: ls });
      if (ss >= this.cfg.minSellScore) results.push({ symbol: entry.symbol, direction: 'SHORT', strength: ss });
    }
    return results;
  }

  async _discoverTopPairs() {
    try {
      const top = await this.client.getTopPairsByVolume(config.AUTO_TOP_PAIRS);
      for (const pair of top) {
        this.onchain.addSymbol(pair);
      }
      console.log('[Consensus] auto-added top pairs:', top.join(', '));
    } catch (_) {}
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.lastUpdated > this.SIGNAL_TTL * 2) this.pending.delete(key);
    }
  }
}

module.exports = { ConsensusEngine };
