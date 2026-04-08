const express = require("express");
const fetch = require("node-fetch");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Data Files ───────────────────────────────────────────────────────────────
const DATA_FILE     = path.join(__dirname, "challenge_data.json");
const STRATEGY_FILE = path.join(__dirname, "strategy_memory.json");
const PAPER_FILE    = path.join(__dirname, "paper_trades.json");

// ─── Load / Save ──────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = { balance:10, startingBalance:10, goal:10000, trades:[], milestones:[], createdAt:new Date().toISOString(), currentStrategy:"MOMENTUM_SCALP", tradeLevel:"BEGINNER", consecutiveWins:0, consecutiveLosses:0 };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); return d;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }

function loadStrategyMemory() {
  if (!fs.existsSync(STRATEGY_FILE)) {
    const d = { patterns:[], strategyPerformance:{}, marketRegimeHistory:[], lastAdaptation:null, totalPatterns:0 };
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(d,null,2)); return d;
  }
  return JSON.parse(fs.readFileSync(STRATEGY_FILE,"utf8"));
}
function saveStrategyMemory(d) { fs.writeFileSync(STRATEGY_FILE, JSON.stringify(d,null,2)); }

function loadPaperTrades() {
  if (!fs.existsSync(PAPER_FILE)) {
    const d = { balance:1000, trades:[], active:[] };
    fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2)); return d;
  }
  return JSON.parse(fs.readFileSync(PAPER_FILE,"utf8"));
}
function savePaperTrades(d) { fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2)); }

// ─── Trading Strategies ───────────────────────────────────────────────────────
const STRATEGIES = {
  MOMENTUM_SCALP: {
    name: "Momentum Scalp",
    description: "Ride fast-moving stocks for quick 30-100% gains. Hold 30min-2hrs.",
    bestConditions: "High volume, strong trend, RSI 40-65, bullish MACD",
    riskLevel: "MEDIUM", holdTime: "30min - 2hrs",
    winRateTarget: 45, rrRatio: "1:1.5",
    indicators: ["RSI","MACD","Volume","OBV"],
    educationLevel: 1,
    // Scoring weights — what conditions make this strategy work
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (dayType === "TRENDING") score += 30;
      if (dayType === "CHOPPY") score -= 30; // Momentum doesn't work on flat days
      if (dayType === "EXTREME_VOLATILE") score -= 50;
      if (Math.abs(spyChange) > 0.5 && Math.abs(spyChange) < 2) score += 20;
      if (s.intraday?.realtimeTrend === "UPTREND" && spyChange > 0) score += 25;
      if (s.intraday?.realtimeTrend === "DOWNTREND" && spyChange < 0) score += 25;
      if (s.volume === "HIGH") score += 15;
      if (s.volume === "LOW") score -= 20;
      if (s.rsi >= 40 && s.rsi <= 65) score += 15;
      if (s.macdBullish && spyChange > 0) score += 10;
      if (s.obvTrend === "RISING") score += 10;
      if (s.momentum?.exhaustionLevel === "FRESH") score += 20;
      if (s.momentum?.exhaustionLevel === "EXHAUSTED") score -= 40;
      if (s.momentum?.exhaustionLevel === "EXTREMELY_EXHAUSTED") score -= 80;
      return Math.max(0, Math.min(100, score + 30)); // Base of 30
    }
  },
  OVERSOLD_BOUNCE: {
    name: "Oversold Bounce",
    description: "Buy stocks that crashed and are bouncing back. Steady reliable gains.",
    bestConditions: "RSI below 35, Williams %R below -70, stock down recently, support holding",
    riskLevel: "MEDIUM", holdTime: "1-3hrs",
    winRateTarget: 55, rrRatio: "1:1.5",
    indicators: ["RSI","Williams %R","Stochastic","Support"],
    educationLevel: 1,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (dayType === "CHOPPY") score += 25; // Great on flat days
      if (dayType === "TRENDING" && spyChange < 0) score += 20; // Good on down days
      if (s.rsi < 35) score += 35;
      if (s.rsi < 25) score += 20; // Extra points for very oversold
      if (s.williamsR < -70) score += 20;
      if (s.stoch < 25) score += 15;
      if (s.intraday?.realtimeTrend === "UPTREND") score += 20; // Bounce forming
      if (s.change < -5) score += 15; // Stock dropped recently
      if (s.change < -15) score -= 10; // Too much drop = still falling
      if (s.divergence?.type === "BULLISH_DIVERGENCE") score += 25;
      if (s.momentum?.exhaustionLevel === "EXTREMELY_EXHAUSTED" && s.change < 0) score += 15;
      return Math.max(0, Math.min(100, score + 20));
    }
  },
  VWAP_RECLAIM: {
    name: "VWAP Reclaim",
    description: "Stock drops below VWAP then fights back above it. Strong reversal signal used by pro traders.",
    bestConditions: "Stock recently below VWAP, now crossing back above, volume increasing",
    riskLevel: "MEDIUM", holdTime: "1-2hrs",
    winRateTarget: 52, rrRatio: "1:1.8",
    indicators: ["VWAP","Volume","RSI","Real-time trend"],
    educationLevel: 1,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (s.intraday?.aboveVWAP === true) score += 30; // Currently above VWAP
      if (s.intraday?.orbSignal === "BULLISH_BREAKOUT") score += 25;
      if (s.intraday?.morningTrend === "BULLISH") score += 20;
      if (s.volume === "HIGH") score += 20;
      if (dayType !== "EXTREME_VOLATILE") score += 10;
      if (s.rsi > 40 && s.rsi < 60) score += 15; // RSI in healthy zone
      if (s.momentum?.exhaustionLevel === "FRESH") score += 15;
      return Math.max(0, Math.min(100, score + 15));
    }
  },
  CONTINUATION: {
    name: "Continuation Pattern",
    description: "Stock in strong uptrend pulls back slightly then continues. One of the most profitable pro setups.",
    bestConditions: "Stock in uptrend, small 3-5% pullback, volume drops on pullback, support holds",
    riskLevel: "MEDIUM", holdTime: "2-4hrs",
    winRateTarget: 58, rrRatio: "1:2",
    indicators: ["EMA 20","Volume on pullback","RSI","Support"],
    educationLevel: 2,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (dayType === "TRENDING") score += 30;
      if (s.aboveEMA50) score += 20;
      if (s.aboveEMA200) score += 15;
      if (s.macdBullish) score += 15;
      if (s.change > -3 && s.change < 0) score += 20; // Small pullback = good entry
      if (s.change > -1 && s.change < 0) score += 10; // Very small pullback
      if (s.intraday?.morningTrend === "BULLISH") score += 15;
      if (s.obvTrend === "RISING") score += 15;
      if (s.divergence?.type === "CONFIRMED_BULLISH") score += 20;
      if (spyChange > 0) score += 10; // Market helping
      return Math.max(0, Math.min(100, score + 10));
    }
  },
  NEWS_CATALYST: {
    name: "News Catalyst Play",
    description: "Trade stocks with breaking specific news. Catalyst drives the move not market.",
    bestConditions: "Specific positive/negative news today, volume spike, stock moving independently of SPY",
    riskLevel: "MEDIUM-HIGH", holdTime: "30min - 2hrs",
    winRateTarget: 48, rrRatio: "1:2.5",
    indicators: ["News sentiment","Volume spike","Unusual options","Relative strength"],
    educationLevel: 1,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (s.socialSentiment?.label === "BULLISH") score += 30;
      if (s.socialSentiment?.buzz === "HIGH BUZZ") score += 25;
      if (s.unusualActivity?.bigMoney === "BULLISH") score += 30;
      if (s.unusualActivity?.bigMoney === "BEARISH") score -= 20;
      if (s.isTrending) score += 20;
      if (s.relativeStrength?.label === "OUTPERFORMING") score += 20; // Moving on own catalyst
      if (s.relativeStrength?.label === "EXTREMELY_EXTENDED") score -= 30;
      if (s.volume === "HIGH") score += 15;
      if (s.intraday?.realtimeTrend !== "SIDEWAYS") score += 15;
      return Math.max(0, Math.min(100, score + 10));
    }
  },
  SUPPORT_BOUNCE: {
    name: "Support Bounce",
    description: "Stock hits a known support level and bounces. Low risk, clear stop loss.",
    bestConditions: "Price at or near strong support, RSI oversold, volume declining on approach",
    riskLevel: "LOW-MEDIUM", holdTime: "1-3hrs",
    winRateTarget: 55, rrRatio: "1:1.5",
    indicators: ["Support levels","RSI","Volume","Stochastic"],
    educationLevel: 1,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (s.rsi < 40) score += 25;
      if (s.stoch < 30) score += 20;
      if (s.williamsR < -60) score += 15;
      if (s.intraday?.realtimeTrend === "UPTREND") score += 25; // Bounce confirmed
      if (s.divergence?.type === "BULLISH_DIVERGENCE") score += 30; // Strong reversal signal
      if (s.momentum?.exhaustionLevel === "FRESH" && s.change < 0) score += 15;
      if (dayType === "CHOPPY") score += 15; // Support bounces work on flat days
      if (dayType !== "EXTREME_VOLATILE") score += 10;
      return Math.max(0, Math.min(100, score + 15));
    }
  },
  VOLUME_SPIKE: {
    name: "Volume Spike Play",
    description: "Unusual volume detected before or during a price move. Big money is moving in.",
    bestConditions: "Volume 3x+ above average, price starting to move, unusual options activity",
    riskLevel: "MEDIUM", holdTime: "30min - 1.5hrs",
    winRateTarget: 50, rrRatio: "1:2",
    indicators: ["Volume vs average","Unusual options","OBV","Price action"],
    educationLevel: 1,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (s.volume === "HIGH") score += 40; // Volume is everything for this strategy
      if (s.unusualActivity?.bigMoney === "BULLISH") score += 35;
      if (s.unusualActivity?.putCallRatio < 0.5) score += 20; // Heavy call buying
      if (s.obvTrend === "RISING") score += 20;
      if (s.intraday?.realtimeTrend !== "SIDEWAYS") score += 15;
      if (s.isTrending) score += 15;
      if (s.momentum?.exhaustionLevel === "FRESH") score += 15;
      if (s.volume === "LOW") score -= 50; // Can't use this strategy with low volume
      return Math.max(0, Math.min(100, score + 5));
    }
  },
  BREAKOUT: {
    name: "Breakout Trading",
    description: "Buy when price breaks above resistance with high volume.",
    bestConditions: "Price near resistance, high volume breakout, bullish market",
    riskLevel: "MEDIUM-HIGH", holdTime: "1-4hrs",
    winRateTarget: 40, rrRatio: "1:2",
    indicators: ["Resistance","Volume","Bollinger Bands","ATR"],
    educationLevel: 2,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (s.intraday?.orbSignal === "BULLISH_BREAKOUT") score += 40;
      if (s.volume === "HIGH") score += 20;
      if (dayType === "TRENDING") score += 20;
      if (s.macdBullish) score += 15;
      if (s.aboveEMA50) score += 10;
      if (s.momentum?.exhaustionLevel === "FRESH") score += 15;
      if (s.momentum?.exhaustionLevel === "EXTREMELY_EXHAUSTED") score -= 50;
      return Math.max(0, Math.min(100, score + 10));
    }
  },
  GAP_FILL: {
    name: "Gap Fill",
    description: "Stock gaps at open, often fills back toward previous close.",
    bestConditions: "Large gap at open (3%+), low overall market movement",
    riskLevel: "MEDIUM", holdTime: "1-2hrs after open",
    winRateTarget: 50, rrRatio: "1:1.5",
    indicators: ["Opening gap","Volume","Previous close","Support/Resistance"],
    educationLevel: 2,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (Math.abs(s.intraday?.gapPct || 0) > 3) score += 40;
      if (dayType === "CHOPPY") score += 20; // Gap fills work on flat days
      if (Math.abs(spyChange) < 1) score += 15; // Market not trending against fill
      if (s.intraday?.gapType === "GAP_UP" && s.rsi > 65) score += 20;
      if (s.intraday?.gapType === "GAP_DOWN" && s.rsi < 35) score += 20;
      return Math.max(0, Math.min(100, score + 10));
    }
  },
  TREND_FOLLOWING: {
    name: "Trend Following",
    description: "Follow the dominant market trend all day.",
    bestConditions: "Clear market direction, price above all EMAs, consistent volume",
    riskLevel: "LOW-MEDIUM", holdTime: "2-6hrs",
    winRateTarget: 50, rrRatio: "1:2",
    indicators: ["EMA 20/50/200","MACD","SPY direction","OBV"],
    educationLevel: 2,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (dayType === "TRENDING") score += 35;
      if (s.aboveEMA50 && spyChange > 0) score += 20;
      if (s.aboveEMA200 && spyChange > 0) score += 15;
      if (s.macdBullish && spyChange > 0) score += 15;
      if (s.obvTrend === "RISING") score += 10;
      if (Math.abs(spyChange) > 0.5) score += 10;
      return Math.max(0, Math.min(100, score + 15));
    }
  },
  EARNINGS_PLAY: {
    name: "Earnings Play",
    description: "Trade around company earnings for explosive moves.",
    bestConditions: "Earnings in 1-3 days, high IV, strong expectations",
    riskLevel: "HIGH", holdTime: "Same day",
    winRateTarget: 35, rrRatio: "1:3",
    indicators: ["IV","Earnings date","Options volume"],
    educationLevel: 3,
    scoreConditions: (s, spyChange, dayType) => {
      let score = 0;
      if (s.earningsWarning && s.earningsWarning.includes("EARNINGS IN")) score += 50;
      if (s.iv > 80) score += 20;
      if (s.unusualActivity?.bigMoney === "BULLISH") score += 20;
      return Math.max(0, Math.min(100, score));
    }
  }
};

// ─── Education Levels ─────────────────────────────────────────────────────────
function getEducationLevel(data, strategyMemory) {
  const trades = data.trades?.length || 0;
  const balance = data.balance || 10;
  if (trades < 10 || balance < 50)   return 1; // Beginner
  if (trades < 30 || balance < 200)  return 2; // Intermediate
  if (trades < 60 || balance < 1000) return 3; // Advanced
  return 4; // Expert
}

const EDUCATION_TOPICS = {
  1: ["What is an option?","Call vs Put","Strike price","Expiration date","Premium","Stop loss","Profit target","Risk/Reward"],
  2: ["Delta explained","Theta decay","In/Out of the money","Volume & liquidity","Support & Resistance","MACD deep dive","RSI advanced","Position sizing math"],
  3: ["Options Greeks (all 4)","Implied Volatility","Options chains reading","Spreads introduction","Risk management systems","Market makers","Options pricing models"],
  4: ["Advanced spreads","Iron condors","Straddles","Portfolio hedging","Correlation trading","Sector rotation","Macro analysis"]
};

// ─── Trend Strength Scorer ────────────────────────────────────────────────────
function scoreTrendStrength(spyChange, vixValue, spyData) {
  const absChange = Math.abs(spyChange);
  let strength = 0;
  
  // SPY move size contributes to strength
  if (absChange > 2) strength += 30;
  else if (absChange > 1) strength += 20;
  else if (absChange > 0.5) strength += 10;
  else strength -= 10; // Flat = weak
  
  // VIX contribution — moderate VIX = healthy trend
  if (vixValue < 20) strength += 20; // Low fear = stable trend
  else if (vixValue < 25) strength += 10;
  else if (vixValue > 30) strength -= 20; // High fear = unstable
  
  // Consistency bonus — big move with low VIX = strong trend
  if (absChange > 1 && vixValue < 20) strength += 20;
  
  const score = Math.max(0, Math.min(100, strength + 40)); // Base of 40
  const label = score >= 70 ? "STRONG" : score >= 50 ? "MODERATE" : score >= 30 ? "WEAK" : "VERY_WEAK";
  
  return {
    score,
    label,
    plainEnglish: label === "STRONG" ? "Market trend is strong and consistent — momentum strategies work well today" : label === "MODERATE" ? "Moderate trend — be selective with entries" : label === "WEAK" ? "Weak trend — momentum strategies may fail, consider bounce strategies" : "Very weak trend — high chance of whipsaws, consider sitting out"
  };
}

// ─── Market Day Classifier ────────────────────────────────────────────────────
function classifyMarketDay(spyChange, vixValue, spyIntradayData) {
  const absChange = Math.abs(spyChange);
  
  // Step 1: Check volatility level
  if (absChange > 3) {
    return {
      dayType: "EXTREME_VOLATILE",
      regime: spyChange > 0 ? "STRONG_BULL" : "STRONG_BEAR",
      bestStrategy: "SIT_OUT",
      description: "Market moving 3%+ — extreme volatility day",
      plainEnglish: "The market is moving too much today. Options are overpriced and moves can reverse violently. Professional traders sit out days like this.",
      tradingAdvice: "DO NOT TRADE. Wait for a normal day. Your money is safer sitting still.",
      confidence: "HIGH"
    };
  }
  
  // Step 2: News/event driven day
  if (absChange > 1.5 && vixValue > 25) {
    return {
      dayType: "NEWS_DRIVEN",
      regime: spyChange > 0 ? "BULL" : "BEAR",
      bestStrategy: spyChange > 0 ? "MOMENTUM_SCALP" : "MOMENTUM_SCALP",
      description: "Strong directional move with elevated fear — news is driving market",
      plainEnglish: "Market is making a big move today because of specific news. The direction is clear but options are more expensive than usual.",
      tradingAdvice: "Trade in the direction of the move but reduce position size by 50%. Wait until 10:30 AM for the initial volatility to settle.",
      confidence: "MEDIUM"
    };
  }
  
  // Step 3: Clean trending day
  if (absChange > 0.5 && absChange <= 1.5) {
    return {
      dayType: "TRENDING",
      regime: spyChange > 0 ? "BULL" : "BEAR",
      bestStrategy: spyChange > 0 ? "TREND_FOLLOWING" : "MOMENTUM_SCALP",
      description: "Clean directional trend — market moving steadily in one direction",
      plainEnglish: "Today is a clear trending day. Market is moving steadily " + (spyChange > 0 ? "UP" : "DOWN") + " without big reversals. This is the best type of day to trade momentum.",
      tradingAdvice: "Follow the trend. Buy calls on stocks moving with the market (up day) or puts on the weakest stocks (down day). Best entry window is 10:00-11:00 AM.",
      confidence: "HIGH"
    };
  }
  
  // Step 4: Choppy/flat day
  if (absChange <= 0.5) {
    return {
      dayType: "CHOPPY",
      regime: "NEUTRAL",
      bestStrategy: "OVERSOLD_BOUNCE",
      description: "Flat/choppy market — no clear direction",
      plainEnglish: "The market is going sideways today with no clear direction. Momentum strategies will NOT work on a day like this because there is no momentum. This is actually a good day for Oversold Bounce — finding stocks that dropped and are recovering.",
      tradingAdvice: "AVOID Momentum Scalp today — it needs momentum that doesn't exist. Look for individual stocks with their OWN catalyst instead of market-driven moves. Or sit out and wait for a trending day.",
      confidence: "HIGH"
    };
  }
  
  return {
    dayType: "UNCLEAR",
    regime: "NEUTRAL",
    bestStrategy: "MOMENTUM_SCALP",
    description: "Market direction unclear",
    plainEnglish: "Market direction is not clear yet. Wait until 10:30 AM for more data before trading.",
    tradingAdvice: "Wait for clearer direction before entering any trade.",
    confidence: "LOW"
  };
}

function detectMarketRegime(spyChange, spyVolume, vixLevel) {
  if (Math.abs(spyChange) > 2) return spyChange > 0 ? "STRONG_BULL" : "STRONG_BEAR";
  if (Math.abs(spyChange) > 0.75) return spyChange > 0 ? "BULL" : "BEAR";
  return "CHOPPY";
}

// ─── Pattern-First Scoring Engine ────────────────────────────────────────────
// Step 1: Identify what chart path each stock is on
// Step 2: Match path to strategy
// Step 3: Confirm with news, volume, big money, market conditions
// Step 4: Score and rank
// Step 5: Pick winner closest to entry trigger with most confirmation

function identifyChartPath(stock) {
  const s = stock;
  const intra = s.intraday;
  const smc = s.smcAnalysis;
  const patterns = s.chartPatterns || [];
  const div = s.divergence;
  
  const paths = [];

  // PATH 1 — SMC: FVG + BOS Setup
  if (smc?.fairValueGaps?.length > 0 && smc?.breakOfStructure) {
    const step = smc.entrySignal?.type === "ENTER_NOW" ? 5 :
                 smc.entrySignal?.type === "WAIT" ? 4 :
                 smc.breakOfStructure ? 3 :
                 smc.fairValueGaps?.length > 0 ? 2 : 1;
    paths.push({
      name: "FVG + Break of Structure",
      strategy: "SMC",
      step, totalSteps: 5,
      direction: smc.breakOfStructure?.type === "BULLISH" ? "CALL" : "PUT",
      entryReady: step === 5,
      description: smc.plainEnglish || "SMC setup in progress",
      fvgZone: smc.fairValueGaps?.[smc.fairValueGaps.length-1] ? 
        `$${smc.fairValueGaps[smc.fairValueGaps.length-1].bottomOfGap?.toFixed(2)}-$${smc.fairValueGaps[smc.fairValueGaps.length-1].topOfGap?.toFixed(2)}` : null,
      score: step * 20 // Max 100 when on step 5
    });
  }

  // PATH 2 — Bull Flag
  const bullFlag = patterns.find(p => p.name === "BULL FLAG");
  if (bullFlag) {
    const hasBreakout = intra?.orbSignal === "BULLISH_BREAKOUT";
    const step = hasBreakout ? 3 : 2;
    paths.push({
      name: "Bull Flag",
      strategy: "CONTINUATION",
      step, totalSteps: 3,
      direction: "CALL",
      entryReady: hasBreakout && intra?.isMoving,
      description: hasBreakout ? 
        "Bull flag BREAKING OUT — enter on volume confirmation" :
        "Bull flag forming — tight consolidation after strong move. Wait for breakout above flag.",
      score: step * 33
    });
  }

  // PATH 3 — Double Bottom (W shape)
  const dblBottom = patterns.find(p => p.name === "DOUBLE BOTTOM");
  if (dblBottom) {
    const bouncing = intra?.realtimeTrend === "UPTREND";
    const step = bouncing ? 4 : 3;
    paths.push({
      name: "Double Bottom (W)",
      strategy: "OVERSOLD_BOUNCE",
      step, totalSteps: 4,
      direction: "CALL",
      entryReady: bouncing && s.rsi < 45,
      description: bouncing ?
        "W pattern confirmed — second bottom held and price bouncing. Green candle = entry." :
        "W pattern forming — second bottom testing. Watch for hold and green candle.",
      score: step * 25
    });
  }

  // PATH 4 — VWAP Reclaim
  if (intra?.aboveVWAP && intra?.realtimeTrend === "UPTREND" && s.change < 5) {
    const step = intra?.isMoving ? 4 : 3;
    paths.push({
      name: "VWAP Reclaim",
      strategy: "VWAP_RECLAIM",
      step, totalSteps: 4,
      direction: "CALL",
      entryReady: intra?.isMoving && intra?.aboveVWAP,
      description: intra?.isMoving ?
        `Price reclaimed VWAP at $${intra.vwap} and trending up — entry confirmed` :
        `Price above VWAP at $${intra.vwap} — watching for momentum confirmation`,
      score: step * 25
    });
  }

  // PATH 5 — Opening Range Breakout
  if (intra?.orbSignal === "BULLISH_BREAKOUT") {
    const step = intra?.isMoving ? 3 : 2;
    paths.push({
      name: "Opening Range Breakout",
      strategy: "BREAKOUT",
      step, totalSteps: 3,
      direction: "CALL",
      entryReady: intra?.isMoving,
      description: `Price broke above opening range high at $${intra?.openingRangeHigh?.toFixed(2)} — momentum breakout`,
      score: step * 33
    });
  }

  // PATH 6 — Oversold with Bullish Divergence
  if (div?.type === "BULLISH_DIVERGENCE" && s.rsi < 40) {
    paths.push({
      name: "Oversold Divergence",
      strategy: "SUPPORT_BOUNCE",
      step: 3, totalSteps: 4,
      direction: "CALL",
      entryReady: intra?.realtimeTrend === "UPTREND",
      description: "Price falling but momentum recovering — bullish divergence. Watch for green candle.",
      score: 75
    });
  }

  // PATH 7 — Uptrend Continuation
  const upChannel = patterns.find(p => p.name === "UPTREND CHANNEL");
  if (upChannel && s.macdBullish) {
    const step = intra?.realtimeTrend === "UPTREND" ? 3 : 2;
    paths.push({
      name: "Uptrend Continuation",
      strategy: "TREND_FOLLOWING",
      step, totalSteps: 3,
      direction: "CALL",
      entryReady: intra?.realtimeTrend === "UPTREND" && intra?.aboveVWAP,
      description: "Stock in confirmed uptrend channel — buy on pullbacks to support",
      score: step * 33
    });
  }

  // PATH 8 — Volume Spike with Price Move
  if (s.volume === "HIGH" && intra?.isMoving && s.momentum?.exhaustionLevel === "FRESH") {
    paths.push({
      name: "Volume Spike",
      strategy: "VOLUME_SPIKE",
      step: 3, totalSteps: 3,
      direction: s.change > 0 ? "CALL" : "PUT",
      entryReady: true,
      description: "Unusual volume with fresh price move — big money entering position",
      score: 80
    });
  }

  // Sort by score descending, return best path
  paths.sort((a, b) => b.score - a.score);
  return paths.length > 0 ? { bestPath: paths[0], allPaths: paths } : null;
}

