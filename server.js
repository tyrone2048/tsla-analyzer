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
    riskLevel: "MEDIUM",
    holdTime: "30min - 2hrs",
    winRateTarget: 45,
    rrRatio: "1:1.5",
    indicators: ["RSI","MACD","Volume","OBV"],
    educationLevel: 1
  },
  BREAKOUT: {
    name: "Breakout Trading",
    description: "Buy when price breaks above resistance with high volume. Targets 50-200% gains.",
    bestConditions: "Price near resistance, high volume breakout, bullish market",
    riskLevel: "MEDIUM-HIGH",
    holdTime: "1-4hrs",
    winRateTarget: 40,
    rrRatio: "1:2",
    indicators: ["Resistance levels","Volume","Bollinger Bands","ATR"],
    educationLevel: 2
  },
  OVERSOLD_BOUNCE: {
    name: "Oversold Bounce",
    description: "Buy stocks that have crashed and are bouncing back. Lower risk, steady gains.",
    bestConditions: "RSI below 30, Williams %R below -80, stock down 10%+ recently",
    riskLevel: "MEDIUM",
    holdTime: "1-3hrs",
    winRateTarget: 55,
    rrRatio: "1:1.5",
    indicators: ["RSI","Williams %R","Stochastic","Support levels"],
    educationLevel: 1
  },
  EARNINGS_PLAY: {
    name: "Earnings Play",
    description: "Trade around company earnings announcements for explosive moves.",
    bestConditions: "Earnings in 1-3 days, high IV, strong analyst expectations",
    riskLevel: "HIGH",
    holdTime: "Same day as earnings",
    winRateTarget: 35,
    rrRatio: "1:3",
    indicators: ["IV","Earnings date","Historical earnings moves","Options volume"],
    educationLevel: 3
  },
  GAP_FILL: {
    name: "Gap Fill",
    description: "When a stock gaps up or down at open, it often fills back to previous close.",
    bestConditions: "Large gap at open (3%+), low overall market movement",
    riskLevel: "MEDIUM",
    holdTime: "1-2hrs after open",
    winRateTarget: 50,
    rrRatio: "1:1.5",
    indicators: ["Opening gap","Volume","Previous close","Support/Resistance"],
    educationLevel: 2
  },
  TREND_FOLLOWING: {
    name: "Trend Following",
    description: "Follow the dominant market trend. Buy dips in uptrends, sell rallies in downtrends.",
    bestConditions: "Clear market direction, price above/below all EMAs, consistent volume",
    riskLevel: "LOW-MEDIUM",
    holdTime: "2-6hrs",
    winRateTarget: 50,
    rrRatio: "1:2",
    indicators: ["EMA 20/50/200","MACD","Market trend (SPY)","OBV"],
    educationLevel: 2
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

// ─── Market Regime Detection ──────────────────────────────────────────────────
function detectMarketRegime(spyChange, spyVolume, vixLevel) {
  if (Math.abs(spyChange) > 2) return spyChange > 0 ? "STRONG_BULL" : "STRONG_BEAR";
  if (Math.abs(spyChange) > 0.75) return spyChange > 0 ? "BULL" : "BEAR";
  return "CHOPPY";
}

// ─── Adaptive Strategy Selection ─────────────────────────────────────────────
function selectBestStrategy(data, strategyMemory, marketRegime, spyChange) {
  const sm = strategyMemory;
  const perf = sm.strategyPerformance || {};
  const trades = data.trades || [];
  const edLevel = getEducationLevel(data, sm);

  // Filter strategies by education level
  const availableStrategies = Object.entries(STRATEGIES)
    .filter(([,s]) => s.educationLevel <= edLevel)
    .map(([key, s]) => {
      const p = perf[key] || { wins:0, losses:0, totalPnl:0 };
      const winRate = (p.wins+p.losses) > 0 ? p.wins/(p.wins+p.losses) : 0.5;
      let score = winRate * 60;

      // Bonus for strategy matching market regime
      if (marketRegime.includes("BULL") && ["MOMENTUM_SCALP","BREAKOUT","TREND_FOLLOWING"].includes(key)) score += 20;
      if (marketRegime.includes("BEAR") && key === "OVERSOLD_BOUNCE") score += 15;
      if (marketRegime === "CHOPPY" && key === "GAP_FILL") score += 15;
      if (Math.abs(spyChange) > 1.5 && key === "MOMENTUM_SCALP") score += 10;

      // Penalize strategies with poor recent performance
      const recentTrades = trades.slice(0,10).filter(t => t.strategy === key);
      const recentWins = recentTrades.filter(t => t.result === "win").length;
      if (recentTrades.length >= 3 && recentWins/recentTrades.length < 0.3) score -= 20;

      return { key, ...s, score: Math.round(score), performance: p };
    })
    .sort((a,b) => b.score - a.score);

  return availableStrategies[0] || { key:"MOMENTUM_SCALP", ...STRATEGIES.MOMENTUM_SCALP };
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
async function getIntradayContext(symbol) {
  try {
    // Fetch 2-minute intraday data for more granular analysis
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

    return {
      openPrice,
      prevClose,
      gapPct,
      gapType,
      openingRangeHigh: orHigh ? parseFloat(orHigh.toFixed(2)) : null,
      openingRangeLow:  orLow  ? parseFloat(orLow.toFixed(2))  : null,
      orbSignal,
      morningTrend,
      vwap,
      aboveVWAP,
      morningVolume: morningVol,
      totalVolumeSoFar: totalVol,
      gapDescription: gapType === "GAP_UP"
        ? `Gapped UP ${gapPct}% from yesterday — strong opening momentum`
        : gapType === "GAP_DOWN"
        ? `Gapped DOWN ${Math.abs(gapPct)}% from yesterday — weak opening`
        : `Opened flat near yesterday's close — no directional bias at open`,
      orbDescription: orbSignal === "BULLISH_BREAKOUT"
        ? `Price BROKE ABOVE the opening range high ($${orHigh?.toFixed(2)}) — bullish momentum confirmed`
        : orbSignal === "BEARISH_BREAKDOWN"
        ? `Price BROKE BELOW the opening range low ($${orLow?.toFixed(2)}) — bearish momentum confirmed`
        : `Price still INSIDE the opening range ($${orLow?.toFixed(2)} - $${orHigh?.toFixed(2)}) — wait for breakout`,
      vwapDescription: vwap
        ? `VWAP at $${vwap} — price is ${aboveVWAP ? "ABOVE (bullish)" : "BELOW (bearish)"} the day's average price`
        : "VWAP unavailable",
    };
  } catch(e) {
    console.error("Intraday context error:", symbol, e.message);
    return null;
  }
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

    const [spyR,qqqR,fgR,trendR,...stockR] = await Promise.allSettled([
      fetchMarketData("SPY"), fetchMarketData("QQQ"),
      getFearGreedIndex(), getTrendingTickers(),
      ...batch.map(s=>fetchMarketData(s))
    ]);

    const spyChange = spyR.status==="fulfilled"?spyR.value.priceData.change:0;
    const qqqChange = qqqR.status==="fulfilled"?qqqR.value.priceData.change:0;
    const fearGreed = fgR.status==="fulfilled"?fgR.value:{score:50,rating:"Neutral"};
    const trending  = trendR.status==="fulfilled"?trendR.value:[];
    const marketRegime = detectMarketRegime(spyChange, 0, 0);
    const marketTrend = spyChange<-2?"STRONGLY BEARISH":spyChange<-0.75?"BEARISH":spyChange>2?"STRONGLY BULLISH":spyChange>0.75?"BULLISH":"NEUTRAL";
    const preferredDir = spyChange<-1.5?"PUT":spyChange>1.5?"CALL":"EITHER";

    const marketDataMap={};
    for(let i=0;i<batch.length;i++){if(stockR[i].status==="fulfilled")marketDataMap[batch[i]]=stockR[i].value;}

    const topSymbols=Object.keys(marketDataMap).slice(0,5);
    const economicEvents = getTodayEconomicEvents();
    const [newsR,unusualR,earningsR,intradayR]=await Promise.allSettled([
      Promise.all(topSymbols.map(s=>getStockNews(s).then(n=>({symbol:s,news:n})))),
      Promise.all(topSymbols.map(s=>getUnusualOptionsActivity(s).then(u=>({symbol:s,unusual:u})))),
      getUpcomingEarnings(topSymbols),
      Promise.all(topSymbols.map(s=>getIntradayContext(s).then(intra=>({symbol:s,intraday:intra}))))
    ]);
    const newsMap={};
    if(newsR.status==="fulfilled")newsR.value.forEach(n=>{newsMap[n.symbol]=n.news;});
    const unusualMap={};
    if(unusualR.status==="fulfilled")unusualR.value.forEach(u=>{unusualMap[u.symbol]=u.unusual;});
    const earningsMap=earningsR.status==="fulfilled"?earningsR.value:{};
    const intradayMap={};
    if(intradayR.status==="fulfilled")intradayR.value.forEach(i=>{intradayMap[i.symbol]=i.intraday;});

    // Best strategy for today
    const bestStrategy = selectBestStrategy(data, strategyMemory, marketRegime, spyChange);
    const shouldAdapt = shouldAdaptStrategy(data, strategyMemory);
    const perfAnalysis = analyzePerformance(data, strategyMemory);

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
      intraday:intradayMap[sym]?{
        gapPct:intradayMap[sym].gapPct,
        gapType:intradayMap[sym].gapType,
        orbSignal:intradayMap[sym].orbSignal,
        morningTrend:intradayMap[sym].morningTrend,
        aboveVWAP:intradayMap[sym].aboveVWAP,
        vwap:intradayMap[sym].vwap,
        openingRangeHigh:intradayMap[sym].openingRangeHigh,
        openingRangeLow:intradayMap[sym].openingRangeLow,
      }:null
    }));

    const topScore=Math.max(...summaries.map(s=>{let sc=50;if(s.macdBullish)sc+=8;if(s.aboveEMA50)sc+=5;if(s.obvTrend==="RISING")sc+=8;if(s.unusualActivity?.bigMoney==="BULLISH")sc+=12;if(s.isTrending)sc+=5;return sc;}),0);
    const numTrades=getTradeCount(data.balance,marketTrend,topScore);

    const prompt=`You are an elite adaptive options trading AI. You have LIVE data fetched at ${new Date().toLocaleTimeString()} ET.

USER PROFILE:
- Balance: $${data.balance} | Goal: $10,000
- Total Trades: ${data.trades.length} | Win Rate: ${data.trades.length>0?Math.round((data.trades.filter(t=>t.result==="win").length/data.trades.length)*100):0}%
- Education Level: ${edLevel}/4 (${edLevel===1?"Beginner":edLevel===2?"Intermediate":edLevel===3?"Advanced":"Expert"})
- Current Strategy: ${bestStrategy.name}
- Should Adapt Strategy: ${shouldAdapt}
- Consecutive Wins: ${data.consecutiveWins||0} | Consecutive Losses: ${data.consecutiveLosses||0}

MARKET CONDITIONS:
- SPY: ${spyChange}% | QQQ: ${qqqChange}% | Regime: ${marketRegime}
- Fear & Greed: ${fearGreed.score}/100 — ${fearGreed.rating}
- Preferred Direction: ${preferredDir}

ACTIVE STRATEGY: ${bestStrategy.name}
Strategy Description: ${bestStrategy.description}
Best Conditions: ${bestStrategy.bestConditions}
Risk Level: ${bestStrategy.riskLevel}
Target Hold Time: ${bestStrategy.holdTime}

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
    "marketComment":"2 plain English sentences about today's market"
  },
  "activeStrategy":{
    "name":"${bestStrategy.name}","key":"${bestStrategy.key}",
    "description":"${bestStrategy.description}",
    "whyToday":"1-2 sentences why this strategy fits today's conditions",
    "shouldAdapt":${shouldAdapt},
    "adaptationAdvice":"${shouldAdapt?"Specific advice on whether to switch strategies and what to switch to":"No adaptation needed"}",
    "strategyEducation":"Plain English explanation of this strategy for education level ${edLevel}"
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
      "strategyFit":"How this specific stock fits the ${bestStrategy.name} strategy today",
      "signal":"BUY" or "SELL" or "HOLD",
      "confidence":"LOW" or "MEDIUM" or "HIGH",
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
        "robinhoodSteps":"10 numbered steps split into HOW TO OPEN and HOW TO CLOSE the trade. OPENING THE TRADE: Step 1: Open Robinhood and search [SYMBOL]. Step 2: Tap Trade then tap Trade Options. Step 3: You will see 4 buttons at the top — tap BUY (left side, should be orange) and tap CALL (right side, should be orange) — do NOT tap Sell or Put. Step 4: Select expiration date [exact date]. Step 5: IMPORTANT — check the actual Ask Price column. If the recommended strike $[X] costs more than your budget scroll UP to find a higher strike with a cheaper Ask Price. Ask Price times 100 equals total cost. Step 6: Tap the green + button next to your chosen strike. Step 7: Set quantity to 1 contract, change to Limit order, set limit price to the Ask price, tap Review then Submit. Step 8: If it shows Queued that is normal — wait for it to fill, do not cancel unless price moves far away. CLOSING THE TRADE (how to sell and take profit or cut loss): Step 9: To close go to your Portfolio — tap the graph icon at the bottom of Robinhood — find your [SYMBOL] position and tap it — tap Sell to Close — set quantity to 1 — change to Limit order — set limit price to the current Bid price — tap Review then Submit. Step 10: Your trade is closed when it shows Filled. Then come back to this app and log the result."
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

    const ai = await anthropic.messages.create({ model:"claude-opus-4-5", max_tokens:5000, messages:[{role:"user",content:prompt}] });
    const raw = ai.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI parse failed");
    const analysis = JSON.parse(match[0]);

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
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Challenge AI v3 on port ${PORT}`));