function scoreStockWithPattern(stock, spyChange, dayType, socialMap, unusualMap, earningsMap, marketContext) {
  const s = stock;
  let totalScore = 0;
  const breakdown = {};

  // Get the chart path this stock is on
  const pathResult = identifyChartPath(s);
  const path = pathResult?.bestPath;

  // LAYER 1 — Pattern score (max 30 points)
  if (path) {
    const patternScore = Math.round((path.step / path.totalSteps) * 30);
    totalScore += patternScore;
    breakdown.pattern = { score: patternScore, detail: `${path.name} — Step ${path.step}/${path.totalSteps}` };
  } else {
    breakdown.pattern = { score: 0, detail: "No clear pattern forming" };
  }

  // LAYER 2 — Entry trigger ready (max 20 points)
  if (path?.entryReady) {
    totalScore += 20;
    breakdown.entry = { score: 20, detail: "Entry trigger met — ready to trade" };
  } else if (path?.step >= 3) {
    totalScore += 10;
    breakdown.entry = { score: 10, detail: "Close to entry — watching" };
  } else {
    breakdown.entry = { score: 0, detail: "Not near entry yet" };
  }

  // LAYER 3 — News alignment (max 15 points)
  const social = s.socialSentiment || socialMap?.[s.symbol] || {};
  const direction = path?.direction || "CALL";
  if (social.label === "BULLISH" && direction === "CALL") { totalScore += 15; breakdown.news = { score: 15, detail: "Bullish news confirms CALL direction" }; }
  else if (social.label === "BEARISH" && direction === "PUT") { totalScore += 15; breakdown.news = { score: 15, detail: "Bearish news confirms PUT direction" }; }
  else if (social.label === "NEUTRAL") { totalScore += 7; breakdown.news = { score: 7, detail: "Neutral news — no conflict" }; }
  else { totalScore += 0; breakdown.news = { score: 0, detail: "News conflicts with pattern direction" }; }

  // LAYER 4 — Volume confirmation (max 10 points)
  if (s.volume === "HIGH") { totalScore += 10; breakdown.volume = { score: 10, detail: "High volume confirming the move" }; }
  else if (s.volume === "AVERAGE") { totalScore += 5; breakdown.volume = { score: 5, detail: "Average volume — acceptable" }; }
  else { totalScore += 0; breakdown.volume = { score: 0, detail: "Low volume — weak signal" }; }

  // LAYER 5 — Big money alignment (max 10 points)
  const unusual = s.unusualActivity || unusualMap?.[s.symbol];
  if (unusual?.bigMoney === "BULLISH" && direction === "CALL") { totalScore += 10; breakdown.bigMoney = { score: 10, detail: "Institutional money buying calls" }; }
  else if (unusual?.bigMoney === "BEARISH" && direction === "PUT") { totalScore += 10; breakdown.bigMoney = { score: 10, detail: "Institutional money buying puts" }; }
  else { totalScore += 3; breakdown.bigMoney = { score: 3, detail: "No unusual institutional activity" }; }

  // LAYER 6 — Market conditions (max 10 points)
  const dayBonus = dayType === "TRENDING" && ["CONTINUATION","BREAKOUT","MOMENTUM_SCALP","TREND_FOLLOWING","VOLUME_SPIKE"].includes(path?.strategy) ? 10 :
                   dayType === "CHOPPY" && ["OVERSOLD_BOUNCE","SUPPORT_BOUNCE","SMC","VWAP_RECLAIM"].includes(path?.strategy) ? 10 :
                   dayType === "EXTREME_VOLATILE" ? -20 : 5;
  totalScore += Math.max(0, dayBonus);
  breakdown.market = { score: Math.max(0, dayBonus), detail: `${dayType} day — ${dayBonus >= 10 ? "perfect" : dayBonus >= 5 ? "suitable" : "poor"} for this pattern` };

  // LAYER 7 — Momentum not exhausted (max 5 points)
  const exhaustion = s.momentum?.exhaustionLevel;
  if (exhaustion === "FRESH") { totalScore += 5; breakdown.exhaustion = { score: 5, detail: "Fresh move — plenty of room" }; }
  else if (exhaustion === "EXTENDED") { totalScore += 2; breakdown.exhaustion = { score: 2, detail: "Slightly extended" }; }
  else { totalScore += 0; breakdown.exhaustion = { score: 0, detail: "Exhausted — move may be done" }; }

  // HARD BLOCKS — override everything
  const blocks = [];
  if (["VERY_EXHAUSTED","EXTREMELY_EXHAUSTED"].includes(exhaustion)) { blocks.push("Already moved too much"); totalScore = Math.min(totalScore, 20); }
  if (s.intraday?.realtimeTrend === "SIDEWAYS" && !path?.entryReady) { blocks.push("Stock not moving"); totalScore = Math.min(totalScore, 25); }
  if (earningsMap?.[s.symbol]) { blocks.push("Earnings risk"); totalScore = Math.min(totalScore, 30); }
  if (s.relativeStrength?.isExtended) { blocks.push("Moved too far vs market"); totalScore = Math.min(totalScore, 25); }

  return {
    symbol: s.symbol,
    totalScore: Math.max(0, Math.min(100, Math.round(totalScore))),
    path: path || null,
    allPaths: pathResult?.allPaths || [],
    breakdown,
    blocks,
    entryReady: path?.entryReady || false,
    direction: path?.direction || "CALL",
    patternDescription: path?.description || "No clear pattern",
    fvgZone: path?.fvgZone || null,
    stepInfo: path ? `Step ${path.step} of ${path.totalSteps} — ${path.name}` : "No pattern"
  };
}

// ─── MTF-Aware Pattern Scoring ───────────────────────────────────────────────
// Same as scoreStockWithPattern but uses correct timeframe data per strategy
function scoreStockWithPatternMTF(stock, spyChange, dayType, socialMap, unusualMap, earningsMap, marketContext) {
  const s = stock;
  const mtf = s.multiTimeframe || {};
  
  let totalScore = 0;
  const breakdown = {};
  let bestPath = null;
  let bestPathScore = 0;

  // Find the best pattern across all timeframes
  // Each strategy checked on its optimal timeframe
  const strategyPaths = [];
  
  Object.entries(mtf).forEach(([stratKey, tfData]) => {
    if (!tfData || !tfData.suitableForDayTrade) return; // Skip weekly/monthly timeframes
    
    // Run pattern identification on this timeframe's data
    const tempStock = {
      ...s,
      chartPatterns: tfData.chartPatterns || [],
      smcAnalysis: tfData.smcAnalysis || null,
      divergence: tfData.divergence || null,
      intraday: s.intraday // Keep intraday for VWAP etc
    };
    
    const pathResult = identifyChartPath(tempStock);
    if (pathResult?.bestPath) {
      strategyPaths.push({
        ...pathResult.bestPath,
        timeframe: tfData.timeframe,
        interval: tfData.interval,
        strategyKey: stratKey,
        resolutionTime: tfData.patternResolutionTime,
        // Bonus for matching timeframe to strategy
        timeframeBonus: pathResult.bestPath.strategy === stratKey ? 15 : 5
      });
    }
  });
  
  // Also check daily patterns from original data
  const dailyPathResult = identifyChartPath(s);
  if (dailyPathResult?.bestPath) {
    // Only add daily patterns for swing strategies
    const swingStrategies = ["TREND_FOLLOWING","OVERSOLD_BOUNCE","GAP_FILL"];
    if (swingStrategies.includes(dailyPathResult.bestPath.strategy)) {
      strategyPaths.push({
        ...dailyPathResult.bestPath,
        timeframe: "daily",
        interval: "1d",
        strategyKey: dailyPathResult.bestPath.strategy,
        resolutionTime: "1-4 weeks",
        timeframeBonus: 10
      });
    }
  }
  
  // Pick best path — prioritize intraday patterns and entry-ready setups
  strategyPaths.sort((a, b) => {
    // Prioritize entry ready
    if (a.entryReady && !b.entryReady) return -1;
    if (!a.entryReady && b.entryReady) return 1;
    // Then by step progress
    const aProgress = a.step / a.totalSteps;
    const bProgress = b.step / b.totalSteps;
    if (aProgress !== bProgress) return bProgress - aProgress;
    // Then by timeframe bonus
    return b.timeframeBonus - a.timeframeBonus;
  });
  
  bestPath = strategyPaths[0] || null;

  // LAYER 1 — Pattern score (max 30 points)
  if (bestPath) {
    const patternScore = Math.round((bestPath.step / bestPath.totalSteps) * 30) + (bestPath.timeframeBonus || 0);
    totalScore += Math.min(30, patternScore);
    breakdown.pattern = { 
      score: Math.min(30, patternScore), 
      detail: `${bestPath.name} on ${bestPath.timeframe} chart — Step ${bestPath.step}/${bestPath.totalSteps}`,
      timeframe: bestPath.timeframe,
      resolutionTime: bestPath.resolutionTime
    };
  } else {
    breakdown.pattern = { score: 0, detail: "No clear pattern on any timeframe" };
  }

  // LAYER 2 — Entry trigger ready (max 20 points)
  if (bestPath?.entryReady) {
    totalScore += 20;
    breakdown.entry = { score: 20, detail: `Entry trigger met on ${bestPath?.timeframe} chart` };
  } else if (bestPath && bestPath.step / bestPath.totalSteps >= 0.6) {
    totalScore += 10;
    breakdown.entry = { score: 10, detail: "Close to entry — watching" };
  } else {
    breakdown.entry = { score: 0, detail: "Not near entry yet" };
  }

  // LAYERS 3-7 same as before
  const social = s.socialSentiment || socialMap?.[s.symbol] || {};
  const direction = bestPath?.direction || "CALL";
  if (social.label === "BULLISH" && direction === "CALL") { totalScore += 15; breakdown.news = { score: 15, detail: "Bullish news confirms direction" }; }
  else if (social.label === "BEARISH" && direction === "PUT") { totalScore += 15; breakdown.news = { score: 15, detail: "Bearish news confirms direction" }; }
  else if (social.label === "NEUTRAL") { totalScore += 7; breakdown.news = { score: 7, detail: "Neutral news" }; }
  else { totalScore += 0; breakdown.news = { score: 0, detail: "News conflicts with pattern" }; }

  if (s.volume === "HIGH") { totalScore += 10; breakdown.volume = { score: 10, detail: "High volume confirming move" }; }
  else if (s.volume === "AVERAGE") { totalScore += 5; breakdown.volume = { score: 5, detail: "Average volume" }; }
  else { totalScore += 0; breakdown.volume = { score: 0, detail: "Low volume — weak signal" }; }

  const unusual = s.unusualActivity || unusualMap?.[s.symbol];
  if (unusual?.bigMoney === "BULLISH" && direction === "CALL") { totalScore += 10; breakdown.bigMoney = { score: 10, detail: "Institutions buying calls" }; }
  else if (unusual?.bigMoney === "BEARISH" && direction === "PUT") { totalScore += 10; breakdown.bigMoney = { score: 10, detail: "Institutions buying puts" }; }
  else { totalScore += 3; breakdown.bigMoney = { score: 3, detail: "No unusual activity" }; }

  const dayBonus = dayType === "TRENDING" && ["CONTINUATION","BREAKOUT","MOMENTUM_SCALP","TREND_FOLLOWING","VOLUME_SPIKE"].includes(bestPath?.strategy) ? 10 :
                   dayType === "CHOPPY" && ["OVERSOLD_BOUNCE","SUPPORT_BOUNCE","SMC","VWAP_RECLAIM"].includes(bestPath?.strategy) ? 10 :
                   dayType === "EXTREME_VOLATILE" ? -20 : 5;
  totalScore += Math.max(0, dayBonus);
  breakdown.market = { score: Math.max(0, dayBonus), detail: `${dayType} day` };

  const exhaustion = s.momentum?.exhaustionLevel;
  if (exhaustion === "FRESH") { totalScore += 5; breakdown.exhaustion = { score: 5, detail: "Fresh move" }; }
  else if (exhaustion === "EXTENDED") { totalScore += 2; breakdown.exhaustion = { score: 2, detail: "Slightly extended" }; }
  else { breakdown.exhaustion = { score: 0, detail: "Exhausted" }; }

  // HARD BLOCKS
  const blocks = [];
  if (["VERY_EXHAUSTED","EXTREMELY_EXHAUSTED"].includes(exhaustion)) { blocks.push("Already moved too much"); totalScore = Math.min(totalScore, 20); }
  if (s.intraday?.realtimeTrend === "SIDEWAYS" && !bestPath?.entryReady) { blocks.push("Not moving"); totalScore = Math.min(totalScore, 25); }
  if (earningsMap?.[s.symbol]) { blocks.push("Earnings risk"); totalScore = Math.min(totalScore, 30); }
  if (s.relativeStrength?.isExtended) { blocks.push("Too extended vs market"); totalScore = Math.min(totalScore, 25); }

  return {
    symbol: s.symbol,
    totalScore: Math.max(0, Math.min(100, Math.round(totalScore))),
    path: bestPath,
    allPaths: strategyPaths,
    breakdown,
    blocks,
    entryReady: bestPath?.entryReady || false,
    direction: bestPath?.direction || "CALL",
    patternDescription: bestPath?.description || "No clear pattern",
    fvgZone: bestPath?.fvgZone || null,
    stepInfo: bestPath ? `${bestPath.name} — Step ${bestPath.step}/${bestPath.totalSteps} (${bestPath.timeframe} chart)` : "No pattern",
    timeframe: bestPath?.timeframe || "—",
    resolutionTime: bestPath?.resolutionTime || "—"
  };
}

// ─── Full Strategy Scoring Engine ────────────────────────────────────────────
// Runs ALL strategies against current conditions and picks the best one
function selectBestStrategy(data, strategyMemory, marketRegime, spyChange, summaries, dayType) {
  const sm = strategyMemory;
  const perf = sm.strategyPerformance || {};
  const trades = data.trades || [];
  const edLevel = getEducationLevel(data, sm);
  const dayT = dayType || "UNCLEAR";

  // Run ALL available strategies through the scoring engine
  const scoredStrategies = Object.entries(STRATEGIES)
    .filter(([,s]) => s.educationLevel <= edLevel)
    .map(([key, s]) => {
      // Historical performance weight (20% of score)
      const p = perf[key] || { wins:0, losses:0, totalPnl:0 };
      const totalTrades = p.wins + p.losses;
      const historicalWR = totalTrades > 0 ? p.wins/totalTrades : 0.5;
      const historicalScore = historicalWR * 20;

      // Day type compatibility score (40% of score) — using strategy's own scoring function
      // We use average across top stocks since we may not have summaries yet
      let conditionScore = 0;
      if (summaries && summaries.length > 0) {
        const topStocks = summaries.slice(0, 3);
        const avgScore = topStocks.reduce((sum, stock) => {
          return sum + (s.scoreConditions ? s.scoreConditions(stock, spyChange, dayT) : 50);
        }, 0) / topStocks.length;
        conditionScore = avgScore * 0.4;
      } else {
        // Fallback scoring without stock data
        if (dayT === "TRENDING" && ["MOMENTUM_SCALP","TREND_FOLLOWING","CONTINUATION"].includes(key)) conditionScore = 40;
        else if (dayT === "CHOPPY" && ["OVERSOLD_BOUNCE","SUPPORT_BOUNCE","GAP_FILL"].includes(key)) conditionScore = 40;
        else if (dayT === "NEWS_DRIVEN" && ["NEWS_CATALYST","VOLUME_SPIKE","MOMENTUM_SCALP"].includes(key)) conditionScore = 35;
        else conditionScore = 20;
      }

      // Recent performance penalty (20% of score)
      const recentTrades = trades.slice(0,10).filter(t => t.strategy === key);
      const recentWins = recentTrades.filter(t => t.result === "win").length;
      let recentScore = 20; // Default
      if (recentTrades.length >= 3) {
        recentScore = (recentWins / recentTrades.length) * 20;
      }

      // Win rate target bonus (20% of score)
      const targetScore = (s.winRateTarget / 100) * 20;

      const totalScore = Math.round(historicalScore + conditionScore + recentScore + targetScore);

      return { 
        key, 
        ...s, 
        score: totalScore,
        scoreBreakdown: {
          historical: Math.round(historicalScore),
          conditions: Math.round(conditionScore),
          recent: Math.round(recentScore),
          target: Math.round(targetScore)
        },
        performance: p 
      };
    })
    .sort((a,b) => b.score - a.score);

  const winner = scoredStrategies[0] || { key:"MOMENTUM_SCALP", ...STRATEGIES.MOMENTUM_SCALP };
  winner.allStrategiesScored = scoredStrategies.map(s => ({
    key: s.key, name: s.name, score: s.score, breakdown: s.scoreBreakdown
  }));
  
  return winner;
}

// ─── Performance Coach Analysis ───────────────────────────────────────────────
function analyzePerformance(data, strategyMemory) {
  const trades = data.trades || [];
  if (trades.length < 3) return { hasInsights: false, message: "Complete at least 3 trades to unlock your personal performance analysis!" };

  const insights = [];
  const wins = trades.filter(t => t.result === "win");
  const losses = trades.filter(t => t.result === "loss");
  const winRate = trades.length > 0 ? Math.round(wins.length/trades.length*100) : 0;
  const totalPnl = trades.reduce((s,t) => s+(t.pnl||0), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s,t)=>s+(t.pnl||0),0)/wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s,t)=>s+(t.pnl||0),0)/losses.length) : 0;

  // Time of day analysis
  const morningTrades = trades.filter(t => { const h=new Date(t.date).getHours(); return h>=9&&h<12; });
  const afternoonTrades = trades.filter(t => { const h=new Date(t.date).getHours(); return h>=12&&h<16; });
  const mWins = morningTrades.filter(t=>t.result==="win").length;
  const aWins = afternoonTrades.filter(t=>t.result==="win").length;
  const mWR = morningTrades.length>0?Math.round(mWins/morningTrades.length*100):0;
  const aWR = afternoonTrades.length>0?Math.round(aWins/afternoonTrades.length*100):0;
  if (morningTrades.length >= 2 && afternoonTrades.length >= 2) {
    if (mWR > aWR + 15) insights.push({ type:"TIME", icon:"⏰", title:"Trade in the Morning!", message:`You win ${mWR}% of morning trades but only ${aWR}% in the afternoon. Stick to 9:30 AM – 12 PM ET for your best results.`, positive:true });
    else if (aWR > mWR + 15) insights.push({ type:"TIME", icon:"⏰", title:"Afternoon Trader!", message:`You actually do better in the afternoon (${aWR}% win rate vs ${mWR}% morning). Your best window is 12 PM – 3 PM ET.`, positive:true });
  }

  // CALL vs PUT analysis
  const callTrades = trades.filter(t=>t.optionType==="CALL");
  const putTrades = trades.filter(t=>t.optionType==="PUT");
  const callWR = callTrades.length>0?Math.round(callTrades.filter(t=>t.result==="win").length/callTrades.length*100):0;
  const putWR = putTrades.length>0?Math.round(putTrades.filter(t=>t.result==="win").length/putTrades.length*100):0;
  if (callTrades.length>=2&&putTrades.length>=2) {
    if (callWR > putWR + 20) insights.push({ type:"DIRECTION", icon:"📈", title:"You're a CALL Trader!", message:`Your CALL win rate is ${callWR}% vs ${putWR}% for PUTs. Focus on bullish trades — that's your edge.`, positive:true });
    else if (putWR > callWR + 20) insights.push({ type:"DIRECTION", icon:"📉", title:"You're a PUT Trader!", message:`Your PUT win rate is ${putWR}% vs ${callWR}% for CALLs. You read downward moves better — lean into that.`, positive:true });
  }

  // Consecutive loss warning
  const recent5 = trades.slice(0,5);
  const recentLosses = recent5.filter(t=>t.result==="loss").length;
  if (recentLosses >= 3) insights.push({ type:"WARNING", icon:"⚠️", title:"Losing Streak Detected", message:`You've lost ${recentLosses} of your last 5 trades. Consider reducing position size by 50% and only taking HIGH confidence signals until you get 2 wins.`, positive:false });

  // Win streak encouragement
  const recentWins5 = recent5.filter(t=>t.result==="win").length;
  if (recentWins5 >= 4) insights.push({ type:"STREAK", icon:"🔥", title:"You're on Fire!", message:`${recentWins5} wins in your last 5 trades! Your read on the market is strong right now. Stay disciplined — don't get overconfident.`, positive:true });

  // Risk/reward analysis
  if (avgWin > 0 && avgLoss > 0) {
    const rr = avgWin/avgLoss;
    if (rr < 1.2) insights.push({ type:"RR", icon:"⚖️", title:"Improve Your Risk/Reward", message:`Your average win ($${avgWin.toFixed(2)}) is only ${rr.toFixed(1)}x your average loss ($${avgLoss.toFixed(2)}). Try to let winners run longer and cut losers faster. Target at least 1.5:1.`, positive:false });
    else if (rr > 2) insights.push({ type:"RR", icon:"⚖️", title:"Excellent Risk Management!", message:`Your wins average ${rr.toFixed(1)}x your losses — that's professional-level risk management. Keep it up!`, positive:true });
  }

  // Strategy performance
  const stratPerf = strategyMemory.strategyPerformance || {};
  const bestStrategy = Object.entries(stratPerf).sort((a,b)=>{
    const aWR = (a[1].wins||0)/Math.max(1,(a[1].wins||0)+(a[1].losses||0));
    const bWR = (b[1].wins||0)/Math.max(1,(b[1].wins||0)+(b[1].losses||0));
    return bWR - aWR;
  })[0];
  if (bestStrategy && (bestStrategy[1].wins+bestStrategy[1].losses) >= 3) {
    const bsWR = Math.round(bestStrategy[1].wins/Math.max(1,bestStrategy[1].wins+bestStrategy[1].losses)*100);
    insights.push({ type:"STRATEGY", icon:"🎯", title:"Your Best Strategy", message:`${STRATEGIES[bestStrategy[0]]?.name || bestStrategy[0]} is working best for you with a ${bsWR}% win rate. The AI is prioritizing this strategy in recommendations.`, positive:true });
  }

  return {
    hasInsights: true,
    winRate, totalPnl, avgWin, avgLoss,
    totalTrades: trades.length,
    insights,
    summary: `${winRate}% win rate across ${trades.length} trades. Total P&L: ${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}.`
  };
}

// ─── Should AI adapt strategy? ────────────────────────────────────────────────
function shouldAdaptStrategy(data, strategyMemory) {
  const trades = data.trades || [];
  const last = strategyMemory.lastAdaptation;
  if (!last && trades.length >= 5) return true;
  if (last) {
    const tradesSinceLast = trades.filter(t => new Date(t.date) > new Date(last)).length;
    const recent5 = trades.slice(0,5);
    const recentLosses = recent5.filter(t=>t.result==="loss").length;
    if (recentLosses >= 3) return true; // Losing streak — adapt immediately
    if (tradesSinceLast >= 5) return true; // After every 5 trades
  }
  return false;
}

// ─── Watchlists by balance ────────────────────────────────────────────────────
const CHEAP_WATCHLIST = ["SOUN","SOFI","MARA","RIOT","PLTR","HOOD","AAL","VALE","CLSK","GRAB","TELL","NKLA","WKHS","SPCE","CRON","SAVE","NIO","XPEV","PLUG","BBAI","CLOV","OPEN","EXPR","FUBO","HIMS"];
const MID_WATCHLIST   = ["TSLA","AMD","NVDA","AAPL","AMZN","META","SPY","QQQ","COIN","RBLX"];
const HIGH_WATCHLIST  = ["TSLA","NVDA","AAPL","AMZN","META","MSFT","GOOGL","SPY","QQQ","GS"];

// ─── Correlation Groups ───────────────────────────────────────────────────────
// When A moves, B and C tend to follow
const CORRELATION_GROUPS = {
  CRYPTO_MINING: {
    name: "Crypto Mining",
    leader: "BTC-USD",
    stocks: ["MARA","RIOT","CLSK","BITF","HUT"],
    description: "All mine Bitcoin — when BTC goes up they ALL go up",
    emoji: "₿",
    trigger: "Bitcoin price change"
  },
  EV_CHINA: {
    name: "Chinese EVs",
    leader: "NIO",
    stocks: ["NIO","XPEV","LI"],
    description: "Chinese electric vehicles — move together on China news",
    emoji: "🚗",
    trigger: "China policy or EV sector news"
  },
  AIRLINES: {
    name: "Airlines",
    leader: "AAL",
    stocks: ["AAL","DAL","UAL","SAVE","JBLU"],
    description: "All airlines move together on fuel prices and travel demand",
    emoji: "✈️",
    trigger: "Oil prices or travel demand news"
  },
  SEMICONDUCTORS: {
    name: "Semiconductors",
    leader: "NVDA",
    stocks: ["NVDA","AMD","INTC","QCOM","MU"],
    description: "Chip makers — NVDA leads, AMD follows",
    emoji: "💻",
    trigger: "AI demand or chip supply news"
  },
  GREEN_ENERGY: {
    name: "Green Energy",
    leader: "PLUG",
    stocks: ["PLUG","FCEL","ENPH","SPWR","RUN"],
    description: "Alternative energy stocks move on government policy",
    emoji: "🌱",
    trigger: "Energy policy or climate news"
  },
  MEME_STOCKS: {
    name: "High Volatility",
    leader: "SOUN",
    stocks: ["SOUN","BBAI","CLOV","FUBO","SPCE"],
    description: "High retail interest stocks — move on social sentiment",
    emoji: "🚀",
    trigger: "Social media buzz or short squeeze"
  },
  FINTECH: {
    name: "Fintech",
    leader: "SOFI",
    stocks: ["SOFI","HOOD","AFRM","UPST"],
    description: "Financial technology — move on interest rates and fintech news",
    emoji: "💳",
    trigger: "Fed rate decisions or banking news"
  },
  MINING_METALS: {
    name: "Mining & Metals",
    leader: "VALE",
    stocks: ["VALE","FCX","NEM","GOLD"],
    description: "Metal miners move on commodity prices and global demand",
    emoji: "⛏️",
    trigger: "Commodity prices or global economic data"
  }
};

// Find which group a stock belongs to
function getStockCorrelation(symbol) {
  for (const [groupKey, group] of Object.entries(CORRELATION_GROUPS)) {
    if (group.stocks.includes(symbol)) {
      return { groupKey, ...group };
    }
  }
  return null;
}

// Find correlated laggards — stocks in same group that haven't moved yet
function findCorrelatedLaggards(symbol, marketDataMap, spyChange) {
  const group = getStockCorrelation(symbol);
  if (!group) return [];
  
  const leadingStock = marketDataMap[symbol];
  if (!leadingStock) return [];
  
  const leadChange = leadingStock.priceData?.change || 0;
  
  // Find stocks in same group that moved LESS than the leader
  return group.stocks
    .filter(s => s !== symbol && marketDataMap[s])
    .map(s => {
      const stock = marketDataMap[s];
      const stockChange = stock.priceData?.change || 0;
      const lag = leadChange - stockChange;
      return {
        symbol: s,
        change: stockChange,
        leadChange,
        lag: parseFloat(lag.toFixed(2)),
        isLaggard: lag > 5, // Lagging by more than 5%
        description: lag > 5 
          ? `${s} is up ${stockChange.toFixed(1)}% while ${symbol} is up ${leadChange.toFixed(1)}% — ${s} is lagging by ${lag.toFixed(1)}% and may catch up`
          : `${s} is moving similarly to ${symbol}`
      };
    })
    .filter(s => s.isLaggard)
    .sort((a,b) => b.lag - a.lag);
}

function getWatchlist(balance) {
  if (balance < 100)  return CHEAP_WATCHLIST;
  if (balance < 500)  return [...CHEAP_WATCHLIST.slice(0,5), ...MID_WATCHLIST.slice(0,6)];
  if (balance < 2000) return MID_WATCHLIST;
  return HIGH_WATCHLIST;
}

function getTradeCount(balance, marketTrend, topScore) {
  if (balance < 100)  return 1;
  if (balance < 300)  return topScore>=75 && !marketTrend.includes("BEAR") ? 2 : 1;
  if (balance < 1000) return topScore>=70 ? 2 : 1;
  return topScore>=75 ? 3 : 2;
}

// ─── Email ────────────────────────────────────────────────────────────────────
const activeMonitors = {};
async function sendAlertEmail(to, subject, html) {
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASSWORD) return false;
  try {
    const t = nodemailer.createTransport({ service:"gmail", auth:{ user:process.env.ALERT_EMAIL, pass:process.env.ALERT_EMAIL_PASSWORD } });
    await t.sendMail({ from:process.env.ALERT_EMAIL, to, subject, html });
    return true;
  } catch(e) { console.error("Email:", e.message); return false; }
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────
async function getQuote(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`, { headers:{"User-Agent":"Mozilla/5.0"} });
  if (!r.ok) throw new Error(`Quote ${symbol}: ${r.status}`);
  return r.json();
}
async function getOptions(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`, { headers:{"User-Agent":"Mozilla/5.0"} });
  if (!r.ok) return null;
  return r.json();
}
async function getCurrentPrice(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, { headers:{"User-Agent":"Mozilla/5.0"} });
  const d = await r.json();
  return parseFloat(d.chart.result[0].meta.regularMarketPrice.toFixed(2));
}

// ─── News & Sentiment ─────────────────────────────────────────────────────────
async function getStockNews(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5`, { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    return (d.news||[]).slice(0,4).map(n => ({ title:n.title, publisher:n.publisher, time:new Date(n.providerPublishTime*1000).toLocaleString() }));
  } catch(e) { return []; }
}

async function getFearGreedIndex() {
  try {
    const r = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    return { score:Math.round(d.fear_and_greed?.score||50), rating:d.fear_and_greed?.rating||"Neutral" };
  } catch(e) { return { score:50, rating:"Neutral" }; }
}

// ─── VIX Fear Index ───────────────────────────────────────────────────────────
async function getVIX() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d", { headers: {"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const price = d.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price) return { value: 20, level: "NORMAL", description: "VIX unavailable" };
    const vix = parseFloat(price.toFixed(2));
    const level = vix > 40 ? "EXTREME_FEAR" : vix > 30 ? "HIGH_FEAR" : vix > 20 ? "ELEVATED" : vix > 12 ? "NORMAL" : "LOW";
    const optionCost = vix > 30 ? "Options are VERY EXPENSIVE today due to high fear" : vix > 20 ? "Options are slightly expensive" : "Options are normally priced today";
    const tradingAdvice = vix > 40 ? "AVOID TRADING — extreme fear makes options unpredictable and expensive" : vix > 30 ? "REDUCE position size by 50% — high volatility inflates option prices" : vix > 20 ? "Trade normally but be cautious" : "Good conditions for trading";
    return { value: vix, level, optionCost, tradingAdvice, description: `VIX at ${vix} — ${level.replace(/_/g," ")}` };
  } catch(e) { return { value: 20, level: "NORMAL", description: "VIX data unavailable", tradingAdvice: "Trade normally" }; }
}

// ─── Bitcoin/Crypto Correlation ───────────────────────────────────────────────
async function getCryptoCorrelation() {
  try {
    const [btcR, ethR] = await Promise.allSettled([
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=2d", { headers: {"User-Agent":"Mozilla/5.0"} }),
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?interval=1d&range=2d", { headers: {"User-Agent":"Mozilla/5.0"} })
    ]);
    let btcChange = 0, ethChange = 0, btcPrice = 0;
    if (btcR.status === "fulfilled") {
      const d = await btcR.value.json();
      const meta = d.chart?.result?.[0]?.meta;
      btcPrice = parseFloat(meta?.regularMarketPrice?.toFixed(2) || 0);
      const prev = parseFloat(meta?.chartPreviousClose?.toFixed(2) || btcPrice);
      btcChange = parseFloat(((btcPrice - prev) / prev * 100).toFixed(2));
    }
    if (ethR.status === "fulfilled") {
      const d = await ethR.value.json();
      const meta = d.chart?.result?.[0]?.meta;
      const ep = parseFloat(meta?.regularMarketPrice || 0);
      const prev = parseFloat(meta?.chartPreviousClose || ep);
      ethChange = parseFloat(((ep - prev) / prev * 100).toFixed(2));
    }
    const cryptoMood = btcChange > 3 ? "STRONGLY BULLISH" : btcChange > 1 ? "BULLISH" : btcChange < -3 ? "STRONGLY BEARISH" : btcChange < -1 ? "BEARISH" : "NEUTRAL";
    const impact = btcChange > 2 ? "MARA and RIOT calls are likely profitable — crypto stocks follow Bitcoin" : btcChange < -2 ? "MARA and RIOT puts may be better — crypto stocks are falling with Bitcoin" : "Neutral crypto impact on mining stocks";
    return { btcPrice, btcChange, ethChange, cryptoMood, impact, description: `Bitcoin ${btcChange >= 0 ? "+" : ""}${btcChange}% today` };
  } catch(e) { return { btcChange: 0, cryptoMood: "NEUTRAL", impact: "Crypto data unavailable", description: "Bitcoin data unavailable" }; }
}

// ─── Google Trends proxy (via Yahoo trending + news volume) ───────────────────
async function getSocialSentiment(symbols) {
  const sentiment = {};
  for (const sym of symbols.slice(0, 4)) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&newsCount=8&enableFuzzyQuery=false`, { headers: {"User-Agent":"Mozilla/5.0"} });
      const d = await r.json();
      const news = d.news || [];
      const recentNews = news.filter(n => Date.now() - n.providerPublishTime * 1000 < 24 * 60 * 60 * 1000);
      // Analyze headlines for sentiment words
      const bullishWords = ["surge", "jump", "gain", "rise", "rally", "bull", "buy", "upgrade", "beat", "profit", "growth", "up", "high", "record", "strong", "positive", "boost"];
      const bearishWords = ["drop", "fall", "loss", "down", "bear", "sell", "downgrade", "miss", "decline", "weak", "negative", "cut", "low", "risk", "concern", "warn"];
      let bullScore = 0, bearScore = 0;
      recentNews.forEach(n => {
        const title = (n.title || "").toLowerCase();
        bullishWords.forEach(w => { if (title.includes(w)) bullScore++; });
        bearishWords.forEach(w => { if (title.includes(w)) bearScore++; });
      });
      const total = bullScore + bearScore;
      const sentimentScore = total > 0 ? Math.round((bullScore / total) * 100) : 50;
      sentiment[sym] = {
        newsCount: recentNews.length,
        bullScore, bearScore, sentimentScore,
        label: sentimentScore > 65 ? "BULLISH" : sentimentScore < 35 ? "BEARISH" : "NEUTRAL",
        headlines: recentNews.slice(0, 3).map(n => n.title),
        buzz: recentNews.length > 5 ? "HIGH BUZZ" : recentNews.length > 2 ? "MODERATE" : "LOW BUZZ"
      };
    } catch(e) { sentiment[sym] = { sentimentScore: 50, label: "NEUTRAL", buzz: "UNKNOWN", headlines: [] }; }
  }
  return sentiment;
}

// ─── Finnhub — Better News & Insider Data ────────────────────────────────────
async function getFinnhubNews(symbol) {
  try {
    const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "demo";
    const to = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().split("T")[0];
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${FINNHUB_KEY}`, 
      { headers: {"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    if (!Array.isArray(d)) return null;
    const articles = d.slice(0,5).map(a => ({
      headline: a.headline,
      sentiment: a.sentiment || 0,
      source: a.source,
      time: new Date(a.datetime*1000).toLocaleString()
    }));
    const avgSentiment = articles.length > 0 ? articles.reduce((s,a)=>s+(a.sentiment||0),0)/articles.length : 0;
    return {
      articles,
      sentimentScore: parseFloat(avgSentiment.toFixed(3)),
      sentimentLabel: avgSentiment > 0.3 ? "BULLISH" : avgSentiment < -0.3 ? "BEARISH" : "NEUTRAL",
      source: "Finnhub"
    };
  } catch(e) { return null; }
}

async function getFinnhubInsider(symbol) {
  try {
    const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "demo";
    const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${FINNHUB_KEY}`,
      { headers: {"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const transactions = (d.data||[]).slice(0,5);
    const recentBuys = transactions.filter(t => t.transactionType === "Buy" || t.transactionType === "P-Purchase");
    const recentSells = transactions.filter(t => t.transactionType === "Sell" || t.transactionType === "S-Sale");
    if (transactions.length === 0) return null;
    return {
      recentBuys: recentBuys.length,
      recentSells: recentSells.length,
      signal: recentBuys.length > recentSells.length ? "BULLISH_INSIDER" : recentSells.length > recentBuys.length ? "BEARISH_INSIDER" : "NEUTRAL",
      plainEnglish: recentBuys.length > 0 ? `${recentBuys.length} company insiders bought their own stock recently — bullish signal` : recentSells.length > 0 ? `${recentSells.length} insiders sold recently — bearish signal` : "No recent insider activity"
    };
  } catch(e) { return null; }
}

// ─── FRED — Economic Calendar ─────────────────────────────────────────────────
async function getFREDEconomicEvents() {
  try {
    // FRED provides series data — we check key indicators
    const r = await fetch("https://api.stlouisfed.org/fred/releases/dates?api_key=demo&file_type=json&limit=10",
      { headers: {"User-Agent":"Mozilla/5.0"} });
    // Fallback to manual economic calendar since FRED requires API key
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun, 6=Sat
    const hour = today.getHours();
    
    const events = [];
    // First Friday of month = Jobs Report (8:30 AM ET)
    const isFirstFriday = dayOfWeek === 5 && today.getDate() <= 7;
    if (isFirstFriday) events.push({ name:"JOBS REPORT", time:"8:30 AM ET", impact:"EXTREME", warning:"🚨 Jobs report today — market will make a big move at 8:30 AM. Do not trade options before 10 AM today." });
    // Third Wednesday = Fed Meeting possibility  
    const isWed = dayOfWeek === 3;
    if (isWed && today.getDate() >= 15 && today.getDate() <= 21) events.push({ name:"POTENTIAL FED MEETING", time:"2:00 PM ET", impact:"HIGH", warning:"⚠️ Possible Fed announcement at 2 PM. Market could swing hard. Close all positions by 1:45 PM." });
    // General time warnings
    if (hour >= 8 && hour < 10) events.push({ name:"PRE-MARKET", time:"Now", impact:"MEDIUM", warning:"⏰ Market opens in less than 2 hours. Big gaps possible. Wait until 10 AM to trade." });
    if (hour >= 15) events.push({ name:"POWER HOUR", time:"3:00-4:00 PM ET", impact:"HIGH", warning:"⚡ Last hour of trading — very volatile. Close positions before 3:45 PM." });
    
    return events;
  } catch(e) { return []; }
}

// ─── CoinGecko — Better Bitcoin Data ─────────────────────────────────────────
async function getCoinGeckoCrypto() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true",
      { headers: {"User-Agent":"Mozilla/5.0", "Accept":"application/json"} });
    const d = await r.json();
    const btc = d.bitcoin;
    const eth = d.ethereum;
    if (!btc) return null;
    
    const btcChange = parseFloat((btc.usd_24h_change||0).toFixed(2));
    const ethChange = parseFloat((eth?.usd_24h_change||0).toFixed(2));
    const btcVol = btc.usd_24h_vol || 0;
    
    // High volume + price change = strong signal
    const volStrength = btcVol > 50000000000 ? "HIGH" : btcVol > 20000000000 ? "MEDIUM" : "LOW";
    const mood = btcChange > 3 ? "STRONGLY_BULLISH" : btcChange > 1 ? "BULLISH" : btcChange < -3 ? "STRONGLY_BEARISH" : btcChange < -1 ? "BEARISH" : "NEUTRAL";
    
    return {
      btcPrice: parseFloat(btc.usd.toFixed(2)),
      btcChange24h: btcChange,
      ethChange24h: ethChange,
      btcVolume: btcVol,
      volumeStrength: volStrength,
      mood,
      miningStockImpact: btcChange > 2 ? `Bitcoin up ${btcChange}% — MARA and RIOT calls likely profitable right now` : btcChange < -2 ? `Bitcoin down ${Math.abs(btcChange)}% — avoid MARA and RIOT calls` : `Bitcoin flat — neutral impact on mining stocks`,
      source: "CoinGecko"
    };
  } catch(e) { return null; }
}

// ─── Alpha Vantage — Better Options Data ─────────────────────────────────────
async function getAlphaVantageOptions(symbol) {
  try {
    const AV_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
    const r = await fetch(`https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${symbol}&apikey=${AV_KEY}`,
      { headers: {"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    if (!d.data || !Array.isArray(d.data)) return null;
    
    // Find affordable calls with good liquidity
    const calls = d.data
      .filter(o => o.type === "call" && parseFloat(o.ask) > 0 && parseFloat(o.ask) < 1.0)
      .map(o => ({
        strike: parseFloat(o.strike),
        ask: parseFloat(o.ask),
        bid: parseFloat(o.bid),
        spread: parseFloat((o.ask - o.bid).toFixed(3)),
        spreadPct: parseFloat(((o.ask-o.bid)/o.ask*100).toFixed(1)),
        openInterest: parseInt(o.open_interest)||0,
        volume: parseInt(o.volume)||0,
        delta: parseFloat(o.delta||0).toFixed(3),
        theta: parseFloat(o.theta||0).toFixed(3),
        impliedVol: parseFloat(o.implied_volatility||0).toFixed(3),
        expiration: o.expiration,
        totalCost: parseFloat((parseFloat(o.ask)*100).toFixed(2)),
        isLiquid: parseInt(o.open_interest||0) >= 50 && parseFloat(o.ask-o.bid) <= 0.06,
        grade: parseInt(o.open_interest||0) >= 100 && parseFloat(o.ask-o.bid) <= 0.04 ? "A" : parseInt(o.open_interest||0) >= 50 && parseFloat(o.ask-o.bid) <= 0.06 ? "B" : "C"
      }))
      .filter(o => o.openInterest >= 20)
      .sort((a,b) => b.openInterest - a.openInterest)
      .slice(0, 10);
    
    return { calls, source: "AlphaVantage" };
  } catch(e) { return null; }
}

// ─── Contract Quality Filter ──────────────────────────────────────────────────
function filterContractQuality(contracts, balance) {
  if (!contracts || contracts.length === 0) return [];
  const maxCost = balance * 0.20; // Never more than 20% of balance
  const maxDollarSpread = 0.06; // Max $6 per contract spread
  const minOI = 50; // Minimum open interest
  
  return contracts
    .filter(c => {
      const cost = c.ask * 100;
      const spread = c.ask - c.bid;
      return cost <= maxCost && spread <= maxDollarSpread && c.openInterest >= minOI;
    })
    .map(c => ({
      ...c,
      qualityGrade: c.openInterest >= 100 && (c.ask-c.bid) <= 0.03 ? "A — EXCELLENT" : c.openInterest >= 50 && (c.ask-c.bid) <= 0.06 ? "B — GOOD" : "C — ACCEPTABLE",
      whyGood: `OI: ${c.openInterest} contracts | Spread: $${((c.ask-c.bid)*100).toFixed(2)} per contract | Cost: $${(c.ask*100).toFixed(2)}`
    }))
    .sort((a,b) => b.openInterest - a.openInterest);
}

// ─── Market Context Engine — WHY is the market moving? ──────────────────────
// ─── Market Context Engine — WHY is the market moving? ──────────────────────
async function getMarketContext() {
  try {
    // Get SPY 5-day data to understand the bigger trend
    const [spyWeek, spyIntraday, marketNews] = await Promise.allSettled([
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d", {headers:{"User-Agent":"Mozilla/5.0"}}),
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=5m&range=2d", {headers:{"User-Agent":"Mozilla/5.0"}}),
      fetch("https://query1.finance.yahoo.com/v1/finance/search?q=stock+market+today&newsCount=8", {headers:{"User-Agent":"Mozilla/5.0"}})
    ]);

    // 5-day trend analysis
    let weekTrend = "UNKNOWN", weekChange = 0, dayChanges = [];
    if (spyWeek.status === "fulfilled") {
      const d = await spyWeek.value.json();
      const closes = d.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean)||[];
      if (closes.length >= 2) {
        weekChange = parseFloat(((closes[closes.length-1]-closes[0])/closes[0]*100).toFixed(2));
        // Calculate each day's change
        for (let i=1; i<closes.length; i++) {
          dayChanges.push(parseFloat(((closes[i]-closes[i-1])/closes[i-1]*100).toFixed(2)));
        }
        weekTrend = weekChange > 5 ? "STRONG_BULL" : weekChange > 1 ? "BULL" : weekChange < -5 ? "STRONG_BEAR" : weekChange < -1 ? "BEAR" : "NEUTRAL";
      }
    }

    // Pre-market vs regular session analysis
    let preMarketMove = 0, regularSessionMove = 0;
    if (spyIntraday.status === "fulfilled") {
      const d = await spyIntraday.value.json();
      const timestamps = d.chart?.result?.[0]?.timestamp||[];
      const closes = d.chart?.result?.[0]?.indicators?.quote?.[0]?.close||[];
      // Find pre-market (before 9:30 AM ET = 14:30 UTC) vs regular session
      const marketOpen = timestamps.findIndex(t => {
        const h = new Date(t*1000).getUTCHours();
        return h >= 14; // 14:30 UTC = 9:30 AM ET (roughly)
      });
      if (marketOpen > 0 && closes[0] && closes[marketOpen]) {
        preMarketMove = parseFloat(((closes[marketOpen]-closes[0])/closes[0]*100).toFixed(2));
      }
    }

    // Market news headlines
    let headlines = [], catalyst = "UNKNOWN";
    if (marketNews.status === "fulfilled") {
      const d = await marketNews.value.json();
      headlines = (d.news||[]).slice(0,5).map(n=>n.title);
      
      // Simple catalyst detection from headlines
      const text = headlines.join(" ").toLowerCase();
      if (text.includes("tariff") || text.includes("trade war") || text.includes("trade deal")) catalyst = "TARIFF_NEWS";
      else if (text.includes("fed") || text.includes("interest rate") || text.includes("powell")) catalyst = "FED_NEWS";
      else if (text.includes("inflation") || text.includes("cpi") || text.includes("pce")) catalyst = "INFLATION_DATA";
      else if (text.includes("jobs") || text.includes("unemployment") || text.includes("payroll")) catalyst = "JOBS_DATA";
      else if (text.includes("earnings") || text.includes("revenue") || text.includes("profit")) catalyst = "EARNINGS";
      else if (text.includes("recession") || text.includes("gdp")) catalyst = "ECONOMIC_DATA";
      else if (text.includes("rally") || text.includes("surge") || text.includes("jump")) catalyst = "MOMENTUM";
      else if (text.includes("crash") || text.includes("plunge") || text.includes("drop")) catalyst = "SELLOFF";
      else catalyst = "GENERAL_MOVEMENT";
    }

    // Determine if move is fresh or exhausted based on when it started
    const moveAlreadyDone = Math.abs(preMarketMove) > 5; // If big pre-market move, already done

    // Plain English explanation
    const catalystExplanation = {
      "TARIFF_NEWS": "Trade/tariff news is driving the market. These moves are often sharp and fast — most of the move happens in the first hour.",
      "FED_NEWS": "Federal Reserve news is moving the market. Interest rate decisions affect all stocks. Wait for the announcement to pass before trading.",
      "INFLATION_DATA": "Inflation data just came out. Market is reacting to economic data — very unpredictable in the short term.",
      "JOBS_DATA": "Jobs/employment data is moving the market. Economic data moves are usually one-directional for the day.",
      "EARNINGS": "Company earnings are driving individual stocks. Focus on specific stocks with earnings beats.",
      "ECONOMIC_DATA": "Economic data is the catalyst. Market will decide direction in the first 30-60 minutes.",
      "MOMENTUM": "Market is rallying on momentum — no specific catalyst. Can continue or reverse quickly.",
      "SELLOFF": "Market is selling off — negative sentiment is driving prices down. PUTs may be better than CALLs today.",
      "GENERAL_MOVEMENT": "General market movement with no specific catalyst identified.",
      "UNKNOWN": "Market movement reason unclear. Be extra cautious today."
    }[catalyst] || "Market is moving for unclear reasons.";

    // Trading recommendation based on context
    let contextRecommendation;
    if (moveAlreadyDone && Math.abs(weekChange) > 10) {
      contextRecommendation = "CAUTION: Market made a big move pre-market. By the time you trade at 10 AM most of that move is already priced in. Look for stocks that HAVEN'T moved yet — these laggards may catch up.";
    } else if (weekTrend === "STRONG_BULL") {
      contextRecommendation = "BULLISH WEEK: Market has been going up strongly. CALLs are favored. Look for pullbacks as entry points.";
    } else if (weekTrend === "STRONG_BEAR") {
      contextRecommendation = "BEARISH WEEK: Market has been going down strongly. PUTs are favored. Look for bounces as entry points.";
    } else {
      contextRecommendation = "NORMAL CONDITIONS: Market is moving normally. Follow the individual stock setups.";
    }

    return {
      weekTrend,
      weekChange,
      dayChanges,
      preMarketMove,
      catalyst,
      catalystExplanation,
      headlines,
      moveAlreadyDone,
      contextRecommendation,
      plainEnglish: `This week the market is ${weekChange >= 0 ? "UP" : "DOWN"} ${Math.abs(weekChange).toFixed(1)}% overall. ${catalystExplanation} ${contextRecommendation}`
    };
  } catch(e) {
    console.error("Market context error:", e.message);
    return { weekTrend:"UNKNOWN", weekChange:0, catalyst:"UNKNOWN", headlines:[], moveAlreadyDone:false, contextRecommendation:"Unable to fetch market context.", plainEnglish:"Market context unavailable." };
  }
}

// ─── SPY Futures (predict tomorrow's open) ───────────────────────────────────
async function getSPYFutures() {
  try {
    // ES=F is S&P 500 futures, YM=F is Dow futures
    const [esR, nqR] = await Promise.allSettled([
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/ES%3DF?interval=5m&range=1d", {headers:{"User-Agent":"Mozilla/5.0"}}),
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=5m&range=1d", {headers:{"User-Agent":"Mozilla/5.0"}})
    ]);

    let esPrice = 0, esChange = 0, nqChange = 0;
    if (esR.status === "fulfilled") {
      const d = await esR.value.json();
      const meta = d.chart?.result?.[0]?.meta;
      esPrice = parseFloat(meta?.regularMarketPrice?.toFixed(2) || 0);
      const prev = parseFloat(meta?.chartPreviousClose?.toFixed(2) || esPrice);
      esChange = parseFloat(((esPrice - prev) / prev * 100).toFixed(2));
    }
    if (nqR.status === "fulfilled") {
      const d = await nqR.value.json();
      const meta = d.chart?.result?.[0]?.meta;
      const nqPrice = parseFloat(meta?.regularMarketPrice || 0);
      const prev = parseFloat(meta?.chartPreviousClose || nqPrice);
      nqChange = parseFloat(((nqPrice - prev) / prev * 100).toFixed(2));
    }

    const tomorrowBias = esChange > 1 ? "STRONGLY BULLISH" : esChange > 0.3 ? "BULLISH" : esChange < -1 ? "STRONGLY BEARISH" : esChange < -0.3 ? "BEARISH" : "NEUTRAL";
    const tradingImplication = esChange > 0.5 
      ? `Futures up ${esChange}% — market likely opens UP tomorrow. Prepare for CALL options on strong stocks.`
      : esChange < -0.5 
      ? `Futures down ${Math.abs(esChange)}% — market likely opens DOWN tomorrow. Consider PUT options or sitting out.`
      : `Futures flat — tomorrow's direction unclear. Wait for 10 AM to see which way market breaks.`;

    return {
      esPrice, esChange, nqChange,
      tomorrowBias,
      tradingImplication,
      plainEnglish: `S&P futures are ${esChange >= 0 ? "UP" : "DOWN"} ${Math.abs(esChange).toFixed(2)}% right now. This means tomorrow's market will likely open ${esChange >= 0 ? "higher" : "lower"} than today's close.`
    };
  } catch(e) {
    return { esChange: 0, tomorrowBias: "UNKNOWN", tradingImplication: "Futures data unavailable", plainEnglish: "Unable to fetch futures data" };
  }
}

// ─── After Hours Movers ────────────────────────────────────────────────────────
async function getAfterHoursMovers(symbols) {
  const movers = [];
  for (const sym of symbols.slice(0, 8)) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=1d`, {headers:{"User-Agent":"Mozilla/5.0"}});
      const d = await r.json();
      const meta = d.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const regularPrice = parseFloat(meta.regularMarketPrice?.toFixed(2) || 0);
      const postPrice = parseFloat(meta.postMarketPrice?.toFixed(2) || regularPrice);
      const postChange = regularPrice > 0 ? parseFloat(((postPrice - regularPrice) / regularPrice * 100).toFixed(2)) : 0;
      if (Math.abs(postChange) > 1) {
        movers.push({
          symbol: sym,
          regularPrice,
          postPrice,
          postChange,
          direction: postChange > 0 ? "UP" : "DOWN",
          significance: Math.abs(postChange) > 5 ? "MAJOR" : Math.abs(postChange) > 3 ? "SIGNIFICANT" : "MINOR",
          plainEnglish: `${sym} is ${postChange >= 0 ? "UP" : "DOWN"} ${Math.abs(postChange).toFixed(1)}% after hours at $${postPrice}. ${Math.abs(postChange) > 3 ? "This is a significant move that will likely carry into tomorrow morning." : "Small after hours move."}`
        });
      }
    } catch(e) {}
  }
  return movers.sort((a,b) => Math.abs(b.postChange) - Math.abs(a.postChange));
}

// ─── Economic Calendar ────────────────────────────────────────────────────────
function getTomorrowEconomicEvents() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowDay = tomorrow.getDay(); // 0=Sun, 6=Sat

  const events = [];

  // Major recurring events by day of week
  // These are approximate — real calendar would need paid API
  // But we can flag known high-impact weekly patterns

  const hour = now.getHours();
  const isAfterHours = hour >= 16;

  // Check for major scheduled events
  // Fed meetings happen 8x per year on Tuesdays/Wednesdays
  // Jobs report first Friday of each month at 8:30 AM ET
  // CPI usually mid-month Tuesday at 8:30 AM ET

  const dayOfMonth = tomorrow.getDate();
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][tomorrowDay];

  // Jobs report — first Friday of month
  if (tomorrowDay === 5 && dayOfMonth <= 7) {
    events.push({
      time: "8:30 AM ET",
      event: "JOBS REPORT (Non-Farm Payrolls)",
      impact: "VERY HIGH",
      warning: "🚨 JOBS REPORT TOMORROW at 8:30 AM — Market will make a HUGE move at open. Wait until 10:30 AM before trading. Do not enter any trade before this number is released.",
      tradingAdvice: "Wait until 10:30 AM to see market reaction before placing any trade."
    });
  }

  // Options expiration Friday
  if (tomorrowDay === 5) {
    events.push({
      time: "Market close",
      event: "Weekly Options Expiration",
      impact: "HIGH",
      warning: "⚠️ OPTIONS EXPIRATION FRIDAY tomorrow — options lose value much faster. Take profits earlier than usual. Exit by 3:00 PM not 3:30 PM.",
      tradingAdvice: "Close all positions by 3:00 PM ET. Options decay accelerates dramatically near expiration."
    });
  }

  // Monday — fresh week
  if (tomorrowDay === 1) {
    events.push({
      time: "All day",
      event: "Monday — New Trading Week",
      impact: "MEDIUM",
      warning: "📅 New trading week tomorrow. Market often gaps based on weekend news. Check futures tonight for direction.",
      tradingAdvice: "Wait until 10:15 AM to let opening volatility settle before entering any trade."
    });
  }

  // Wednesday — Fed tends to meet
  if (tomorrowDay === 3 && dayOfMonth >= 10 && dayOfMonth <= 25) {
    events.push({
      time: "2:00 PM ET (possible)",
      event: "Possible Fed Activity Day",
      impact: "MEDIUM",
      warning: "🏦 Wednesdays mid-month can have Fed announcements. Check news tonight for any scheduled Fed speeches or meetings.",
      tradingAdvice: "If Fed is speaking tomorrow — close all positions by 1:45 PM to avoid the volatility."
    });
  }

  if (events.length === 0) {
    events.push({
      time: "All day",
      event: "No major scheduled events",
      impact: "LOW",
      warning: "✅ No major economic events scheduled tomorrow. Cleaner trading conditions expected.",
      tradingAdvice: "Good conditions for trading. Focus on individual stock setups."
    });
  }

  return events;
}

// ─── Market Breadth (how many stocks actually went up today) ──────────────────
async function getMarketBreadth() {
  try {
    // Check advance/decline using sector ETFs as proxy
    const sectors = ["XLK","XLF","XLE","XLV","XLI","XLC","XLY","XLP","XLB","XLRE","XLU"];
    const results = await Promise.allSettled(
      sectors.map(s => fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1d`, {headers:{"User-Agent":"Mozilla/5.0"}}))
    );

    let advancing = 0, declining = 0, unchanged = 0;
    const sectorMoves = [];

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        const d = await results[i].value.json();
        const meta = d.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice || 0;
        const prev = meta?.chartPreviousClose || price;
        const change = prev > 0 ? (price - prev) / prev * 100 : 0;
        if (change > 0.2) advancing++;
        else if (change < -0.2) declining++;
        else unchanged++;
        sectorMoves.push({ sector: sectors[i], change: parseFloat(change.toFixed(2)) });
      }
    }

    const total = advancing + declining + unchanged;
    const breadthScore = total > 0 ? Math.round((advancing / total) * 100) : 50;
    const breadthLabel = breadthScore >= 70 ? "BROAD STRENGTH" : breadthScore >= 55 ? "MODERATE STRENGTH" : breadthScore <= 30 ? "BROAD WEAKNESS" : breadthScore <= 45 ? "MODERATE WEAKNESS" : "MIXED";
    const tomorrowImplication = breadthScore >= 70 
      ? "Strong broad market today suggests continued strength tomorrow. Good conditions for CALL options."
      : breadthScore <= 30 
      ? "Weak broad market today suggests continued weakness tomorrow. Consider PUT options or sitting out."
      : "Mixed market today — tomorrow's direction unclear. Wait for confirmation at 10 AM.";

    const leadingSector = sectorMoves.sort((a,b) => b.change - a.change)[0];
    const laggingSector = sectorMoves.sort((a,b) => a.change - b.change)[0];

    return {
      advancing, declining, unchanged, total,
      breadthScore,
      breadthLabel,
      tomorrowImplication,
      leadingSector,
      laggingSector,
      sectorMoves: sectorMoves.sort((a,b) => b.change - a.change),
      plainEnglish: `Today ${advancing} of ${total} market sectors went UP and ${declining} went DOWN. ${breadthScore >= 60 ? "This is genuine broad strength — most stocks participated in today's move." : breadthScore <= 40 ? "This is concerning — most stocks didn't participate in today's move." : "Market was mixed today — no clear direction."} ${tomorrowImplication}`
    };
  } catch(e) {
    return { breadthScore: 50, breadthLabel: "UNKNOWN", plainEnglish: "Market breadth data unavailable", tomorrowImplication: "Check market conditions tomorrow morning." };
  }
}

async function getTrendingTickers() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v1/finance/trending/US?count=10", { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    return (d.finance?.result?.[0]?.quotes||[]).map(q=>q.symbol).slice(0,8);
  } catch(e) { return []; }
}

async function getUnusualOptionsActivity(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`, { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const chain = d.optionChain?.result?.[0];
    if (!chain) return null;
    const calls = chain.options?.[0]?.calls||[];
    const puts  = chain.options?.[0]?.puts||[];
    const unusualCalls = calls.filter(c=>c.volume&&c.openInterest&&c.volume>c.openInterest*3&&c.volume>100).sort((a,b)=>b.volume-a.volume).slice(0,2).map(c=>({type:"CALL",strike:c.strike,volume:c.volume,ratio:parseFloat((c.volume/c.openInterest).toFixed(1))}));
    const unusualPuts  = puts.filter(p=>p.volume&&p.openInterest&&p.volume>p.openInterest*3&&p.volume>100).sort((a,b)=>b.volume-a.volume).slice(0,2).map(p=>({type:"PUT",strike:p.strike,volume:p.volume,ratio:parseFloat((p.volume/p.openInterest).toFixed(1))}));
    const totalCallVol = calls.reduce((s,c)=>s+(c.volume||0),0);
    const totalPutVol  = puts.reduce((s,p)=>s+(p.volume||0),0);
    const pcRatio = totalCallVol>0?parseFloat((totalPutVol/totalCallVol).toFixed(2)):1;
    return { unusualCalls, unusualPuts, putCallRatio:pcRatio, putCallSentiment:pcRatio<0.7?"BULLISH":pcRatio>1.3?"BEARISH":"NEUTRAL", bigMoneyDirection:unusualCalls.length>unusualPuts.length?"BULLISH":unusualPuts.length>unusualCalls.length?"BEARISH":"NEUTRAL" };
  } catch(e) { return null; }
}

async function getUpcomingEarnings(symbols) {
  const map = {};
  for (const sym of symbols) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=calendarEvents`, { headers:{"User-Agent":"Mozilla/5.0"} });
      const d = await r.json();
      const earnings = d.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
      if (earnings?.earningsDate?.[0]) {
        const date = new Date(earnings.earningsDate[0].raw*1000);
        const daysUntil = Math.ceil((date-new Date())/(1000*60*60*24));
        if (daysUntil>=0&&daysUntil<=7) map[sym] = { date:date.toLocaleDateString(), daysUntil, warning:daysUntil<=2?"⚠️ EARNINGS IN "+daysUntil+" DAYS":"Earnings in "+daysUntil+" days" };
      }
    } catch(e){}
  }
  return map;
}

// ─── Opening Range & VWAP (intraday context) ─────────────────────────────────
// ─── Multi-Timeframe Data Fetcher ────────────────────────────────────────────
async function fetchTimeframeData(symbol, interval, range) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    const r = await fetch(url, { headers: {"User-Agent":"Mozilla/5.0"} });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;
    
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const closes = quote.close || [];
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const volumes = quote.volume || [];
    
    // Filter out null values
    const bars = timestamps.map((t, i) => ({
      time: new Date(t * 1000),
      open: opens[i],
      high: highs[i],
      low: lows[i],
      close: closes[i],
      volume: volumes[i]
    })).filter(b => b.close !== null && b.close !== undefined);
    
    return {
      interval,
      range,
      bars,
      closes: bars.map(b => b.close),
      opens: bars.map(b => b.open),
      highs: bars.map(b => b.high),
      lows: bars.map(b => b.low),
      volumes: bars.map(b => b.volume)
    };
  } catch(e) { return null; }
}

// Strategy optimal timeframes
const STRATEGY_TIMEFRAMES = {
  MOMENTUM_SCALP:   { interval: "2m",  range: "1d", name: "2-minute" },
  SMC:              { interval: "5m",  range: "5d", name: "5-minute" },
  VWAP_RECLAIM:     { interval: "2m",  range: "1d", name: "2-minute" },
  CONTINUATION:     { interval: "5m",  range: "5d", name: "5-minute" },
  BREAKOUT:         { interval: "5m",  range: "5d", name: "5-minute" },
  OVERSOLD_BOUNCE:  { interval: "15m", range: "5d", name: "15-minute" },
  SUPPORT_BOUNCE:   { interval: "15m", range: "5d", name: "15-minute" },
  VOLUME_SPIKE:     { interval: "2m",  range: "1d", name: "2-minute" },
  NEWS_CATALYST:    { interval: "5m",  range: "5d", name: "5-minute" },
  GAP_FILL:         { interval: "5m",  range: "5d", name: "5-minute" },
  TREND_FOLLOWING:  { interval: "1h",  range: "1mo", name: "1-hour" },
  EARNINGS_PLAY:    { interval: "1d",  range: "3mo", name: "daily" }
};

// Fetch the right timeframe for each strategy and run pattern detection
async function getMultiTimeframeAnalysis(symbol, activeStrategies) {
  const results = {};
  
  // Determine which unique timeframes we need
  const neededTimeframes = new Set();
  activeStrategies.forEach(strat => {
    const tf = STRATEGY_TIMEFRAMES[strat];
    if (tf) neededTimeframes.add(`${tf.interval}|${tf.range}`);
  });
  
  // Fetch all needed timeframes in parallel
  const tfData = {};
  await Promise.allSettled(
    [...neededTimeframes].map(async tfKey => {
      const [interval, range] = tfKey.split("|");
      const data = await fetchTimeframeData(symbol, interval, range);
      if (data) tfData[tfKey] = data;
    })
  );
  
  // Run pattern detection on correct timeframe for each strategy
  activeStrategies.forEach(strat => {
    const tf = STRATEGY_TIMEFRAMES[strat];
    if (!tf) return;
    
    const tfKey = `${tf.interval}|${tf.range}`;
    const data = tfData[tfKey];
    if (!data || data.bars.length < 10) return;
    
    const { closes, opens, highs, lows, volumes } = data;
    
    results[strat] = {
      timeframe: tf.name,
      interval: tf.interval,
      barCount: data.bars.length,
      chartPatterns: detectChartPatterns(closes, highs, lows, volumes),
      smcAnalysis: detectSMC(closes, highs, lows, opens),
      divergence: detectDivergence(closes, highs, lows),
      rsi: calcRSI(closes),
      macd: calcMACD(closes),
      currentPrice: closes[closes.length-1],
      // Is the pattern actionable on this timeframe?
      // A pattern on 5-min data resolves in hours = good for same-day options
      // A pattern on daily data resolves in weeks = bad for weekly options
      patternResolutionTime: tf.interval === "2m" ? "30-90 minutes" :
                              tf.interval === "5m" ? "1-4 hours" :
                              tf.interval === "15m" ? "2-8 hours" :
                              tf.interval === "1h" ? "1-3 days" : "1-4 weeks",
      suitableForDayTrade: ["2m","5m","15m"].includes(tf.interval)
    };
  });
  
  return results;
}

async function getIntradayContext(symbol) {
  try {
    // Fetch 2-minute intraday data for real time trend analysis
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=2m&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const quotes = result.indicators?.quote?.[0];
    const timestamps = result.timestamp || [];
    if (!quotes || timestamps.length < 6) return null;

    const closes = quotes.close || [];
    const highs  = quotes.high  || [];
    const lows   = quotes.low   || [];
    const volumes = quotes.volume || [];
    const opens  = quotes.open  || [];

    // Opening range = first 6 bars (30 minutes of 5min data)
    const orBars = Math.min(6, closes.length);
    const orHighs  = highs.slice(0, orBars).filter(Boolean);
    const orLows   = lows.slice(0, orBars).filter(Boolean);
    const orHigh   = orHighs.length > 0 ? Math.max(...orHighs) : null;
    const orLow    = orLows.length  > 0 ? Math.min(...orLows)  : null;
    const openPrice = opens[0] || null;

    // Current price
    const currentPrice = parseFloat(meta.regularMarketPrice?.toFixed(2) || 0);
    const prevClose    = parseFloat(meta.chartPreviousClose?.toFixed(2) || 0);

    // Gap analysis
    const gapPct = prevClose > 0 ? parseFloat(((openPrice - prevClose) / prevClose * 100).toFixed(2)) : 0;
    const gapType = gapPct > 2 ? "GAP_UP" : gapPct < -2 ? "GAP_DOWN" : "FLAT_OPEN";

    // VWAP calculation (cumulative)
    let cumTPV = 0, cumVol = 0;
    const validBars = closes.length;
    for (let i = 0; i < validBars; i++) {
      if (closes[i] && highs[i] && lows[i] && volumes[i]) {
        const tp = (highs[i] + lows[i] + closes[i]) / 3;
        cumTPV += tp * volumes[i];
        cumVol += volumes[i];
      }
    }
    const vwap = cumVol > 0 ? parseFloat((cumTPV / cumVol).toFixed(2)) : null;
    const aboveVWAP = vwap ? currentPrice > vwap : null;

    // Opening range breakout detection
    let orbSignal = "INSIDE_RANGE";
    if (orHigh && orLow && currentPrice) {
      if (currentPrice > orHigh) orbSignal = "BULLISH_BREAKOUT";
      else if (currentPrice < orLow) orbSignal = "BEARISH_BREAKDOWN";
    }

    // Morning trend (first 30min direction)
    const firstClose = closes[0];
    const lastOrClose = closes[orBars - 1];
    const morningTrend = firstClose && lastOrClose
      ? (lastOrClose > firstClose ? "BULLISH" : lastOrClose < firstClose ? "BEARISH" : "FLAT")
      : "UNKNOWN";

    // Volume comparison — morning vs average
    const morningVol = volumes.slice(0, orBars).filter(Boolean).reduce((a,b)=>a+b,0);
    const totalVol   = volumes.filter(Boolean).reduce((a,b)=>a+b,0);

    // REAL TIME TREND ANALYSIS — what is the stock doing RIGHT NOW
    const recentBars = Math.min(closes.length, 6); // Last 12 minutes (6 x 2min bars)
    const recentCloses = closes.slice(-recentBars).filter(Boolean);
    const recentHighs = highs.slice(-recentBars).filter(Boolean);
    const recentLows = lows.slice(-recentBars).filter(Boolean);
    
    // Is price making higher highs and higher lows? (uptrend)
    // Is price making lower highs and lower lows? (downtrend)
    let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
    for (let i = 1; i < recentCloses.length; i++) {
      if (recentHighs[i] > recentHighs[i-1]) higherHighs++;
      else lowerHighs++;
      if (recentLows[i] > recentLows[i-1]) higherLows++;
      else lowerLows++;
    }
    
    // Price velocity — how much is it moving per bar?
    const priceVelocity = recentCloses.length >= 2 
      ? parseFloat(Math.abs((recentCloses[recentCloses.length-1] - recentCloses[0]) / recentCloses.length).toFixed(3))
      : 0;
    
    // Current price vs 30 min ago
    const thirtyMinBars = Math.min(closes.length, 15);
    const priceThirtyMinAgo = closes[closes.length - thirtyMinBars] || closes[0];
    const moveInLast30Min = parseFloat(((currentPrice - priceThirtyMinAgo) / priceThirtyMinAgo * 100).toFixed(2));
    
    // Trend determination
    let realtimeTrend = "SIDEWAYS";
    let trendStrength = "WEAK";
    let trendScore = 50;
    
    if (higherHighs >= recentCloses.length * 0.6 && higherLows >= recentCloses.length * 0.6) {
      realtimeTrend = "UPTREND";
      trendStrength = higherHighs >= recentCloses.length * 0.8 ? "STRONG" : "MODERATE";
      trendScore = trendStrength === "STRONG" ? 80 : 65;
    } else if (lowerHighs >= recentCloses.length * 0.6 && lowerLows >= recentCloses.length * 0.6) {
      realtimeTrend = "DOWNTREND";
      trendStrength = lowerHighs >= recentCloses.length * 0.8 ? "STRONG" : "MODERATE";
      trendScore = trendStrength === "STRONG" ? 20 : 35;
    } else {
      realtimeTrend = "SIDEWAYS";
      trendStrength = "WEAK";
      trendScore = 50;
    }

    // Is it worth trading right now?
    const isMoving = Math.abs(moveInLast30Min) > 0.3 || priceVelocity > 0.02;
    const tradingRecommendation = realtimeTrend === "UPTREND" && isMoving 
      ? "✅ MOVING UP — Good time to consider a CALL"
      : realtimeTrend === "DOWNTREND" && isMoving
      ? "✅ MOVING DOWN — Good time to consider a PUT"
      : realtimeTrend === "SIDEWAYS" || !isMoving
      ? "🚫 NOT MOVING — Stock is flat right now. Wait for movement before entering."
      : "⏳ UNCLEAR — Watch for a few more minutes before deciding";

    // Simple explanation for beginner
    const plainEnglish = realtimeTrend === "UPTREND"
      ? `Stock is making higher prices every few minutes — it's climbing. ${trendStrength === "STRONG" ? "Strong upward movement." : "Moderate upward movement."}`
      : realtimeTrend === "DOWNTREND"  
      ? `Stock is making lower prices every few minutes — it's falling. ${trendStrength === "STRONG" ? "Strong downward movement." : "Moderate downward movement."}`
      : `Stock price is barely moving — going sideways. Options lose value when stock doesn't move. NOT a good time to trade.`;

    return {
      openPrice, prevClose, gapPct, gapType,
      openingRangeHigh: orHigh ? parseFloat(orHigh.toFixed(2)) : null,
      openingRangeLow:  orLow  ? parseFloat(orLow.toFixed(2))  : null,
      orbSignal, morningTrend, vwap, aboveVWAP,
      morningVolume: morningVol, totalVolumeSoFar: totalVol,
      // NEW REAL TIME TREND DATA
      realtimeTrend,
      trendStrength,
      trendScore,
      isMoving,
      moveInLast30Min,
      priceVelocity,
      tradingRecommendation,
      plainEnglish,
      higherHighs, higherLows, lowerHighs, lowerLows,
      gapDescription: gapType === "GAP_UP"
        ? `Gapped UP ${gapPct}% from yesterday`
        : gapType === "GAP_DOWN"
        ? `Gapped DOWN ${Math.abs(gapPct)}% from yesterday`
        : `Opened flat near yesterday's close`,
      orbDescription: orbSignal === "BULLISH_BREAKOUT"
        ? `Price broke ABOVE opening range high ($${orHigh?.toFixed(2)}) — bullish`
        : orbSignal === "BEARISH_BREAKDOWN"
        ? `Price broke BELOW opening range low ($${orLow?.toFixed(2)}) — bearish`
        : `Price still inside opening range — waiting for direction`,
      vwapDescription: vwap
        ? `VWAP $${vwap} — price ${aboveVWAP ? "ABOVE (bullish)" : "BELOW (bearish)"}`
        : "VWAP unavailable",
    };
  } catch(e) {
    console.error("Intraday context error:", symbol, e.message);
    return null;
  }
}

// ─── Trading Time Window ─────────────────────────────────────────────────────
function getTradingTimeWindow() {
  const now = new Date();
  const etOffset = -5; // ET is UTC-5 (adjust for DST if needed)
  const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
  const etMinute = now.getUTCMinutes();
  const etTime = etHour + etMinute/60;
  
  // Define trading windows
  if (etTime < 9.5) return { window: "PRE_MARKET", canTrade: false, message: "Market not open yet. Opens at 9:30 AM ET. Options are not available pre-market.", color: "red" };
  if (etTime < 9.75) return { window: "OPENING_VOLATILITY", canTrade: false, message: "Too early — first 15 minutes are extremely volatile. HARD BLOCK: Wait until 9:45 AM ET minimum.", color: "red" };
  if (etTime < 10.0) return { window: "CAUTION_ZONE", canTrade: false, message: "Still risky — best to wait until 10:00 AM for cleaner signals.", color: "yellow" };
  if (etTime < 11.5) return { window: "BEST_WINDOW", canTrade: true, message: "✅ BEST TRADING WINDOW: 10:00-11:30 AM ET. Opening range is set, volume is good, momentum is clear.", color: "green" };
  if (etTime < 12.0) return { window: "GOOD_WINDOW", canTrade: true, message: "Good trading window. Market has found its direction. Enter on fresh setups only.", color: "green" };
  if (etTime < 13.0) return { window: "LUNCH_DEAD_ZONE", canTrade: false, message: "⚠️ LUNCH DEAD ZONE: 12:00-1:00 PM ET. Volume dries up. Options stop moving. High chance of getting stuck. Wait it out.", color: "yellow" };
  if (etTime < 14.5) return { window: "AFTERNOON_WINDOW", canTrade: true, message: "Afternoon trading window. Only take HIGH confidence setups. Keep size small.", color: "yellow" };
  if (etTime < 15.5) return { window: "POWER_HOUR", canTrade: true, message: "Power hour — fast moves in final hour. Only enter if you can watch closely. Exit by 3:45 PM.", color: "yellow" };
  if (etTime < 15.75) return { window: "HARD_STOP", canTrade: false, message: "🛑 HARD STOP: 3:30 PM ET — no new trades. Close existing positions if still open.", color: "red" };
  return { window: "MARKET_CLOSED", canTrade: false, message: "Market is closed. Come back tomorrow at 10:00 AM ET.", color: "red" };
}

// ─── Economic Calendar (major scheduled events) ──────────────────────────────
function getTodayEconomicEvents() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...5=Fri
  const hour = now.getHours();
  const etHour = hour; // Assumes server is in ET or adjust accordingly

  const events = [];

  // Fed meetings happen 8x per year — approximate detection
  // We'll use a simple flag system for known high-impact times
  if (etHour >= 14 && etHour <= 15) {
    events.push({ type: "WARNING", time: "2:00 PM ET", event: "Prime trading hours — high volatility window", impact: "MEDIUM" });
  }
  if (etHour >= 9 && etHour <= 10) {
    events.push({ type: "INFO", time: "9:30-10:30 AM ET", event: "Market open — first hour high volatility", impact: "HIGH" });
  }
  if (etHour >= 15) {
    events.push({ type: "WARNING", time: "3:00-4:00 PM ET", event: "Power hour — fast moves, exit before 3:45 PM", impact: "HIGH" });
  }

  // Options expiration (every Friday)
  if (day === 5) {
    events.push({ type: "WARNING", time: "All day", event: "OPTIONS EXPIRATION FRIDAY — options lose value faster today", impact: "HIGH" });
  }

  return events;
}

// ─── Technical Indicators ─────────────────────────────────────────────────────
function calcRSI(c,p=14){if(c.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>=0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2));}

// ─── SMC — Smart Money Concepts ──────────────────────────────────────────────
// Fair Value Gap, Break of Structure, Liquidity detection

function detectSMC(closes, highs, lows, opens) {
  if (!closes || closes.length < 10) return null;
  
  const results = {
    fairValueGaps: [],
    breakOfStructure: null,
    liquidityLevels: [],
    entrySignal: null,
    plainEnglish: ""
  };

  // ── 1. FAIR VALUE GAP DETECTION ──────────────────────────────────────────────
  // A FVG exists when: candle 3 low > candle 1 high (bullish gap)
  // OR candle 3 high < candle 1 low (bearish gap)
  // Meaning the wicks of candle 1 and candle 3 do NOT overlap
  for (let i = 2; i < Math.min(closes.length, 30); i++) {
    const c1High = highs[i-2]; // Candle 1 high
    const c1Low = lows[i-2];   // Candle 1 low
    const c2Close = closes[i-1]; // Middle candle — the big move
    const c3High = highs[i];   // Candle 3 high
    const c3Low = lows[i];     // Candle 3 low
    
    // Bullish FVG: candle 3 low is ABOVE candle 1 high — gap between them
    if (c3Low > c1High) {
      const gapSize = parseFloat((c3Low - c1High).toFixed(3));
      const gapPercent = parseFloat((gapSize / c1High * 100).toFixed(2));
      if (gapPercent > 0.1) { // Only meaningful gaps
        results.fairValueGaps.push({
          type: "BULLISH",
          topOfGap: c3Low,   // Price needs to come back DOWN to here
          bottomOfGap: c1High, // This is the bottom of the gap zone
          candleIndex: i,
          gapSize,
          gapPercent,
          filled: closes[closes.length-1] <= c3Low && closes[closes.length-1] >= c1High,
          plainEnglish: `Bullish FVG: Gap between $${c1High.toFixed(2)} and $${c3Low.toFixed(2)} — price may return here before going up`
        });
      }
    }
    
    // Bearish FVG: candle 3 high is BELOW candle 1 low — gap between them
    if (c3High < c1Low) {
      const gapSize = parseFloat((c1Low - c3High).toFixed(3));
      const gapPercent = parseFloat((gapSize / c1Low * 100).toFixed(2));
      if (gapPercent > 0.1) {
        results.fairValueGaps.push({
          type: "BEARISH",
          topOfGap: c1Low,
          bottomOfGap: c3High,
          candleIndex: i,
          gapSize,
          gapPercent,
          filled: closes[closes.length-1] >= c3High && closes[closes.length-1] <= c1Low,
          plainEnglish: `Bearish FVG: Gap between $${c3High.toFixed(2)} and $${c1Low.toFixed(2)} — price may return here before going down`
        });
      }
    }
  }

  // Keep only the 3 most recent meaningful FVGs
  results.fairValueGaps = results.fairValueGaps.slice(-3);

  // ── 2. SWING HIGHS AND LOWS (for BOS and Liquidity) ─────────────────────────
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      swingHighs.push({ price: highs[i], index: i });
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      swingLows.push({ price: lows[i], index: i });
    }
  }

  // ── 3. LIQUIDITY LEVELS ───────────────────────────────────────────────────────
  // Swing highs = buy-side liquidity (stop losses of short sellers cluster here)
  // Swing lows = sell-side liquidity (stop losses of long buyers cluster here)
  const currentPrice = closes[closes.length-1];
  
  swingHighs.slice(-5).forEach(sh => {
    results.liquidityLevels.push({
      type: "BUY_SIDE",
      price: parseFloat(sh.price.toFixed(2)),
      above: sh.price > currentPrice,
      plainEnglish: `Buy-side liquidity at $${sh.price.toFixed(2)} — stop losses of sellers cluster here`
    });
  });
  
  swingLows.slice(-5).forEach(sl => {
    results.liquidityLevels.push({
      type: "SELL_SIDE", 
      price: parseFloat(sl.price.toFixed(2)),
      below: sl.price < currentPrice,
      plainEnglish: `Sell-side liquidity at $${sl.price.toFixed(2)} — stop losses of buyers cluster here`
    });
  });

  // ── 4. BREAK OF STRUCTURE ─────────────────────────────────────────────────────
  // Bullish BOS: current price breaks ABOVE a previous swing high
  // Bearish BOS: current price breaks BELOW a previous swing low
  if (swingHighs.length >= 2) {
    const lastSwingHigh = swingHighs[swingHighs.length-1].price;
    const prevSwingHigh = swingHighs[swingHighs.length-2].price;
    
    if (currentPrice > lastSwingHigh) {
      results.breakOfStructure = {
        type: "BULLISH",
        level: parseFloat(lastSwingHigh.toFixed(2)),
        plainEnglish: `✅ BULLISH BREAK OF STRUCTURE: Price broke above $${lastSwingHigh.toFixed(2)}. Trend confirmed UP. Look for pullback to FVG for entry.`
      };
    }
  }
  
  if (swingLows.length >= 2 && !results.breakOfStructure) {
    const lastSwingLow = swingLows[swingLows.length-1].price;
    
    if (currentPrice < lastSwingLow) {
      results.breakOfStructure = {
        type: "BEARISH",
        level: parseFloat(lastSwingLow.toFixed(2)),
        plainEnglish: `⚠️ BEARISH BREAK OF STRUCTURE: Price broke below $${lastSwingLow.toFixed(2)}. Trend confirmed DOWN. Look for bounce to FVG for PUT entry.`
      };
    }
  }

  // ── 5. ENTRY SIGNAL — Green candle inside FVG after BOS ──────────────────────
  // This is the exact entry the trader described
  if (results.breakOfStructure && results.fairValueGaps.length > 0) {
    const bos = results.breakOfStructure;
    const recentFVGs = results.fairValueGaps.filter(fvg => fvg.type === (bos.type === "BULLISH" ? "BULLISH" : "BEARISH"));
    
    if (recentFVGs.length > 0) {
      const targetFVG = recentFVGs[recentFVGs.length-1];
      const lastClose = closes[closes.length-1];
      const lastOpen = opens ? opens[opens.length-1] : lastClose;
      const prevClose = closes[closes.length-2];
      
      // Is price currently inside the FVG zone?
      const insideFVG = bos.type === "BULLISH" 
        ? lastClose >= targetFVG.bottomOfGap && lastClose <= targetFVG.topOfGap
        : lastClose >= targetFVG.bottomOfGap && lastClose <= targetFVG.topOfGap;
      
      // Is the last candle green (close > open)?
      const isGreenCandle = lastClose > (lastOpen || prevClose);
      const isRedCandle = lastClose < (lastOpen || prevClose);
      
      if (insideFVG && bos.type === "BULLISH" && isGreenCandle) {
        results.entrySignal = {
          type: "ENTER_NOW",
          direction: "CALL",
          fvgZone: `$${targetFVG.bottomOfGap.toFixed(2)} - $${targetFVG.topOfGap.toFixed(2)}`,
          plainEnglish: `🟢 ENTER NOW: Price is inside the bullish FVG zone ($${targetFVG.bottomOfGap.toFixed(2)}-$${targetFVG.topOfGap.toFixed(2)}) AND a GREEN candle just formed. This is your exact entry signal. BUY CALL immediately.`,
          confidence: "HIGH"
        };
      } else if (insideFVG && bos.type === "BEARISH" && isRedCandle) {
        results.entrySignal = {
          type: "ENTER_NOW",
          direction: "PUT",
          fvgZone: `$${targetFVG.bottomOfGap.toFixed(2)} - $${targetFVG.topOfGap.toFixed(2)}`,
          plainEnglish: `🔴 ENTER NOW: Price is inside the bearish FVG zone AND a RED candle just formed. BUY PUT immediately.`,
          confidence: "HIGH"
        };
      } else if (bos.type === "BULLISH" && lastClose > targetFVG.topOfGap) {
        results.entrySignal = {
          type: "WAIT",
          direction: "CALL",
          fvgZone: `$${targetFVG.bottomOfGap.toFixed(2)} - $${targetFVG.topOfGap.toFixed(2)}`,
          plainEnglish: `⏳ WAIT: Bullish BOS confirmed. Waiting for price to PULL BACK into the FVG zone ($${targetFVG.bottomOfGap.toFixed(2)}-$${targetFVG.topOfGap.toFixed(2)}). Then wait for a green candle — that is your entry.`,
          confidence: "MEDIUM"
        };
      } else if (bos.type === "BEARISH" && lastClose < targetFVG.bottomOfGap) {
        results.entrySignal = {
          type: "WAIT",
          direction: "PUT", 
          fvgZone: `$${targetFVG.bottomOfGap.toFixed(2)} - $${targetFVG.topOfGap.toFixed(2)}`,
          plainEnglish: `⏳ WAIT: Bearish BOS confirmed. Waiting for price to BOUNCE back into the FVG zone ($${targetFVG.bottomOfGap.toFixed(2)}-$${targetFVG.topOfGap.toFixed(2)}). Then wait for a red candle — that is your entry.`,
          confidence: "MEDIUM"
        };
      }
    }
  }

  // ── 6. PLAIN ENGLISH SUMMARY ──────────────────────────────────────────────────
  if (results.entrySignal) {
    results.plainEnglish = results.entrySignal.plainEnglish;
  } else if (results.breakOfStructure) {
    results.plainEnglish = results.breakOfStructure.plainEnglish + " No FVG retest yet.";
  } else if (results.fairValueGaps.length > 0) {
    results.plainEnglish = `FVG detected at ${results.fairValueGaps[results.fairValueGaps.length-1].plainEnglish}. No Break of Structure yet — wait for BOS before entering.`;
  } else {
    results.plainEnglish = "No SMC setup detected currently. Wait for a clear FVG + BOS combination.";
  }

  return results;
}

// ─── Chart Pattern Detection ─────────────────────────────────────────────────
// Detects the same patterns a trader would see on TradingView
function detectChartPatterns(closes, highs, lows, volumes) {
  if (closes.length < 20) return null;
  
  const patterns = [];
  const recent = 20; // Look at last 20 bars
  const rc = closes.slice(-recent);
  const rh = highs.slice(-recent);
  const rl = lows.slice(-recent);
  const rv = volumes.slice(-recent);
  
  const currentPrice = rc[rc.length-1];
  const avgVol = rv.reduce((a,b)=>a+b,0)/rv.length;

  // ── 1. Trend Channel Detection ──────────────────────────────────────────────
  // Find swing highs and lows
  const swingHighs = [], swingLows = [];
  for (let i=2; i<rh.length-2; i++) {
    if (rh[i]>rh[i-1]&&rh[i]>rh[i-2]&&rh[i]>rh[i+1]&&rh[i]>rh[i+2]) swingHighs.push({idx:i,price:rh[i]});
    if (rl[i]<rl[i-1]&&rl[i]<rl[i-2]&&rl[i]<rl[i+1]&&rl[i]<rl[i+2]) swingLows.push({idx:i,price:rl[i]});
  }
  
  // Higher highs AND higher lows = uptrend channel
  if (swingHighs.length>=2 && swingLows.length>=2) {
    const hhh = swingHighs[swingHighs.length-1].price > swingHighs[swingHighs.length-2].price;
    const hhl = swingLows[swingLows.length-1].price > swingLows[swingLows.length-2].price;
    const lhh = swingHighs[swingHighs.length-1].price < swingHighs[swingHighs.length-2].price;
    const lhl = swingLows[swingLows.length-1].price < swingLows[swingLows.length-2].price;
    
    if (hhh && hhl) patterns.push({
      name: "UPTREND CHANNEL",
      signal: "BULLISH",
      confidence: "HIGH",
      emoji: "📈",
      plain: "Stock is making higher highs AND higher lows — this is a confirmed uptrend. Like stairs going up. Each peak is higher than the last. Each dip is higher than the last. Strong buy signal for CALL options.",
      action: "BUY CALLS on the next dip toward support"
    });
    
    if (lhh && lhl) patterns.push({
      name: "DOWNTREND CHANNEL", 
      signal: "BEARISH",
      confidence: "HIGH",
      emoji: "📉",
      plain: "Stock is making lower highs AND lower lows — confirmed downtrend. Like stairs going down. Each rally fails lower than the last. Strong signal for PUT options.",
      action: "BUY PUTS on the next rally toward resistance"
    });
  }

  // ── 2. Double Bottom Detection ───────────────────────────────────────────────
  // Two lows at approximately the same price level = strong support
  if (swingLows.length >= 2) {
    const low1 = swingLows[swingLows.length-2].price;
    const low2 = swingLows[swingLows.length-1].price;
    const diff = Math.abs(low1-low2)/low1;
    if (diff < 0.02 && currentPrice > low2*1.02) { // Within 2% and price bounced
      patterns.push({
        name: "DOUBLE BOTTOM",
        signal: "BULLISH",
        confidence: "HIGH",
        emoji: "W",
        plain: `Stock hit the same low price around $${low2.toFixed(2)} TWICE and bounced both times. This creates a strong floor. Think of it like the letter W — price goes down, bounces, goes down to same level again, bounces again. Very reliable bullish pattern.`,
        action: "BUY CALLS — target is the height between the bottom and the middle peak"
      });
    }
  }

  // ── 3. Double Top Detection ───────────────────────────────────────────────────
  // Two highs at approximately the same price = strong resistance
  if (swingHighs.length >= 2) {
    const high1 = swingHighs[swingHighs.length-2].price;
    const high2 = swingHighs[swingHighs.length-1].price;
    const diff = Math.abs(high1-high2)/high1;
    if (diff < 0.02 && currentPrice < high2*0.98) { // Within 2% and price rejected
      patterns.push({
        name: "DOUBLE TOP",
        signal: "BEARISH",
        confidence: "HIGH",
        emoji: "M",
        plain: `Stock hit the same HIGH price around $${high2.toFixed(2)} TWICE and got rejected both times. This creates a strong ceiling. Think of it like the letter M — price goes up, fails, goes up to same level again, fails again. Reliable bearish pattern.`,
        action: "AVOID CALLS — stock is struggling at resistance. Consider PUTS."
      });
    }
  }

  // ── 4. Bull Flag Detection ───────────────────────────────────────────────────
  // Strong up move then tight sideways consolidation = about to break up
  const firstHalf = rc.slice(0, Math.floor(rc.length/2));
  const secondHalf = rc.slice(Math.floor(rc.length/2));
  const firstMove = (firstHalf[firstHalf.length-1]-firstHalf[0])/firstHalf[0]*100;
  const secondRange = (Math.max(...secondHalf)-Math.min(...secondHalf))/Math.max(...secondHalf)*100;
  
  if (firstMove > 3 && secondRange < 2) { // Strong move then tight consolidation
    patterns.push({
      name: "BULL FLAG",
      signal: "BULLISH",
      confidence: "MEDIUM",
      emoji: "🚩",
      plain: `Stock made a strong ${firstMove.toFixed(1)}% move up then started moving sideways in a tight range. This is called a bull flag. The strong move is the flagpole. The sideways movement is the flag. After flags the stock usually continues UP in the same direction as the original move.`,
      action: "BUY CALLS when price breaks above the top of the flag range"
    });
  }
  
  // Bear flag — strong down move then tight consolidation
  if (firstMove < -3 && secondRange < 2) {
    patterns.push({
      name: "BEAR FLAG",
      signal: "BEARISH",
      confidence: "MEDIUM",
      emoji: "🚩",
      plain: `Stock dropped ${Math.abs(firstMove).toFixed(1)}% then moved sideways. This is a bear flag — usually the stock continues DOWN after this pause. Avoid calls on this stock.`,
      action: "AVOID CALLS — consider PUTS when price breaks below the flag"
    });
  }

  // ── 5. Coiling / Compression Detection ───────────────────────────────────────
  // Price range getting smaller = big move coming soon
  const earlyRange = (Math.max(...rh.slice(0,10)) - Math.min(...rl.slice(0,10)));
  const recentRange = (Math.max(...rh.slice(-10)) - Math.min(...rl.slice(-10)));
  if (recentRange < earlyRange * 0.5 && recentRange/currentPrice < 0.03) {
    patterns.push({
      name: "COILING / COMPRESSION",
      signal: "NEUTRAL",
      confidence: "MEDIUM",
      emoji: "🔄",
      plain: `Stock price is getting squeezed into a tighter and tighter range. This is called coiling — like a spring being compressed. When the spring releases it makes a big move. Direction unknown but a breakout is coming soon. Watch for the first big move and trade in that direction.`,
      action: "WAIT for breakout direction then trade it aggressively"
    });
  }

  // ── 6. Volume Climax Detection ───────────────────────────────────────────────
  // Massive volume spike = potential reversal
  const lastVol = rv[rv.length-1];
  if (lastVol > avgVol * 3) {
    const priceChange = (rc[rc.length-1]-rc[rc.length-2])/rc[rc.length-2]*100;
    patterns.push({
      name: priceChange > 0 ? "BUYING CLIMAX" : "SELLING CLIMAX",
      signal: priceChange > 0 ? "CAUTION" : "BULLISH",
      confidence: "MEDIUM",
      emoji: "💥",
      plain: priceChange > 0 
        ? `Massive volume spike on an UP move. When everyone rushes to buy at once it often signals the TOP of the move. Big money may be selling to all the buyers. Be careful with calls here.`
        : `Massive volume spike on a DOWN move. When everyone panics and sells at once it often signals the BOTTOM. Big money buys from panicking sellers. This can be a good call opportunity.`,
      action: priceChange > 0 ? "CAUTION — potential top forming" : "WATCH for bounce — potential bottom"
    });
  }

  // ── 7. Support/Resistance Retest ─────────────────────────────────────────────
  if (swingLows.length >= 1) {
    const nearestSupport = swingLows[swingLows.length-1].price;
    const distFromSupport = (currentPrice - nearestSupport)/nearestSupport*100;
    if (distFromSupport > 0 && distFromSupport < 1.5) {
      patterns.push({
        name: "AT SUPPORT — POTENTIAL BOUNCE",
        signal: "BULLISH",
        confidence: "MEDIUM",
        emoji: "🧱",
        plain: `Stock is sitting right at a support level ($${nearestSupport.toFixed(2)}) that held before. Price bounced here last time. If it holds again this is a good call entry with a clear stop loss just below support.`,
        action: `BUY CALLS if stock holds above $${nearestSupport.toFixed(2)}. Set stop loss just below.`
      });
    }
  }

  return patterns.length > 0 ? patterns : null;
}

// ─── Divergence Detection ─────────────────────────────────────────────────────
// Compares price highs/lows to RSI highs/lows to find hidden signals
function detectDivergence(closes, highs, lows) {
  if (closes.length < 20) return null;
  
  const recentCloses = closes.slice(-20);
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  
  // Calculate RSI for recent periods
  const rsiValues = [];
  for (let i = 10; i < recentCloses.length; i++) {
    const rsi = calcRSI(recentCloses.slice(0, i+1));
    if (rsi) rsiValues.push(rsi);
  }
  
  if (rsiValues.length < 5) return null;
  
  const priceNow = recentCloses[recentCloses.length-1];
  const pricePrev = recentCloses[recentCloses.length-6];
  const rsiNow = rsiValues[rsiValues.length-1];
  const rsiPrev = rsiValues[rsiValues.length-6];
  
  const priceHigher = priceNow > pricePrev;
  const rsiHigher = rsiNow > rsiPrev;
  
  // Bearish divergence: price making higher high but RSI making lower high
  // Means momentum is weakening even though price looks strong
  if (priceHigher && !rsiHigher && rsiNow > 50) {
    return {
      type: "BEARISH_DIVERGENCE",
      signal: "BEARISH",
      strength: Math.abs(rsiNow - rsiPrev) > 10 ? "STRONG" : "MILD",
      plainEnglish: `⚠️ BEARISH DIVERGENCE: Price went up but momentum is weakening. This often means a reversal is coming. Be careful buying CALLs right now.`,
      tradingImplication: "Price is rising but RSI is falling — buyers are losing strength. Avoid calls, consider puts or wait."
    };
  }
  
  // Bullish divergence: price making lower low but RSI making higher low
  // Means selling momentum is weakening — bounce coming
  if (!priceHigher && rsiHigher && rsiNow < 50) {
    return {
      type: "BULLISH_DIVERGENCE", 
      signal: "BULLISH",
      strength: Math.abs(rsiNow - rsiPrev) > 10 ? "STRONG" : "MILD",
      plainEnglish: `✅ BULLISH DIVERGENCE: Price went down but momentum is recovering. This often means a bounce is coming. Good setup for a CALL option.`,
      tradingImplication: "Price is falling but RSI is rising — sellers are losing strength. Good call option opportunity."
    };
  }
  
  // Hidden bullish: price higher low, RSI lower low = trend continuation up
  if (priceHigher && rsiHigher) {
    return {
      type: "CONFIRMED_BULLISH",
      signal: "BULLISH",
      strength: "CONFIRMED",
      plainEnglish: `✅ CONFIRMED UPTREND: Both price AND momentum are moving up together. Strong signal for CALL options.`,
      tradingImplication: "Price and RSI both agree — strong bullish signal."
    };
  }
  
  // Both down = confirmed bearish
  if (!priceHigher && !rsiHigher) {
    return {
      type: "CONFIRMED_BEARISH",
      signal: "BEARISH", 
      strength: "CONFIRMED",
      plainEnglish: `⚠️ CONFIRMED DOWNTREND: Both price AND momentum are falling together. Strong signal for PUT options or avoid calls.`,
      tradingImplication: "Price and RSI both agree — strong bearish signal."
    };
  }
  
  return null;
}

// ─── Theta Decay Estimator ────────────────────────────────────────────────────
// Estimates how much the option loses per day just from time passing
function estimateThetaDecay(optionPrice, daysToExpiry, stockPrice, strikePrice) {
  if (!optionPrice || !daysToExpiry || daysToExpiry <= 0) return null;
  
  // Simplified theta estimate — options lose value faster as expiry approaches
  // Near expiry (1-3 days): loses ~15-25% of value per day
  // Medium term (4-7 days): loses ~8-12% per day
  // Longer term (8-14 days): loses ~3-6% per day
  const dailyDecayPct = daysToExpiry <= 2 ? 0.20 : daysToExpiry <= 5 ? 0.10 : 0.05;
  const dailyDollarLoss = parseFloat((optionPrice * 100 * dailyDecayPct).toFixed(2));
  const hourlyLoss = parseFloat((dailyDollarLoss / 6.5).toFixed(2)); // 6.5 trading hours per day
  
  const warning = daysToExpiry <= 2 
    ? `🚨 EXPIRING SOON: Option loses ~$${dailyDollarLoss} per day just from time. Stock must move FAST.`
    : daysToExpiry <= 4
    ? `⚠️ TIME DECAY: Option loses ~$${dailyDollarLoss} per day. Stock needs to move within ${daysToExpiry} days.`
    : `✅ TIME OK: Option loses ~$${dailyDollarLoss} per day. You have ${daysToExpiry} days for the stock to move.`;
    
  return {
    daysToExpiry,
    dailyDecayPct: Math.round(dailyDecayPct * 100),
    dailyDollarLoss,
    hourlyLoss,
    warning,
    isUrgent: daysToExpiry <= 2,
    plainEnglish: `This option loses about $${dailyDollarLoss} every single day even if the stock doesn't move. That's $${hourlyLoss} per hour the market is open.`
  };
}
function calcEMA(c,p){if(c.length<p)return null;const k=2/(p+1);let e=c.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<c.length;i++)e=c[i]*k+e*(1-k);return parseFloat(e.toFixed(2));}
function calcMACD(c){const e12=calcEMA(c,12),e26=calcEMA(c,26);if(!e12||!e26)return null;return{macdLine:parseFloat((e12-e26).toFixed(2)),bullish:e12>e26};}
function calcBoll(c,p=20){if(c.length<p)return null;const s=c.slice(-p),m=s.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(s.reduce((sum,v)=>sum+Math.pow(v-m,2),0)/p);return{upper:parseFloat((m+2*std).toFixed(2)),middle:parseFloat(m.toFixed(2)),lower:parseFloat((m-2*std).toFixed(2))};}
function calcATR(h,l,c,p=14){if(h.length<p+1)return null;const t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return parseFloat((t.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(2));}
function calcStoch(h,l,c,p=14){if(c.length<p)return null;const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)),cur=c[c.length-1];return hh===ll?50:parseFloat(((cur-ll)/(hh-ll)*100).toFixed(2));}
function calcWR(h,l,c,p=14){if(c.length<p)return null;const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)),cur=c[c.length-1];return hh===ll?-50:parseFloat(((hh-cur)/(hh-ll)*-100).toFixed(2));}
function calcOBV(c,v){let o=0;const vals=[0];for(let i=1;i<c.length;i++){if(c[i]>c[i-1])o+=v[i];else if(c[i]<c[i-1])o-=v[i];vals.push(o);}const r=vals.slice(-10);return{trend:r[r.length-1]>r[0]?"RISING":"FALLING"};}
function volAnalysis(v){const avg=v.slice(-20).reduce((a,b)=>a+b,0)/20,today=v[v.length-1],ratio=today/avg;return{today,avg20:Math.round(avg),ratio:parseFloat(ratio.toFixed(2)),trend:ratio>1.2?"HIGH":ratio<0.8?"LOW":"AVERAGE"};}
function findSR(h,l,c,price){const rh=h.slice(-60),rl=l.slice(-60);const sup=[],res=[];for(let i=2;i<rl.length-2;i++){if(rl[i]<rl[i-1]&&rl[i]<rl[i-2]&&rl[i]<rl[i+1]&&rl[i]<rl[i+2])sup.push(parseFloat(rl[i].toFixed(2)));if(rh[i]>rh[i-1]&&rh[i]>rh[i-2]&&rh[i]>rh[i+1]&&rh[i]>rh[i+2])res.push(parseFloat(rh[i].toFixed(2)));}return{supports:[...new Set(sup)].filter(s=>s<price).sort((a,b)=>b-a).slice(0,3),resistances:[...new Set(res)].filter(r=>r>price).sort((a,b)=>a-b).slice(0,3)};}

async function fetchMarketData(symbol) {
  const [qd,od] = await Promise.all([getQuote(symbol),getOptions(symbol).catch(()=>null)]);
  const chart=qd.chart.result[0],meta=chart.meta,q=chart.indicators.quote[0];
  const closes=q.close.filter(Boolean),highs=q.high.filter(Boolean),lows=q.low.filter(Boolean),volumes=q.volume.filter(Boolean);
  const price=parseFloat(meta.regularMarketPrice.toFixed(2)),prev=parseFloat(meta.chartPreviousClose.toFixed(2));
  let iv=null,nearATM=[],affordableStrikes=[];
  if(od?.optionChain?.result?.[0]){
    const calls=od.optionChain.result[0].options?.[0]?.calls||[];
    nearATM=calls.filter(c=>Math.abs(c.strike-price)<price*0.1).slice(0,5).map(c=>({strike:c.strike,lastPrice:c.lastPrice,iv:c.impliedVolatility?parseFloat((c.impliedVolatility*100).toFixed(1)):null,exp:new Date(c.expiration*1000).toLocaleDateString(),volume:c.volume||0}));
    if(calls[0]?.impliedVolatility)iv=parseFloat((calls[0].impliedVolatility*100).toFixed(1));
    // Find actually affordable strikes for different budget levels
    affordableStrikes = calls
      .filter(c => c.ask && c.ask > 0)
      .map(c => ({
        strike: c.strike,
        askPerShare: parseFloat(c.ask.toFixed(2)),
        totalCost: parseFloat((c.ask * 100).toFixed(2)),
        breakeven: parseFloat((c.strike + c.ask).toFixed(2)),
        volume: c.volume || 0,
        exp: new Date(c.expiration*1000).toLocaleDateString()
      }))
      .filter(c => c.totalCost <= 100) // Only show options under $100
      .sort((a,b) => a.totalCost - b.totalCost)
      .slice(0, 8); // Top 8 most affordable
  }
  const vol=volAnalysis(volumes),sr=findSR(highs,lows,closes,price);
  return{symbol,price,priceData:{current:price,prev,change:parseFloat(((price-prev)/prev*100).toFixed(2)),high52:parseFloat(meta.fiftyTwoWeekHigh.toFixed(2)),low52:parseFloat(meta.fiftyTwoWeekLow.toFixed(2))},volume:vol,indicators:{rsi:calcRSI(closes),macd:calcMACD(closes),ema20:calcEMA(closes,20),ema50:calcEMA(closes,50),ema200:calcEMA(closes,200),bollinger:calcBoll(closes),atr:calcATR(highs,lows,closes),stochastic:calcStoch(highs,lows,closes),williamsR:calcWR(highs,lows,closes),obv:calcOBV(closes,volumes)},levels:sr,options:{iv,nearATM}};
}

// ─── Milestones ───────────────────────────────────────────────────────────────
const MILESTONES=[25,50,100,250,500,1000,2500,5000,10000];
function checkMilestone(oldBal,newBal,existing){for(const m of MILESTONES){if(oldBal<m&&newBal>=m&&!existing.includes(m))return m;}return null;}

// ─── MAIN ANALYSIS ────────────────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    const data = loadData();
    const strategyMemory = loadStrategyMemory();
    const activeWatchlist = getWatchlist(data.balance);
    const batch = activeWatchlist.slice(0,8);
    const edLevel = getEducationLevel(data, strategyMemory);

    const [spyR,qqqR,fgR,trendR,vixR,cryptoR,contextR,futuresR,breadthR,coinGeckoR,fredR,...stockR] = await Promise.allSettled([
      fetchMarketData("SPY"), fetchMarketData("QQQ"),
      getFearGreedIndex(), getTrendingTickers(),
      getVIX(), getCryptoCorrelation(), getMarketContext(),
      getSPYFutures(), getMarketBreadth(),
      getCoinGeckoCrypto(), getFREDEconomicEvents(),
      ...batch.map(s=>fetchMarketData(s))
    ]);

    const spyChange = spyR.status==="fulfilled"?spyR.value.priceData.change:0;
    const qqqChange = qqqR.status==="fulfilled"?qqqR.value.priceData.change:0;
    const fearGreed = fgR.status==="fulfilled"?fgR.value:{score:50,rating:"Neutral"};
    const trending  = trendR.status==="fulfilled"?trendR.value:[];
    const vix = vixR.status==="fulfilled"?vixR.value:{value:20,level:"NORMAL",tradingAdvice:"Trade normally",optionCost:"Options normally priced"};
    const crypto = cryptoR.status==="fulfilled"?cryptoR.value:{btcChange:0,cryptoMood:"NEUTRAL",impact:"Crypto data unavailable"};
    const marketContext = contextR.status==="fulfilled"?contextR.value:{weekTrend:"UNKNOWN",weekChange:0,catalyst:"UNKNOWN",headlines:[],moveAlreadyDone:false,contextRecommendation:"",plainEnglish:"Market context unavailable"};
    const coinGecko = coinGeckoR.status==="fulfilled"&&coinGeckoR.value?coinGeckoR.value:{btcPrice:0,btcChange24h:0,mood:"NEUTRAL",miningStockImpact:"Bitcoin data unavailable"};
    const fredEvents = fredR.status==="fulfilled"&&fredR.value?fredR.value:[];
    const futures = futuresR.status==="fulfilled"?futuresR.value:{esChange:0,tomorrowBias:"UNKNOWN",tradingImplication:"Futures unavailable",plainEnglish:"Futures data unavailable"};
    const breadth = breadthR.status==="fulfilled"?breadthR.value:{breadthScore:50,breadthLabel:"UNKNOWN",plainEnglish:"Breadth unavailable",tomorrowImplication:"",sectorMoves:[]};
    const tomorrowEvents = getTomorrowEconomicEvents();
    // After hours movers fetched after stock data
    
    const marketRegime = detectMarketRegime(spyChange, 0, 0);
    const dayClassification = classifyMarketDay(spyChange, fearGreed.score, null);
    const marketTrend = spyChange<-2?"STRONGLY BEARISH":spyChange<-0.75?"BEARISH":spyChange>2?"STRONGLY BULLISH":spyChange>0.75?"BULLISH":"NEUTRAL";
    const preferredDir = spyChange<-1.5?"PUT":spyChange>1.5?"CALL":"EITHER";
    
    // Volatile market detection
    const isExtremelyVolatile = Math.abs(spyChange) > 3;
    const isMildlyVolatile = Math.abs(spyChange) > 1.5;
    const volatileWarning = isExtremelyVolatile 
      ? `⚠️ EXTREME VOLATILITY WARNING: Market is moving ${spyChange > 0 ? "UP" : "DOWN"} ${Math.abs(spyChange).toFixed(1)}% today. Option prices are inflated and unpredictable. Consider reducing position size by 50% or sitting out today.`
      : null;

    // PDT check - count today's day trades
    const todayStr = new Date().toDateString();
    const todayTrades = data.trades.filter(t => new Date(t.date).toDateString() === todayStr && t.result !== "skip").length;
    const pdtWarning = todayTrades >= 2 
      ? `⚠️ PDT WARNING: You have made ${todayTrades} day trades today. If you make ${3 - todayTrades} more you risk hitting the 3-day-trade limit. Consider switching to a Cash Account to avoid restrictions.`
      : null;

    // MINIMUM BALANCE PROTECTION
    const MIN_TRADING_BALANCE = 20;
    const balanceTooLow = data.balance < MIN_TRADING_BALANCE;
    const balanceWarning = balanceTooLow 
      ? `🛑 PROTECT MODE: Your balance ($${data.balance}) is too low to risk any more right now. Stop trading until you add more funds or your balance recovers above $${MIN_TRADING_BALANCE}. Every dollar counts at this stage.`
      : null;

    // WEEKLY LOSS LIMIT (max 20% loss per week)
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
    weekStart.setHours(0,0,0,0);
    const weekTrades = data.trades.filter(t => new Date(t.date) >= weekStart && t.result !== "skip");
    const weekPnl = weekTrades.reduce((s,t) => s+(t.pnl||0), 0);
    const weekLossLimit = data.startingBalance * 0.20;
    const hitWeeklyLimit = weekPnl < -weekLossLimit;
    const weeklyLimitWarning = hitWeeklyLimit
      ? `🛑 WEEKLY LOSS LIMIT HIT: You've lost $${Math.abs(weekPnl).toFixed(2)} this week which is more than 20% of your starting balance. Stop trading for the rest of this week. Come back fresh on Monday. Protecting your capital is more important than making it back today.`
      : null;

    const shouldStopTrading = balanceTooLow || hitWeeklyLimit || shouldSitOut;
    
    // Already up big warning  
    const bigMoverWarning = (stock) => {
      if (Math.abs(stock.priceData?.change || 0) > 15) {
        return `⚠️ This stock is already ${stock.priceData.change > 0 ? "UP" : "DOWN"} ${Math.abs(stock.priceData.change).toFixed(1)}% today — options are expensive and the move may be exhausted`;
      }
      return null;
    };

    const marketDataMap={};
    for(let i=0;i<batch.length;i++){if(stockR[i].status==="fulfilled")marketDataMap[batch[i]]=stockR[i].value;}

    const topSymbols=Object.keys(marketDataMap).slice(0,5);
    const economicEvents = getTodayEconomicEvents();
    const [newsR,unusualR,earningsR,intradayR,socialR,afterHoursR,finnhubR]=await Promise.allSettled([
      Promise.all(topSymbols.map(s=>getStockNews(s).then(n=>({symbol:s,news:n})))),
      Promise.all(topSymbols.map(s=>getUnusualOptionsActivity(s).then(u=>({symbol:s,unusual:u})))),
      getUpcomingEarnings(topSymbols),
      Promise.all(topSymbols.map(s=>getIntradayContext(s).then(intra=>({symbol:s,intraday:intra})))),
      getSocialSentiment(topSymbols),
      getAfterHoursMovers(activeWatchlist.slice(0,8)),
      Promise.all(topSymbols.slice(0,3).map(s=>getFinnhubNews(s).then(n=>({symbol:s,finnhub:n})).catch(()=>({symbol:s,finnhub:null}))))
    ]);
    const newsMap={};
    if(newsR.status==="fulfilled")newsR.value.forEach(n=>{newsMap[n.symbol]=n.news;});
    const unusualMap={};
    if(unusualR.status==="fulfilled")unusualR.value.forEach(u=>{unusualMap[u.symbol]=u.unusual;});
    const earningsMap=earningsR.status==="fulfilled"?earningsR.value:{};
    const intradayMap={};
    if(intradayR.status==="fulfilled")intradayR.value.forEach(i=>{intradayMap[i.symbol]=i.intraday;});
    const socialMap = socialR.status==="fulfilled" ? socialR.value : {};
    const finnhubMap = {};
    if(finnhubR.status==="fulfilled"&&Array.isArray(finnhubR.value)) finnhubR.value.forEach(f=>{ if(f&&f.finnhub) finnhubMap[f.symbol]=f.finnhub; });
    
    // Use CoinGecko for better Bitcoin data on crypto stocks
    const btcChange = coinGecko.btcChange24h || crypto.btcChange || 0;
    const afterHoursMovers = afterHoursR.status==="fulfilled" ? afterHoursR.value : [];

    // Track recently losing stocks to avoid recommending them again
    const recentTrades = data.trades?.slice(0,10)||[];
    const recentLosingStocks = recentTrades
      .filter(t => t.result === "loss" && new Date(t.date) > new Date(Date.now() - 2*24*60*60*1000))
      .map(t => t.symbol);
    const yesterdayStocks = recentTrades
      .filter(t => new Date(t.date).toDateString() === new Date(Date.now() - 24*60*60*1000).toDateString())
      .map(t => t.symbol);

    // Build preliminary summaries for strategy scoring
    const prelimSummaries = Object.entries(marketDataMap).map(([sym,d]) => ({
      symbol:sym, change:d.priceData?.change||0,
      rsi:d.indicators?.rsi||50, macdBullish:d.indicators?.macd?.bullish||false,
      volume:d.volume?.trend||"AVERAGE", obvTrend:d.indicators?.obv?.trend||"FLAT",
      aboveEMA50:d.priceData?.current>d.indicators?.ema50, aboveEMA200:d.priceData?.current>d.indicators?.ema200,
      stoch:d.indicators?.stochastic||50, williamsR:d.indicators?.williamsR||-50,
      isTrending:trending.includes(sym),
      momentum:{exhaustionLevel:"UNKNOWN",isTradeable:true},
      intraday:null, socialSentiment:{label:"NEUTRAL",buzz:"UNKNOWN"},
      unusualActivity:null, earningsWarning:null
    }));

    // Run the full strategy scoring engine
    let bestStrategy = selectBestStrategy(data, strategyMemory, marketRegime, spyChange, prelimSummaries, dayClassification.dayType);
    
    // If extreme volatile day, recommend sitting out
    if (dayClassification.dayType === "EXTREME_VOLATILE") {
      bestStrategy = { ...bestStrategy, sitOut: true, sitOutReason: dayClassification.tradingAdvice };
    }
    const shouldAdapt = shouldAdaptStrategy(data, strategyMemory);
    const perfAnalysis = analyzePerformance(data, strategyMemory);

    // Add all strategy scores to context
    const allStrategyScores = bestStrategy.allStrategiesScored || [];

    // PATTERN-FIRST STOCK SCORING — placeholder, will be replaced after summaries built
    let patternScores = [];

    // Pattern matching — find similar past setups
    const patterns = strategyMemory.patterns || [];
    const matchingPatterns = patterns.filter(p =>
      p.marketRegime === marketRegime &&
      p.strategy === bestStrategy.key &&
      p.result === "win"
    ).slice(0,3);

    // Education topic for today
    const educationTopics = EDUCATION_TOPICS[edLevel] || EDUCATION_TOPICS[1];
    const todayTopic = educationTopics[Math.floor(Math.random()*educationTopics.length)];

    const summaries=Object.entries(marketDataMap).map(([sym,d])=>({
      symbol:sym, price:d.priceData.current, change:d.priceData.change,
      rsi:d.indicators.rsi, macdBullish:d.indicators.macd?.bullish,
      volumeTrend:d.volume.trend, iv:d.options.iv, atr:d.indicators.atr,
      aboveEMA50:d.priceData.current>d.indicators.ema50,
      aboveEMA200:d.priceData.current>d.indicators.ema200,
      stoch:d.indicators.stochastic, williamsR:d.indicators.williamsR,
      obvTrend:d.indicators.obv?.trend,
      recentNews:(newsMap[sym]||[]).slice(0,3).map(n=>n.title),
      unusualActivity:unusualMap[sym]?{bigMoney:unusualMap[sym].bigMoneyDirection,pcRatio:unusualMap[sym].putCallRatio}:null,
      earningsWarning:earningsMap[sym]?.warning||null,
      isTrending:trending.includes(sym),
      affordableStrikes:(marketDataMap[sym]?.options?.affordableStrikes||[]).slice(0,5),
      socialSentiment:socialMap[sym]||{sentimentScore:50,label:"NEUTRAL",buzz:"UNKNOWN"},
      cryptoCorrelated:["MARA","RIOT","CLSK","WKHS"].includes(sym),
      correlationGroup: getStockCorrelation(sym),
      correlatedLaggards: findCorrelatedLaggards(sym, marketDataMap, spyChange),
      divergence: marketDataMap[sym]?.divergence || null,
      chartPatterns: marketDataMap[sym]?.chartPatterns || null,
      primaryPattern: marketDataMap[sym]?.chartPatterns?.[0] || null,
      smcAnalysis: marketDataMap[sym]?.smcAnalysis || null,
      finnhubSentiment: finnhubMap[sym] || null,
      btcCorrelationSignal: ["MARA","RIOT","CLSK"].includes(sym) ? coinGecko.miningStockImpact : null,
      econEvents: economicEvents.length > 0 ? economicEvents : null,
      momentum:marketDataMap[sym]?.momentum||{exhaustionLevel:"UNKNOWN",isTradeable:true,exhaustionWarning:"",moveRatio:0,remainingRoom:0},
      relativeStrength: (() => {
        const stockChange = marketDataMap[sym]?.priceData?.change || 0;
        const spyChg = spyChange || 0;
        if (Math.abs(spyChg) < 0.5) return { score: 50, label: "NEUTRAL", description: "Market flat — no relative strength comparison" };
        const rs = spyChg !== 0 ? parseFloat((stockChange / spyChg).toFixed(2)) : 1;
        // rs > 1.5 = outperforming (has own strength)
        // rs 0.5-1.5 = moving with market (normal)  
        // rs < 0.3 = lagging (hasn't moved yet - opportunity)
        // rs > 3 = extremely extended (dangerous)
        const label = rs > 3 ? "EXTREMELY_EXTENDED" : rs > 1.5 ? "OUTPERFORMING" : rs < 0.3 ? "LAGGING" : rs < 0 ? "DIVERGING" : "WITH_MARKET";
        const isLaggard = rs < 0.3 && Math.abs(spyChg) > 2;
        const isExtended = rs > 3;
        const description = label === "EXTREMELY_EXTENDED" 
          ? `Moved ${rs}x more than SPY — extremely extended, option has no room left`
          : label === "OUTPERFORMING"
          ? `Moving ${rs}x stronger than SPY — has its own catalyst, good sign`
          : label === "LAGGING"
          ? `Only moved ${stockChange.toFixed(1)}% while SPY moved ${spyChg.toFixed(1)}% — LAGGARD, may catch up later`
          : label === "DIVERGING"
          ? `Moving OPPOSITE to SPY — strong independent movement`
          : `Moving in line with the overall market`;
        return { score: rs, label, description, isLaggard, isExtended, stockChange, spyChange: spyChg };
      })(),
      intraday:intradayMap[sym]?{
        gapPct:intradayMap[sym].gapPct,
        gapType:intradayMap[sym].gapType,
        orbSignal:intradayMap[sym].orbSignal,
        morningTrend:intradayMap[sym].morningTrend,
        aboveVWAP:intradayMap[sym].aboveVWAP,
        vwap:intradayMap[sym].vwap,
        openingRangeHigh:intradayMap[sym].openingRangeHigh,
        openingRangeLow:intradayMap[sym].openingRangeLow,
        realtimeTrend:intradayMap[sym].realtimeTrend,
        trendStrength:intradayMap[sym].trendStrength,
        trendScore:intradayMap[sym].trendScore,
        isMoving:intradayMap[sym].isMoving,
        moveInLast30Min:intradayMap[sym].moveInLast30Min,
        tradingRecommendation:intradayMap[sym].tradingRecommendation,
        plainEnglish:intradayMap[sym].plainEnglish,
      }:null
    }));

    // Get active strategies for today based on day type
    const activeStrategyKeys = Object.entries(STRATEGIES)
      .filter(([,s]) => s.educationLevel <= edLevel)
      .map(([k]) => k);
    
    // MULTI-TIMEFRAME ANALYSIS — fetch correct timeframe per strategy for top stocks
    const topSymbols4TF = topSymbols.slice(0,4);
    const multiTFResults = {};
    await Promise.allSettled(
      topSymbols4TF.map(async sym => {
        const tfAnalysis = await getMultiTimeframeAnalysis(sym, activeStrategyKeys);
        multiTFResults[sym] = tfAnalysis;
      })
    );
    
    // Merge multi-timeframe results into summaries
    const enrichedSummaries = summaries.map(s => ({
      ...s,
      multiTimeframe: multiTFResults[s.symbol] || null
    }));

    // PATTERN-FIRST STOCK SCORING — now runs after summaries is built
    patternScores = enrichedSummaries.map(s => 
      scoreStockWithPatternMTF(s, spyChange, dayClassification.dayType, socialMap, unusualMap, earningsMap, marketContext)
    ).sort((a, b) => b.totalScore - a.totalScore);

    const topScore=Math.max(...summaries.map(s=>{let sc=50;if(s.macdBullish)sc+=8;if(s.aboveEMA50)sc+=5;if(s.obvTrend==="RISING")sc+=8;if(s.unusualActivity?.bigMoney==="BULLISH")sc+=12;if(s.isTrending)sc+=5;return sc;}),0);
    const numTrades=getTradeCount(data.balance,marketTrend,topScore);

    // Hard sit-out check
    const allStocksUpBig = Object.values(marketDataMap).filter(s => Math.abs(s.priceData?.change||0) > 15).length;
    const shouldSitOut = isExtremelyVolatile || allStocksUpBig > 3;
    const marketComment2 = shouldSitOut ? "SIT OUT TODAY" : isMildlyVolatile ? "TRADE CAUTIOUSLY" : "GOOD DAY TO TRADE";
    
    // Trend strength
    const trendStrength = scoreTrendStrength(spyChange, fearGreed.score, null);
    
    // Trading time window
    const timeWindow = getTradingTimeWindow();

    const prompt=`You are an elite adaptive options trading AI. You have LIVE data fetched at ${new Date().toLocaleTimeString()} ET.
    
MARKET SAFETY CHECK:
- Should sit out today: ${shouldSitOut}
- Extreme volatility: ${isExtremelyVolatile} (SPY: ${spyChange}%)
- Stocks up 20%+: ${allStocksUpBig}
${shouldSitOut ? `
⚠️ CRITICAL: Today is NOT safe to trade. SPY is up ${spyChange}% which is historically extreme.
ALL your recommendations should be HOLD/SIT OUT.
Tell the user clearly: "DO NOT TRADE TODAY. The market is moving ${Math.abs(spyChange).toFixed(1)}% which is extremely unusual. Options are overpriced and moves can reverse violently. Protect your $${data.balance} and come back tomorrow."
Do not recommend any stock for trading today.` : ""}

USER PROFILE:
- Balance: $${data.balance} | Goal: $10,000
- Total Trades: ${data.trades.length} | Win Rate: ${data.trades.length>0?Math.round((data.trades.filter(t=>t.result==="win").length/data.trades.length)*100):0}%
- Education Level: ${edLevel}/4 (${edLevel===1?"Beginner":edLevel===2?"Intermediate":edLevel===3?"Advanced":"Expert"})
- Current Strategy: ${bestStrategy.name}
- Should Adapt Strategy: ${shouldAdapt}
- Consecutive Wins: ${data.consecutiveWins||0} | Consecutive Losses: ${data.consecutiveLosses||0}
- Recently Lost On These Stocks (avoid recommending): ${recentLosingStocks.join(", ")||"None"}
- Yesterday's Traded Stocks (deprioritize): ${yesterdayStocks.join(", ")||"None"}

STOCK ROTATION RULES:
- If a stock lost money in the last 2 days — rank it LAST. Do not recommend it as primary trade.
- Rotate to fresh stocks the user hasn't traded recently
- Never recommend the exact same stock 3 days in a row
- If all stocks in watchlist have been traded recently — pick the one with the best current setup regardless

MARKET CONDITIONS:
- SPY: ${spyChange}% | QQQ: ${qqqChange}% | Regime: ${marketRegime}
- Fear & Greed: ${fearGreed.score}/100 — ${fearGreed.rating}
- Preferred Direction: ${preferredDir}

TODAY'S MARKET DAY TYPE: ${dayClassification.dayType}
Day Description: ${dayClassification.description}
Plain English: ${dayClassification.plainEnglish}
Trading Advice: ${dayClassification.tradingAdvice}
Best Strategy For This Day Type: ${dayClassification.bestStrategy}
Confidence: ${dayClassification.confidence}

DAY TYPE RULES:
- CHOPPY day (SPY < 0.5%): DO NOT use Momentum Scalp. Use Oversold Bounce. Find stocks with their OWN catalyst.
- TRENDING day (SPY 0.5-1.5%): Momentum Scalp and Trend Following work well. Follow the direction.
- NEWS_DRIVEN day (SPY 1.5-3%): Trade carefully, reduce size, wait for 10:30 AM.
- EXTREME_VOLATILE day (SPY 3%+): Recommend sitting out entirely.

STRATEGY SCORING ENGINE RESULTS — ALL STRATEGIES RANKED:
${JSON.stringify(allStrategyScores, null, 2)}

WINNER: ${bestStrategy.name} (Score: ${bestStrategy.score}/100)
Score Breakdown: Historical performance: ${bestStrategy.scoreBreakdown?.historical||0} | Market conditions: ${bestStrategy.scoreBreakdown?.conditions||0} | Recent trades: ${bestStrategy.scoreBreakdown?.recent||0} | Win rate target: ${bestStrategy.scoreBreakdown?.target||0}

ACTIVE STRATEGY: ${bestStrategy.name}
Strategy Description: ${bestStrategy.description}
Best Conditions: ${bestStrategy.bestConditions}
Risk Level: ${bestStrategy.riskLevel}
Target Hold Time: ${bestStrategy.holdTime}
${bestStrategy.sitOut ? "⚠️ RECOMMEND SITTING OUT TODAY: " + bestStrategy.sitOutReason : ""}

STRATEGY SELECTION RULES:
- The scoring engine ran ALL strategies against today's conditions
- The winning strategy scored highest across: day type match, stock conditions, historical performance, win rate
- ALWAYS explain in plain English why this strategy won and what conditions it needs to work
- Show the user which strategies scored second and third so they understand the decision
- If top strategy scored below 40 — warn the user conditions are not ideal today

MATCHING PAST WINNING PATTERNS:
${matchingPatterns.length>0?JSON.stringify(matchingPatterns):("No matching patterns yet — building pattern library as you trade.")}

PERFORMANCE INSIGHTS:
${perfAnalysis.hasInsights?perfAnalysis.summary:"Not enough trades for insights yet."}

EDUCATION TOPIC TODAY: "${todayTopic}" (Level ${edLevel} — ${edLevel===1?"Beginner":edLevel===2?"Intermediate":edLevel===3?"Advanced":"Expert"})

MARKET DIRECTION RULES:
- SPY down >2%: ONLY PUT options
- SPY up >2%: Prefer CALL options
- NEVER recommend options costing more than $${data.balance}
- Under $100 balance: options must cost $0.10/share or less ($10 or less per contract)
- Avoid stocks with earnings in 1-2 days

LIVE STOCK DATA:
${JSON.stringify(summaries,null,2)}

UNUSUAL OPTIONS ACTIVITY:
${JSON.stringify(unusualMap,null,2)}

EARNINGS RISKS:
${JSON.stringify(earningsMap,null,2)}

Suggest ${numTrades} trade(s) using the ${bestStrategy.name} strategy adapted to today's conditions.
${shouldAdapt?"IMPORTANT: Also recommend whether to switch strategies and why, based on recent performance.":""}

Return ONLY valid JSON:
{
  "marketSummary":{
    "spyChange":${spyChange},"qqqChange":${qqqChange},"marketTrend":"${marketTrend}",
    "fearGreedScore":${fearGreed.score},"fearGreedRating":"${fearGreed.rating}",
    "trendingStocks":${JSON.stringify(trending.slice(0,5))},
    "preferredDirection":"${preferredDir}","marketRegime":"${marketRegime}",
    "dayType":"${dayClassification.dayType}",
    "dayPlainEnglish":"${dayClassification.plainEnglish}",
    "dayTradingAdvice":"${dayClassification.tradingAdvice}",
    "dayBestStrategy":"${dayClassification.bestStrategy}",
    "isExtremelyVolatile":${isExtremelyVolatile},
    "trendStrength":{"score":${trendStrength.score},"label":"${trendStrength.label}","plainEnglish":"${trendStrength.plainEnglish}"},
    "timeWindow":{"window":"${timeWindow.window}","canTrade":${timeWindow.canTrade},"message":"${timeWindow.message}"},
    "volatileWarning":"${volatileWarning||""}",
    "pdtWarning":"${pdtWarning||""}",
    "balanceWarning":"${balanceWarning||""}",
    "weeklyLimitWarning":"${weeklyLimitWarning||""}",
    "shouldStopTrading":${shouldStopTrading},
    "weekPnl":${weekPnl.toFixed(2)},
    "todayTradeCount":${todayTrades},
    "vix":{"value":${vix.value},"level":"${vix.level}","advice":"${vix.tradingAdvice}","optionCost":"${vix.optionCost}"},
    "crypto":{"btcChange":${crypto.btcChange},"mood":"${crypto.cryptoMood}","impact":"${crypto.impact}"},
    "futures":{
      "esChange":${futures.esChange},
      "tomorrowBias":"${futures.tomorrowBias}",
      "tradingImplication":"${futures.tradingImplication}",
      "plainEnglish":"${futures.plainEnglish}"
    },
    "breadth":{
      "score":${breadth.breadthScore},
      "label":"${breadth.breadthLabel}",
      "advancing":${breadth.advancing||0},
      "declining":${breadth.declining||0},
      "plainEnglish":"${breadth.plainEnglish}",
      "tomorrowImplication":"${breadth.tomorrowImplication}",
      "leadingSector":"${breadth.leadingSector?.sector||"—"} ${breadth.leadingSector?.change||0}%",
      "laggingSector":"${breadth.laggingSector?.sector||"—"} ${breadth.laggingSector?.change||0}%"
    },
    "afterHoursMovers":${JSON.stringify(afterHoursMovers.slice(0,3))},
    "tomorrowEvents":${JSON.stringify(tomorrowEvents)},
    "marketContext":{
      "weekTrend":"${marketContext.weekTrend}",
      "weekChange":${marketContext.weekChange},
      "catalyst":"${marketContext.catalyst}",
      "catalystExplanation":"${marketContext.catalystExplanation}",
      "moveAlreadyDone":${marketContext.moveAlreadyDone},
      "contextRecommendation":"${marketContext.contextRecommendation}",
      "headlines":${JSON.stringify(marketContext.headlines.slice(0,3))},
      "plainEnglish":"${marketContext.plainEnglish}"
    },
    "marketComment":"2 plain English sentences about today's market. If extremely volatile warn beginner traders strongly.",
    "beginnerTip":"1 sentence of the most important thing a beginner should know about trading TODAY specifically",
    "topPatternStock":"${patternScores[0]?.symbol||""}",
    "topPatternScore":${patternScores[0]?.totalScore||0},
    "topPatternStep":"${patternScores[0]?.stepInfo||""}",
    "topPatternReady":${patternScores[0]?.entryReady||false}
  },
  "activeStrategy":{
    "name":"${bestStrategy.name}","key":"${bestStrategy.key}",
    "score":${bestStrategy.score||0},
    "description":"${bestStrategy.description}",
    "whyToday":"2-3 sentences explaining WHY this strategy won the scoring engine today — what specific conditions made it the best choice",
    "whyNotOthers":"1 sentence explaining why the second and third ranked strategies lost",
    "shouldAdapt":${shouldAdapt},
    "adaptationAdvice":"${shouldAdapt?"Specific advice on whether to switch strategies":"No adaptation needed"}",
    "strategyEducation":"Plain English explanation of this strategy for a beginner — what does it mean and how does it work today",
    "allStrategiesRanked":${JSON.stringify(allStrategyScores.slice(0,4))}
  },
  "patternMatch":{
    "found":${matchingPatterns.length>0},
    "count":${matchingPatterns.length},
    "message":"${matchingPatterns.length>0?"Similar past setups found":"No matching patterns yet — this trade will be added to your pattern library"}"
  },
  "educationLesson":{
    "topic":"${todayTopic}",
    "level":${edLevel},
    "explanation":"Clear explanation of ${todayTopic} written for education level ${edLevel}. Start simple. Use an analogy if helpful.",
    "whyItMatters":"1 sentence on why this concept matters for your trading",
    "actionable":"1 specific thing to watch for in today's trade that relates to this lesson"
  },
  "numberOfTrades":${numTrades},
  "trades":[
    {
      "rank":1,
      "symbol":string,
      "symbolReason":string,
      "newsSentiment":"BULLISH" or "BEARISH" or "NEUTRAL",
      "newsHeadlines":[string,string],
      "unusualActivity":string,
      "earningsRisk":"None" or warning,
      "chartPattern":"Name and plain English explanation of the PRIMARY chart pattern detected — what would a trader see on TradingView right now?",
      "chartPatternAction":"Specific action based on the pattern — buy calls, avoid, wait for breakout etc",
      "smcSetup":"Plain English explanation of the FVG + BOS + Liquidity setup for this stock. Is there an active SMC entry signal?",
      "smcEntryState":"ENTER NOW (green candle in FVG after BOS)" or "WAIT FOR PULLBACK TO FVG" or "WAIT FOR BOS" or "NO SETUP",
      "fvgZone":"The exact price zone to watch e.g. $3.45 - $3.62",
      "divergence":"Explain any divergence detected in plain English",
      "thetaWarning":"Plain English warning about time decay — how much is this option losing per day just from time passing?",
      "strategyFit":"How this specific stock fits the ${bestStrategy.name} strategy today",
      "correlationGroup":"What sector/group this stock belongs to and how connected stocks are moving",
      "correlatedLaggards":"List any stocks in the same group that haven't moved yet — laggard opportunities",
      "correlationInsight":"Plain English explanation of how this stock connects to others and what that means for the trade",
      "signal":"BUY" or "SELL" or "HOLD",
      "entryState":"WAIT — Setup building, watch for [trigger]" or "READY — Enter when [specific condition]" or "ENTER NOW — All conditions met",
      "entryTrigger":"The EXACT thing that needs to happen before entering. Example: Price must close above $13.50 with volume above 500k. Or: Price holds above VWAP for 2 consecutive minutes.",
      "confidence":"LOW" or "MEDIUM" or "HIGH",
      "tooLate":true or false,
      "tooLateReason":"Why it is too late if applicable",
      "rewardRiskRatio":number,
      "rewardRiskBlocked":true or false,
      "spreadPercent":number,
      "accuracyScore":number,
      "indicatorConsensus":{"bullish":number,"bearish":number,"neutral":number},
      "signalExplanation":string,
      "currentPrice":number,"priceChange":number,"weekHigh":number,"weekLow":number,
      "volume":string,"avgVolume":string,
      "exitStrategy":{
        "recommendedHoldTime":string,"latestExitTime":string,
        "sellSignals":[string,string,string,string,string],
        "doNotHoldIf":[string,string],
        "dayTradingTips":string
      },
      "probability":{
        "overallPercent":number,
        "factors":[
          {"label":"Trend Alignment","score":number,"note":string},
          {"label":"Momentum (MACD/RSI/Stoch)","score":number,"note":string},
          {"label":"Volume & OBV","score":number,"note":string},
          {"label":"News Sentiment","score":number,"note":string},
          {"label":"Unusual Options Activity","score":number,"note":string},
          {"label":"Pattern Match","score":number,"note":string},
          {"label":"Fear & Greed","score":number,"note":string}
        ],
        "verdict":string
      },
      "scenarios":[
        {"type":"bull","label":"Bull Case","probability":string,"target":number,"result":string},
        {"type":"base","label":"Base Case","probability":string,"target":number,"result":string},
        {"type":"bear","label":"Bear Case","probability":string,"target":number,"result":string},
        {"type":"worst","label":"Worst Case","probability":string,"target":number,"result":string}
      ],
      "entryPrice":number,"entryNote":string,"stopLoss":number,"stopNote":string,
      "profitTarget":number,"targetNote":string,"riskReward":string,"atrNote":string,
      "budget":{
        "suggestedOptionType":"CALL" or "PUT","strikePrice":number,
        "expiration":string,"estimatedOptionCost":string,
        "amountToRisk":string,"maxLoss":string,"estimatedGain":string,
        "robinhoodSteps":"STEP BY STEP — OPENING THE TRADE:\n\n1. Open Robinhood and search [SYMBOL]\n\n2. Tap Trade → Trade Options\n\n3. You will see 4 buttons — tap BUY (orange, left) and tap CALL (orange, right). Do NOT tap Sell or Put.\n\n4. Select expiration date: [exact expiration date]\n\n5. Find the exact option — look for strike price $[strike]. The option name will look like: [SYMBOL] $[strike] Call [date]. If you cannot find it scroll up or down the list.\n\n6. Check the Ask Price column — it should be close to [estimated cost] per share. If it is much higher than expected scroll UP to find a cheaper strike.\n\n7. Tap the + button next to your chosen strike.\n\n8. Set quantity to 1 contract. Change order type to Limit. Set limit price to $0.01 ABOVE the current ask price — this guarantees your order fills faster. Example: if ask shows $0.08 set limit to $0.09.\n\n9. Tap Review Order → Submit.\n\n10. If it shows Queued wait up to 3 minutes. If still not filled after 3 minutes cancel and try again — the price may have moved.\n\n11. If you see Partial Fill — that means only some filled. Cancel the rest and work with what you have.\n\nOPENING DECISION RULE: If the option drops 20% within the first 10 minutes of buying — sell immediately. The setup failed. Do not hope it comes back.\n\nCLOSING THE TRADE:\n\n12. Go to Portfolio (graph icon at bottom of Robinhood) → find [SYMBOL] → tap it → tap Sell to Close\n\n13. Set quantity to 1 contract\n\n14. Change to Limit order. Set limit price to $0.01 BELOW the current Bid price — this guarantees a fast fill. Example: if Bid shows $0.12 set limit to $0.11.\n\n15. Tap Review → Submit → wait for Filled confirmation\n\n16. Come back to this app and log the result immediately."
      },
      "indicators":[
        {"name":"RSI (14)","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"MACD","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"EMA 20","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"EMA 50","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"EMA 200","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"Bollinger Bands","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"Stochastic","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"Williams %R","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"OBV Trend","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"ATR (14)","value":string,"signal":"VOLATILITY","color":"yellow","meaning":string},
        {"name":"Volume Trend","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
        {"name":"Implied Volatility","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string}
      ],
      "support":[{"level":number,"strength":string},{"level":number,"strength":string},{"level":number,"strength":string}],
      "resistance":[{"level":number,"strength":string},{"level":number,"strength":string},{"level":number,"strength":string}],
      "analysis":string
    }
  ],
  "stockRankings":[{"symbol":string,"score":number,"reason":string,"newsSentiment":string,"unusualActivity":string}],
  "positionSizing":{
    "totalBudgetToRisk":string,"perTradeBreakdown":[{"trade":number,"symbol":string,"amount":string,"reasoning":string}],
    "reserveAmount":string,"reasoning":string
  },
  "challengeContext":string,
  "performanceCoach":{
    "hasInsights":${perfAnalysis.hasInsights},
    "insights":${JSON.stringify(perfAnalysis.insights||[])},
    "summary":"${perfAnalysis.hasInsights?perfAnalysis.summary:"Complete more trades to unlock your personal performance analysis!"}"
  }
}`;

    const ai = await anthropic.messages.create({ model:"claude-sonnet-4-5", max_tokens:8000, messages:[{role:"user",content:prompt}] });
    const raw = ai.content[0].text;
    
    // Robust JSON extraction with truncation recovery
    let analysis;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON in response");
      analysis = JSON.parse(match[0]);
    } catch(parseErr) {
      // JSON was truncated — attempt repair by closing open brackets
      console.error("JSON truncated, attempting repair...");
      let partial = raw;
      // Find last complete field by trimming from last complete comma+quote
      const lastGood = partial.lastIndexOf('","');
      if (lastGood > 0) partial = partial.substring(0, lastGood + 1) + '"truncated":true}]}]}';
      try {
        // Try a minimal fallback parse
        const match2 = partial.match(/\{[\s\S]*/);
        if (match2) {
          // Count open brackets and close them
          let opens = (match2[0].match(/\{/g)||[]).length;
          let closes = (match2[0].match(/\}/g)||[]).length;
          let arrOpens = (match2[0].match(/\[/g)||[]).length;
          let arrCloses = (match2[0].match(/\]/g)||[]).length;
          let repaired = match2[0];
          for(let i=0;i<arrOpens-arrCloses;i++) repaired += ']';
          for(let i=0;i<opens-closes;i++) repaired += '}';
          analysis = JSON.parse(repaired);
          analysis._truncated = true;
        }
      } catch(e2) {
        throw new Error("AI response was too long and could not be parsed. Try again.");
      }
    }

    // Update strategy memory
    if (shouldAdapt) {
      strategyMemory.lastAdaptation = new Date().toISOString();
      saveStrategyMemory(strategyMemory);
    }

    analysis._fetchedAt = new Date().toISOString();
    analysis._balance = data.balance;
    analysis._edLevel = edLevel;
    analysis._availableStrategies = Object.entries(STRATEGIES).filter(([,s])=>s.educationLevel<=edLevel).map(([k,s])=>({key:k,...s,performance:strategyMemory.strategyPerformance?.[k]||{wins:0,losses:0}}));
    analysis._trades = data.trades.slice(-20);
    analysis._milestones = data.milestones;

    res.json({ success:true, data:analysis });

  } catch(err) {
    console.error("Analysis error:", err);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ─── Log trade (updates strategy memory) ─────────────────────────────────────
app.post("/api/trade/log", (req, res) => {
  const { symbol, optionType, entryPrice, exitPrice, amount, result, notes, strategy, marketRegime } = req.body;
  const data = loadData();
  const strategyMemory = loadStrategyMemory();
  const pnl = result==="win" ? parseFloat((exitPrice-amount).toFixed(2)) : parseFloat((-amount).toFixed(2));
  const oldBalance = data.balance;
  data.balance = parseFloat(Math.max(0, data.balance+pnl).toFixed(2));

  // Update consecutive win/loss
  if (result==="win") { data.consecutiveWins=(data.consecutiveWins||0)+1; data.consecutiveLosses=0; }
  else { data.consecutiveLosses=(data.consecutiveLosses||0)+1; data.consecutiveWins=0; }

  const trade = { id:Date.now(), date:new Date().toISOString(), symbol, optionType, entryPrice, exitPrice, amountRisked:amount, pnl, result, balanceAfter:data.balance, notes:notes||"", strategy:strategy||data.currentStrategy, marketRegime:marketRegime||"UNKNOWN" };
  data.trades.unshift(trade);

  // Update strategy memory
  const strat = strategy || data.currentStrategy || "MOMENTUM_SCALP";
  if (!strategyMemory.strategyPerformance[strat]) strategyMemory.strategyPerformance[strat]={wins:0,losses:0,totalPnl:0};
  if (result==="win") strategyMemory.strategyPerformance[strat].wins++;
  else strategyMemory.strategyPerformance[strat].losses++;
  strategyMemory.strategyPerformance[strat].totalPnl = parseFloat((strategyMemory.strategyPerformance[strat].totalPnl+pnl).toFixed(2));

  // Add pattern
  strategyMemory.patterns.unshift({ id:Date.now(), date:new Date().toISOString(), symbol, optionType, strategy:strat, marketRegime:marketRegime||"UNKNOWN", result, pnl, pct:amount>0?parseFloat((pnl/amount*100).toFixed(1)):0 });
  if (strategyMemory.patterns.length > 100) strategyMemory.patterns = strategyMemory.patterns.slice(0,100);
  strategyMemory.totalPatterns++;

  const hit = checkMilestone(oldBalance, data.balance, data.milestones);
  if (hit) { data.milestones.push(hit); trade.milestone=hit; }

  saveData(data);
  saveStrategyMemory(strategyMemory);
  res.json({ success:true, trade, newBalance:data.balance, milestone:hit||null, consecutiveWins:data.consecutiveWins, consecutiveLosses:data.consecutiveLosses });
});

// ─── Paper trade ──────────────────────────────────────────────────────────────
app.post("/api/paper/trade", (req, res) => {
  const { symbol, optionType, strikePrice, premium, action, contracts, exitPremium, notes } = req.body;
  const paper = loadPaperTrades();
  if (action === "buy") {
    const cost = parseFloat((premium * 100 * (contracts||1)).toFixed(2));
    if (cost > paper.balance) return res.status(400).json({ success:false, error:"Insufficient paper balance" });
    paper.balance = parseFloat((paper.balance-cost).toFixed(2));
    const trade = { id:Date.now(), date:new Date().toISOString(), symbol, optionType, strikePrice, premium, contracts:contracts||1, cost, status:"open", notes:notes||"" };
    paper.active.push(trade);
    paper.trades.unshift(trade);
    savePaperTrades(paper);
    return res.json({ success:true, trade, balance:paper.balance });
  }
  if (action === "close") {
    const { tradeId } = req.body;
    const idx = paper.active.findIndex(t=>t.id===tradeId);
    if (idx===-1) return res.status(404).json({ success:false, error:"Trade not found" });
    const trade = paper.active[idx];
    const exitValue = parseFloat((exitPremium * 100 * trade.contracts).toFixed(2));
    const pnl = parseFloat((exitValue-trade.cost).toFixed(2));
    paper.balance = parseFloat((paper.balance+exitValue).toFixed(2));
    trade.status="closed"; trade.exitPremium=exitPremium; trade.exitValue=exitValue; trade.pnl=pnl; trade.result=pnl>0?"win":"loss"; trade.closedAt=new Date().toISOString();
    paper.active.splice(idx,1);
    savePaperTrades(paper);
    return res.json({ success:true, trade, pnl, balance:paper.balance });
  }
  res.status(400).json({ success:false, error:"Invalid action" });
});

app.get("/api/paper/status", (req, res) => {
  const paper = loadPaperTrades();
  res.json({ success:true, data:paper });
});

app.post("/api/paper/reset", (req, res) => {
  const paper = { balance:1000, trades:[], active:[] };
  savePaperTrades(paper);
  res.json({ success:true, message:"Paper trading reset to $1,000" });
});

// ─── Strategy memory & performance ───────────────────────────────────────────
app.get("/api/strategy", (req, res) => {
  const sm = loadStrategyMemory();
  const data = loadData();
  const edLevel = getEducationLevel(data, sm);
  res.json({ success:true, data:{ ...sm, availableStrategies:Object.entries(STRATEGIES).filter(([,s])=>s.educationLevel<=edLevel).map(([k,s])=>({key:k,...s,performance:sm.strategyPerformance?.[k]||{wins:0,losses:0}})), educationLevel:edLevel, educationTopics:EDUCATION_TOPICS } });
});

app.get("/api/performance", (req, res) => {
  const data = loadData();
  const sm = loadStrategyMemory();
  res.json({ success:true, data:analyzePerformance(data, sm) });
});

// ─── Standard endpoints ───────────────────────────────────────────────────────
app.post("/api/balance/update", (req, res) => {
  const { balance } = req.body;
  if (isNaN(balance)||balance<0) return res.status(400).json({ success:false, error:"Invalid" });
  const data = loadData();
  const old = data.balance;
  data.balance = parseFloat(parseFloat(balance).toFixed(2));
  const hit = checkMilestone(old, data.balance, data.milestones);
  if (hit) data.milestones.push(hit);
  saveData(data);
  res.json({ success:true, balance:data.balance, milestone:hit||null });
});

app.get("/api/challenge", (req, res) => {
  const data = loadData();
  res.json({ success:true, data });
});

// ─── Export all data as backup ────────────────────────────────────────────────
app.get("/api/export", (req, res) => {
  try {
    const data = loadData();
    const strategy = loadStrategyMemory();
    const backup = {
      exportedAt: new Date().toISOString(),
      version: "3.0",
      challenge: data,
      strategyMemory: strategy
    };
    res.setHeader("Content-Disposition", "attachment; filename=trading-backup-" + new Date().toISOString().split("T")[0] + ".json");
    res.setHeader("Content-Type", "application/json");
    res.json(backup);
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── Import backup data ───────────────────────────────────────────────────────
app.post("/api/import", (req, res) => {
  try {
    const { challenge, strategyMemory } = req.body;
    if (challenge) saveData(challenge);
    if (strategyMemory) saveStrategyMemory(strategyMemory);
    res.json({ success:true, message:"Data restored successfully!" });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── Manual trade entry (for logging past trades) ─────────────────────────────
app.post("/api/trade/manual", (req, res) => {
  const { symbol, optionType, amount, exitValue, result, date, notes, strategy } = req.body;
  const data = loadData();
  const sm = loadStrategyMemory();
  const pnl = result==="win" ? parseFloat((exitValue-amount).toFixed(2)) : parseFloat((-amount).toFixed(2));
  const oldBalance = data.balance;
  
  // Don't change balance for manual past entries — just log the trade
  const trade = {
    id: Date.now(),
    date: date || new Date().toISOString(),
    symbol, optionType,
    entryPrice: amount, exitPrice: exitValue,
    amountRisked: amount, pnl, result,
    balanceAfter: data.balance,
    notes: notes || "",
    strategy: strategy || "MOMENTUM_SCALP",
    marketRegime: "UNKNOWN",
    manualEntry: true
  };
  
  data.trades.unshift(trade);
  
  // Update strategy memory
  const strat = strategy || "MOMENTUM_SCALP";
  if (!sm.strategyPerformance[strat]) sm.strategyPerformance[strat] = {wins:0,losses:0,totalPnl:0};
  if (result==="win") sm.strategyPerformance[strat].wins++;
  else if (result==="loss") sm.strategyPerformance[strat].losses++;
  sm.strategyPerformance[strat].totalPnl = parseFloat((sm.strategyPerformance[strat].totalPnl+pnl).toFixed(2));
  
  sm.patterns.unshift({
    id: Date.now(), date: date || new Date().toISOString(),
    symbol, optionType, strategy: strat,
    marketRegime: "UNKNOWN", result, pnl,
    pct: amount>0 ? parseFloat((pnl/amount*100).toFixed(1)) : 0
  });
  
  saveData(data);
  saveStrategyMemory(sm);
  res.json({ success:true, trade });
});

// Reset journey
app.post("/api/reset", (req, res) => {
  const { startingBalance } = req.body;
  const balance = parseFloat(startingBalance) || 10;
  const fresh = { balance, startingBalance:balance, goal:10000, trades:[], milestones:[], createdAt:new Date().toISOString(), currentStrategy:"MOMENTUM_SCALP", tradeLevel:"BEGINNER", consecutiveWins:0, consecutiveLosses:0 };
  saveData(fresh);
  const freshStrategy = { patterns:[], strategyPerformance:{}, marketRegimeHistory:[], lastAdaptation:null, totalPatterns:0 };
  saveStrategyMemory(freshStrategy);
  res.json({ success:true, message:"Journey reset! Starting fresh at $"+balance });
});

app.get("/api/price/:symbol", async (req, res) => {
  try { const p = await getCurrentPrice(req.params.symbol.toUpperCase()); res.json({ success:true, price:p }); }
  catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post("/api/monitor/start", async (req, res) => {
  const { email, symbol, entryPrice, stopLoss, profitTarget, signal, optionType } = req.body;
  if (!email||!symbol||!entryPrice||!stopLoss||!profitTarget) return res.status(400).json({ success:false, error:"Missing fields" });
  const id = Date.now().toString();
  await sendAlertEmail(email,`🟢 ${symbol} Monitor Started`,`<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px"><h2 style="color:#00e5ff">📊 ${symbol} Active</h2><p>Stop: $${stopLoss} | Target: $${profitTarget}</p><p style="color:#4a6b85;font-size:12px">Checking every 3 min.</p></div>`);
  const intervalId = setInterval(async()=>{
    const m=activeMonitors[id];
    if(!m||m.triggered){clearInterval(intervalId);delete activeMonitors[id];return;}
    try{
      const cp=await getCurrentPrice(symbol);
      const isBuy=signal==="BUY";
      const hitStop=isBuy?cp<=stopLoss:cp>=stopLoss;
      const hitTarget=isBuy?cp>=profitTarget:cp<=profitTarget;
      if(hitStop||hitTarget){
        m.triggered=true;clearInterval(intervalId);
        const win=hitTarget;
        await sendAlertEmail(email,win?`🟢 TAKE PROFIT — ${symbol}!`:`🔴 STOP LOSS — ${symbol}!`,`<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px"><h2 style="color:${win?"#00ff88":"#ff3b5c"}">${win?"🟢 PROFIT HIT!":"🔴 STOP LOSS HIT!"}</h2><p>${symbol} at $${cp}</p><strong>Open Robinhood NOW and ${win?"take profits!":"cut losses!"}</strong></div>`);
        delete activeMonitors[id];
      }
    }catch(e){}
  },3*60*1000);
  activeMonitors[id]={email,symbol,entryPrice,stopLoss,profitTarget,signal,optionType,intervalId,triggered:false};
  res.json({success:true,monitorId:id});
});

app.post("/api/monitor/stop",(req,res)=>{
  const {monitorId}=req.body;
  if(activeMonitors[monitorId]){clearInterval(activeMonitors[monitorId].intervalId);delete activeMonitors[monitorId];}
  res.json({success:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

// ─── Background Market Scanner ────────────────────────────────────────────────
const alertHistory = {}; // Track sent alerts to avoid duplicates
const subscribedEmails = new Set(); // Track subscribed users

// ─── Pending Setup Storage ────────────────────────────────────────────────────
const PENDING_FILE = path.join(__dirname, "pending_setups.json");

function loadPendingSetups() {
  if (!fs.existsSync(PENDING_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); }
  catch(e) { return []; }
}

function savePendingSetups(setups) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(setups, null, 2));
}

// Save a pending setup when app says WAIT
app.post("/api/setup/save", (req, res) => {
  const { symbol, direction, triggerPrice, triggerType, stopLoss, profitTarget, strategy, email, vwap, orbHigh } = req.body;
  const setups = loadPendingSetups();
  
  // Remove any existing setup for this symbol
  const filtered = setups.filter(s => s.symbol !== symbol);
  
  const newSetup = {
    id: Date.now(),
    symbol, direction, triggerPrice, triggerType,
    stopLoss, profitTarget, strategy,
    email, vwap, orbHigh,
    createdAt: new Date().toISOString(),
    status: "WAITING",
    expiresAt: new Date(Date.now() + 4*60*60*1000).toISOString() // Expires in 4 hours
  };
  
  filtered.push(newSetup);
  savePendingSetups(filtered);
  
  // Send confirmation email
  if (email && email.includes("@")) {
    sendAlertEmail(email, `⏳ Watching ${symbol} for Entry Trigger`,
      `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px;">
        <h2 style="color:#ffd600">⏳ WATCHING FOR ENTRY — ${symbol}</h2>
        <p>The background scanner is now watching <strong>${symbol}</strong> every 90 seconds.</p>
        <p><strong style="color:#00e5ff">Trigger:</strong> ${triggerType} at $${triggerPrice}</p>
        <p><strong style="color:#ff3b5c">Stop Loss:</strong> $${stopLoss}</p>
        <p><strong style="color:#00ff88">Target:</strong> $${profitTarget}</p>
        <p style="color:#4a6b85;margin-top:12px;font-size:12px">You'll get an alert the moment the trigger fires or if the setup is cancelled.</p>
      </div>`
    ).catch(()=>{});
  }
  
  res.json({ success: true, setup: newSetup });
});

app.get("/api/setup/pending", (req, res) => {
  const setups = loadPendingSetups().filter(s => s.status === "WAITING");
  res.json({ success: true, setups });
});

app.delete("/api/setup/cancel/:id", (req, res) => {
  const setups = loadPendingSetups().filter(s => s.id !== parseInt(req.params.id));
  savePendingSetups(setups);
  res.json({ success: true });
});

app.post("/api/scanner/subscribe", (req, res) => {
  const { email } = req.body;
  if (email && email.includes("@")) {
    subscribedEmails.add(email);
    res.json({ success:true, message:`Subscribed ${email} to live alerts` });
  } else {
    res.status(400).json({ success:false, error:"Invalid email" });
  }
});

app.post("/api/scanner/unsubscribe", (req, res) => {
  const { email } = req.body;
  subscribedEmails.delete(email);
  res.json({ success:true });
});

app.get("/api/scanner/status", (req, res) => {
  res.json({ 
    success:true, 
    running: true,
    subscribedCount: subscribedEmails.size,
    lastAlerts: Object.entries(alertHistory).slice(-5).map(([k,v]) => ({symbol:k.split("_")[0], trigger:k.split("_")[1], time:v}))
  });
});

// Catalyst detection function
async function detectCatalysts() {
  try {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    // Only scan during market hours ET (14:30-21:00 UTC = 9:30 AM - 4:00 PM ET roughly)
    const utcHour = now.getUTCHours();
    if (utcHour < 14 || utcHour >= 21) return; // Market closed
    if (now.getDay() === 0 || now.getDay() === 6) return; // Weekend
    
    const watchlist = ["SOUN","SOFI","MARA","RIOT","VALE","AAL","NIO","PLTR"];
    const alerts = [];
    
    // Check Bitcoin first (affects MARA/RIOT)
    const crypto = await getCoinGeckoCrypto().catch(()=>null);
    if (crypto && Math.abs(crypto.btcChange24h) > 3) {
      const alertKey = `BTC_bigmove_${now.toDateString()}`;
      if (!alertHistory[alertKey]) {
        alertHistory[alertKey] = now.toISOString();
        alerts.push({
          type: "CRYPTO_CATALYST",
          symbol: crypto.btcChange24h > 0 ? "MARA" : "RIOT",
          message: `₿ BITCOIN ALERT: BTC ${crypto.btcChange24h > 0 ? "UP" : "DOWN"} ${Math.abs(crypto.btcChange24h).toFixed(1)}% — ${crypto.miningStockImpact}`,
          urgency: "HIGH",
          action: crypto.btcChange24h > 0 ? "Consider MARA or RIOT CALL options" : "Avoid MARA/RIOT calls today"
        });
      }
    }
    
    // Check each stock for catalysts
    for (const symbol of watchlist.slice(0,4)) { // Limit to avoid rate limiting
      try {
        const [quote, intraday] = await Promise.allSettled([
          fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`, {headers:{"User-Agent":"Mozilla/5.0"}}).then(r=>r.json()),
          getIntradayContext(symbol)
        ]);
        
        if (quote.status !== "fulfilled") continue;
        const meta = quote.value?.chart?.result?.[0]?.meta;
        if (!meta) continue;
        
        const currentPrice = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose;
        const todayChange = ((currentPrice-prevClose)/prevClose*100);
        
        // Catalyst 1: Opening Range Breakout
        if (intraday.status === "fulfilled" && intraday.value) {
          const intra = intraday.value;
          if (intra.orbSignal === "BULLISH_BREAKOUT" && intra.isMoving) {
            const alertKey = `${symbol}_ORB_${now.toDateString()}`;
            if (!alertHistory[alertKey]) {
              alertHistory[alertKey] = now.toISOString();
              alerts.push({
                type: "ORB_BREAKOUT",
                symbol,
                message: `🚀 ${symbol} BREAKOUT: Price broke above opening range high at $${intra.openingRangeHigh} with momentum. Real time trend: UPTREND. VWAP: ${intra.aboveVWAP?"ABOVE ✅":"BELOW ❌"}`,
                urgency: "HIGH",
                action: `Consider ${symbol} CALL options — breakout confirmed`
              });
            }
          }
          
          // Catalyst 2: VWAP Reclaim
          if (intra.aboveVWAP && intra.realtimeTrend === "UPTREND" && intra.isMoving) {
            const alertKey = `${symbol}_VWAP_${now.toDateString()}_${hour}`;
            if (!alertHistory[alertKey]) {
              alertHistory[alertKey] = now.toISOString();
              alerts.push({
                type: "VWAP_RECLAIM",
                symbol,
                message: `📊 ${symbol} VWAP RECLAIM: Price above VWAP at $${intra.vwap} and trending UP. Strong intraday signal.`,
                urgency: "MEDIUM",
                action: `${symbol} showing bullish momentum — watch for entry opportunity`
              });
            }
          }
        }
        
        // Catalyst 3: Unusual price move in last period
        const quotes2 = quote.value?.chart?.result?.[0]?.indicators?.quote?.[0];
        const closes = quotes2?.close?.filter(Boolean) || [];
        if (closes.length >= 3) {
          const recentMove = Math.abs((closes[closes.length-1]-closes[closes.length-3])/closes[closes.length-3]*100);
          if (recentMove > 2) { // 2%+ move in last 10 minutes
            const alertKey = `${symbol}_MOVE_${now.toDateString()}_${hour}_${Math.floor(minute/15)}`;
            if (!alertHistory[alertKey]) {
              alertHistory[alertKey] = now.toISOString();
              const direction = closes[closes.length-1] > closes[closes.length-3] ? "UP" : "DOWN";
              alerts.push({
                type: "RAPID_MOVE",
                symbol,
                message: `⚡ ${symbol} RAPID MOVE: ${direction} ${recentMove.toFixed(1)}% in last 10 minutes. Momentum building.`,
                urgency: "MEDIUM",
                action: direction === "UP" ? `Watch ${symbol} for CALL opportunity` : `Watch ${symbol} for PUT opportunity`
              });
            }
          }
        }
        
        await new Promise(r=>setTimeout(r,500)); // Rate limit between stocks
      } catch(e) { continue; }
    }
    
    // Send alerts to subscribed emails
    if (alerts.length > 0 && subscribedEmails.size > 0) {
      const alertHtml = `
        <div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px;">
          <h2 style="color:#00e5ff">🚨 TRADING ALERT — ${new Date().toLocaleTimeString()} ET</h2>
          ${alerts.map(a => `
            <div style="margin:12px 0;padding:12px;background:rgba(${a.urgency==="HIGH"?"255,59,92":"0,229,255"},0.1);border-left:3px solid ${a.urgency==="HIGH"?"#ff3b5c":"#00e5ff"};">
              <strong style="color:${a.urgency==="HIGH"?"#ff3b5c":"#00e5ff"}">${a.type}: ${a.symbol}</strong><br>
              ${a.message}<br>
              <em style="color:#ffd600">Action: ${a.action}</em>
            </div>
          `).join("")}
          <p style="color:#4a6b85;margin-top:16px;font-size:12px">Open your trading app and click "Find My Best Trade" for full analysis.</p>
        </div>`;
      
      for (const email of subscribedEmails) {
        await sendAlertEmail(email, `🚨 ${alerts.length} Trading Alert${alerts.length>1?"s":""} — ${alerts.map(a=>a.symbol).join(", ")}`, alertHtml).catch(()=>{});
      }
      
      console.log(`[Scanner] Sent ${alerts.length} alerts to ${subscribedEmails.size} subscribers`);
    }
    
    // CHECK PENDING SETUPS — entry confirmation system
    const pendingSetups = loadPendingSetups().filter(s => s.status === "WAITING");
    const now2 = new Date();
    
    for (const setup of pendingSetups) {
      // Check if expired
      if (new Date(setup.expiresAt) < now2) {
        setup.status = "EXPIRED";
        if (setup.email) {
          await sendAlertEmail(setup.email, `⏰ Setup Expired — ${setup.symbol}`,
            `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px;">
              <h2 style="color:#4a6b85">⏰ SETUP EXPIRED — ${setup.symbol}</h2>
              <p>The entry trigger for ${setup.symbol} at $${setup.triggerPrice} was not reached in time.</p>
              <p style="color:#4a6b85">Run a new analysis tomorrow for fresh setups.</p>
            </div>`
          ).catch(()=>{});
        }
        continue;
      }
      
      try {
        // Fetch current price and intraday data
        const [priceR, intradayR] = await Promise.allSettled([
          fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${setup.symbol}?interval=2m&range=1d`, {headers:{"User-Agent":"Mozilla/5.0"}}).then(r=>r.json()),
          getIntradayContext(setup.symbol)
        ]);
        
        if (priceR.status !== "fulfilled") continue;
        const currentPrice = priceR.value?.chart?.result?.[0]?.meta?.regularMarketPrice;
        const intraday = intradayR.status === "fulfilled" ? intradayR.value : null;
        
        if (!currentPrice) continue;
        
        // Check trigger conditions
        let triggered = false;
        let triggerMessage = "";
        let cancelled = false;
        let cancelMessage = "";
        
        // Entry trigger check
        if (setup.direction === "CALL") {
          // For calls, price needs to break ABOVE trigger
          if (currentPrice >= setup.triggerPrice) {
            // Also check volume confirmation if we have intraday data
            const volumeOk = !intraday || intraday.isMoving;
            const trendOk = !intraday || intraday.realtimeTrend === "UPTREND";
            if (volumeOk && trendOk) {
              triggered = true;
              triggerMessage = `${setup.symbol} broke above $${setup.triggerPrice} at current price $${currentPrice.toFixed(2)}. Real time trend: UPTREND confirmed. ENTER NOW.`;
            }
          }
          // Cancel if drops below stop loss
          if (currentPrice <= setup.stopLoss) {
            cancelled = true;
            cancelMessage = `${setup.symbol} dropped to $${currentPrice.toFixed(2)}, below stop loss of $${setup.stopLoss}. Setup cancelled.`;
          }
          // Cancel if drops below VWAP significantly
          if (intraday && !intraday.aboveVWAP && setup.vwap && currentPrice < setup.vwap * 0.99) {
            cancelled = true;
            cancelMessage = `${setup.symbol} dropped below VWAP ($${setup.vwap}). Bullish setup invalidated. Do not trade.`;
          }
        } else {
          // For puts, price needs to break BELOW trigger
          if (currentPrice <= setup.triggerPrice) {
            const trendOk = !intraday || intraday.realtimeTrend === "DOWNTREND";
            if (trendOk) {
              triggered = true;
              triggerMessage = `${setup.symbol} broke below $${setup.triggerPrice} at $${currentPrice.toFixed(2)}. Downtrend confirmed. ENTER NOW with PUT.`;
            }
          }
          if (currentPrice >= setup.stopLoss) {
            cancelled = true;
            cancelMessage = `${setup.symbol} rallied above $${setup.stopLoss}. Put setup cancelled.`;
          }
        }
        
        if (triggered) {
          setup.status = "TRIGGERED";
          alerts.push({
            type: "ENTRY_CONFIRMED",
            symbol: setup.symbol,
            message: `🟢 ENTER NOW — ${triggerMessage}`,
            urgency: "HIGH",
            action: `Open Robinhood → search ${setup.symbol} → Trade Options → BUY ${setup.direction} → Target: $${setup.profitTarget} | Stop: $${setup.stopLoss}`
          });
          
          if (setup.email) {
            await sendAlertEmail(setup.email, `🟢 ENTER NOW — ${setup.symbol} Trigger Hit!`,
              `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px;">
                <h2 style="color:#00ff88;font-size:28px">🟢 ENTER NOW — ${setup.symbol}</h2>
                <p style="font-size:16px">${triggerMessage}</p>
                <div style="background:rgba(0,255,136,0.1);padding:16px;margin:12px 0;border-left:4px solid #00ff88;">
                  <p><strong>Action:</strong> Open Robinhood NOW</p>
                  <p><strong>Trade:</strong> BUY ${setup.direction} on ${setup.symbol}</p>
                  <p><strong style="color:#ff3b5c">Stop Loss:</strong> $${setup.stopLoss}</p>
                  <p><strong style="color:#00ff88">Target:</strong> $${setup.profitTarget}</p>
                </div>
                <p style="color:#ffd600;font-size:12px">⚡ Act quickly — the window is open now but may close fast.</p>
              </div>`
            ).catch(()=>{});
          }
        } else if (cancelled) {
          setup.status = "CANCELLED";
          alerts.push({
            type: "SETUP_CANCELLED",
            symbol: setup.symbol,
            message: `❌ SETUP CANCELLED — ${cancelMessage}`,
            urgency: "MEDIUM",
            action: "Do not trade ${setup.symbol} today. Run new analysis tomorrow."
          });
          
          if (setup.email) {
            await sendAlertEmail(setup.email, `❌ Setup Cancelled — ${setup.symbol}`,
              `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px;">
                <h2 style="color:#ff3b5c">❌ SETUP CANCELLED — ${setup.symbol}</h2>
                <p>${cancelMessage}</p>
                <p style="color:#4a6b85;margin-top:12px">The market conditions changed. Do not force this trade. Run a fresh analysis tomorrow.</p>
              </div>`
            ).catch(()=>{});
          }
        }
        
        await new Promise(r=>setTimeout(r,500));
      } catch(e) { continue; }
    }
    
    // Save updated pending setups
    const allSetups = loadPendingSetups();
    const updatedSetups = allSetups.map(s => {
      const updated = pendingSetups.find(p => p.id === s.id);
      return updated || s;
    });
    savePendingSetups(updatedSetups);

    // Store latest alerts for frontend polling
    if (alerts.length > 0) {
      const alertFile = path.join(__dirname, "latest_alerts.json");
      fs.writeFileSync(alertFile, JSON.stringify({ alerts, timestamp: new Date().toISOString() }, null, 2));
    }
    
  } catch(e) { console.error("[Scanner] Error:", e.message); }
}

// Get latest alerts for frontend
app.get("/api/alerts/latest", (req, res) => {
  try {
    const alertFile = path.join(__dirname, "latest_alerts.json");
    if (fs.existsSync(alertFile)) {
      const data = JSON.parse(fs.readFileSync(alertFile, "utf8"));
      // Only return alerts from last 30 minutes
      const thirtyMinAgo = new Date(Date.now() - 30*60*1000);
      if (new Date(data.timestamp) > thirtyMinAgo) {
        return res.json({ success:true, ...data });
      }
    }
    res.json({ success:true, alerts:[], timestamp: new Date().toISOString() });
  } catch(e) { res.json({ success:true, alerts:[] }); }
});

// Start background scanner — runs every 90 seconds during market hours
const SCAN_INTERVAL = 90 * 1000; // 90 seconds
setInterval(detectCatalysts, SCAN_INTERVAL);
console.log("[Scanner] Background scanner started — checking every 90 seconds during market hours");

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Challenge AI v3 on port ${PORT}`));
