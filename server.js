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

process.on("uncaughtException", (err) => { console.error("[CRASH PREVENTED]", err.message); });
process.on("unhandledRejection", (reason) => { console.error("[REJECTION]", reason?.message || reason); });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Files ────────────────────────────────────────────────────────────────────
const DATA_FILE    = path.join(__dirname, "challenge_data.json");
const LEARN_FILE   = path.join(__dirname, "smc_learning.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = { balance:10, startingBalance:10, trades:[], milestones:[] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch(e) { return { balance:10, startingBalance:10, trades:[], milestones:[] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }

function loadLearning() {
  if (!fs.existsSync(LEARN_FILE)) {
    const d = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      setupData: [],       // Every SMC setup ever traded
      bestStocks: {},      // Win rate per stock
      bestTimes: {},       // Win rate per hour
      bestGapSizes: [],    // What gap % worked
      bestConditions: [],  // What market conditions worked
      insights: []         // Auto-generated insights
    };
    fs.writeFileSync(LEARN_FILE, JSON.stringify(d,null,2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(LEARN_FILE,"utf8")); }
  catch(e) { return { totalTrades:0, wins:0, losses:0, setupData:[], bestStocks:{}, bestTimes:{}, bestGapSizes:[], bestConditions:[], insights:[] }; }
}
function saveLearning(d) { fs.writeFileSync(LEARN_FILE, JSON.stringify(d,null,2)); }

const MILESTONES = [25,50,100,250,500,1000,2500,5000,10000];
function checkMilestone(old, nw, existing) {
  for (const m of MILESTONES) { if(old<m&&nw>=m&&!(existing||[]).includes(m)) return m; }
  return null;
}

// ─── Watchlist ────────────────────────────────────────────────────────────────
const WATCHLIST = ["SOUN","SOFI","MARA","RIOT","PLTR","HOOD","AAL","NIO","XPEV","PLUG","BBAI","SAVE","CLSK","VALE","SPCE"];

// ─── Email ────────────────────────────────────────────────────────────────────
const activeMonitors = {};
async function sendEmail(to, subject, html) {
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASSWORD) return false;
  try {
    const t = nodemailer.createTransport({ service:"gmail", auth:{ user:process.env.ALERT_EMAIL, pass:process.env.ALERT_EMAIL_PASSWORD }});
    await t.sendMail({ from:process.env.ALERT_EMAIL, to, subject, html });
    return true;
  } catch(e) { console.error("Email:", e.message); return false; }
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcRSI(c, p=14) {
  if (!c || c.length < p+1) return null;
  let g=0, l=0;
  for (let i=1; i<=p; i++) { const d=c[i]-c[i-1]; if(d>=0) g+=d; else l+=Math.abs(d); }
  let ag=g/p, al=l/p;
  for (let i=p+1; i<c.length; i++) {
    const d=c[i]-c[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p;
    al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
  }
  return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2));
}

function calcATR(h, l, c, p=14) {
  if (!h || h.length < p+1) return null;
  const t=[];
  for (let i=1; i<h.length; i++) t.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return parseFloat((t.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(4));
}

// ─── SMC Core Detection ───────────────────────────────────────────────────────
// THE STRATEGY: FVG + Liquidity + BOS + Green candle confirmation
function detectSMCSetup(closes, highs, lows, opens, volumes) {
  if (!closes || closes.length < 15) return { step:0, fvg:null, liquidity:null, bos:null, entrySignal:null, plain:"Not enough candle data yet.", direction:"CALL" };

  const result = {
    step: 0,           // 1=FVG found, 2=Liquidity identified, 3=BOS confirmed, 4=Price in FVG, 5=ENTER NOW
    fvg: null,         // The fair value gap
    liquidity: null,   // Liquidity levels
    bos: null,         // Break of structure level
    entrySignal: null, // ENTER_NOW or WAIT
    plain: "",         // Plain English explanation
    direction: "CALL"
  };

  // STEP 1 — Find Fair Value Gaps
  // Three candles where wick of candle 1 and wick of candle 3 do NOT overlap
  const fvgs = [];
  for (let i=2; i<closes.length; i++) {
    const c1High = highs[i-2];
    const c1Low  = lows[i-2];
    const c3High = highs[i];
    const c3Low  = lows[i];

    // Bullish FVG: candle 3 low is ABOVE candle 1 high — gap between them
    if (c3Low > c1High) {
      const gapPct = parseFloat(((c3Low - c1High) / c1High * 100).toFixed(2));
      if (gapPct >= 0.2) { // Only meaningful gaps
        fvgs.push({
          type: "BULLISH",
          top: parseFloat(c3Low.toFixed(3)),
          bottom: parseFloat(c1High.toFixed(3)),
          gapPct,
          candleIdx: i
        });
      }
    }

    // Bearish FVG: candle 3 high is BELOW candle 1 low
    if (c3High < c1Low) {
      const gapPct = parseFloat(((c1Low - c3High) / c1Low * 100).toFixed(2));
      if (gapPct >= 0.2) {
        fvgs.push({
          type: "BEARISH",
          top: parseFloat(c1Low.toFixed(3)),
          bottom: parseFloat(c3High.toFixed(3)),
          gapPct,
          candleIdx: i
        });
      }
    }
  }

  if (fvgs.length === 0) {
    result.plain = "No Fair Value Gap detected yet. Waiting for a fast candle move that leaves a gap.";
    return result;
  }

  result.step = 1;
  const latestFVG = fvgs[fvgs.length - 1];
  result.fvg = latestFVG;

  // STEP 2 — Find Liquidity (swing highs/lows where stop losses cluster)
  const swingHighs = [], swingLows = [];
  for (let i=2; i<highs.length-2; i++) {
    if (highs[i]>highs[i-1]&&highs[i]>highs[i-2]&&highs[i]>highs[i+1]&&highs[i]>highs[i+2])
      swingHighs.push({ price: highs[i], idx: i });
    if (lows[i]<lows[i-1]&&lows[i]<lows[i-2]&&lows[i]<lows[i+1]&&lows[i]<lows[i+2])
      swingLows.push({ price: lows[i], idx: i });
  }

  const currentPrice = closes[closes.length - 1];

  if (swingHighs.length > 0 || swingLows.length > 0) {
    result.step = 2;
    result.liquidity = {
      buySide: swingHighs.slice(-3).map(h => parseFloat(h.price.toFixed(3))),
      sellSide: swingLows.slice(-3).map(l => parseFloat(l.price.toFixed(3)))
    };
  }

  // STEP 3 — Break of Structure
  // Bullish BOS: current price breaks above previous swing high
  let bos = null;
  if (swingHighs.length >= 1) {
    const lastHigh = swingHighs[swingHighs.length - 1].price;
    if (currentPrice > lastHigh) {
      bos = { type:"BULLISH", level: parseFloat(lastHigh.toFixed(3)) };
    }
  }
  if (!bos && swingLows.length >= 1) {
    const lastLow = swingLows[swingLows.length - 1].price;
    if (currentPrice < lastLow) {
      bos = { type:"BEARISH", level: parseFloat(lastLow.toFixed(3)) };
    }
  }

  if (!bos) {
    result.plain = `FVG found at $${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}. Liquidity at $${swingHighs.slice(-1)[0]?.price.toFixed(2)||"?"}. Waiting for price to BREAK the previous high to confirm direction.`;
    return result;
  }

  result.step = 3;
  result.bos = bos;
  result.direction = bos.type === "BULLISH" ? "CALL" : "PUT";

  // STEP 4 — Is price pulling back into the FVG zone?
  const inFVG = currentPrice >= latestFVG.bottom && currentPrice <= latestFVG.top;
  const approachingFVG = bos.type === "BULLISH" ?
    currentPrice > latestFVG.bottom && currentPrice < latestFVG.top * 1.02 :
    currentPrice < latestFVG.top && currentPrice > latestFVG.bottom * 0.98;

  if (!inFVG && !approachingFVG) {
    result.plain = `BOS confirmed ${bos.type} at $${bos.level.toFixed(2)}. FVG zone is $${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}. Waiting for price to PULL BACK into this zone.`;
    return result;
  }

  result.step = 4;

  // STEP 5 — Green (or red) confirmation candle inside FVG
  const lastOpen  = opens ? opens[opens.length-1] : currentPrice;
  const lastClose = closes[closes.length-1];
  const isGreen = lastClose > lastOpen;
  const isRed   = lastClose < lastOpen;

  const confirmed = (bos.type==="BULLISH" && isGreen) || (bos.type==="BEARISH" && isRed);

  if (confirmed) {
    result.step = 5;
    result.entrySignal = "ENTER_NOW";
    result.plain = `🟢 ENTER NOW: ${bos.type==="BULLISH"?"Green":"Red"} candle formed inside FVG ($${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}) after BOS at $${bos.level.toFixed(2)}. This is your exact entry signal.`;
  } else {
    result.entrySignal = "WAIT_CANDLE";
    result.plain = `Price is inside FVG zone ($${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}). WAIT for a ${bos.type==="BULLISH"?"GREEN":"RED"} candle to form here — that is your entry signal.`;
  }

  return result;
}

// ─── Fetch 5-minute candles ───────────────────────────────────────────────────
async function get5MinCandles(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=5d`, { headers:{"User-Agent":"Mozilla/5.0"} });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];
    const bars = timestamps.map((t,i) => ({
      time: new Date(t*1000),
      open:  q.open?.[i],
      high:  q.high?.[i],
      low:   q.low?.[i],
      close: q.close?.[i],
      volume:q.volume?.[i] || 0
    })).filter(b => b.close !== null && b.close !== undefined && b.open !== null);

    if (bars.length < 15) return null;

    // Only use today's bars for intraday analysis
    const today = new Date().toDateString();
    const todayBars = bars.filter(b => b.time.toDateString() === today);
    const useBars = todayBars.length >= 10 ? todayBars : bars.slice(-50);

    return {
      bars: useBars,
      closes:  useBars.map(b => b.close),
      opens:   useBars.map(b => b.open),
      highs:   useBars.map(b => b.high),
      lows:    useBars.map(b => b.low),
      volumes: useBars.map(b => b.volume),
      currentPrice: useBars[useBars.length-1].close
    };
  } catch(e) { return null; }
}

// ─── Fetch daily data for exhaustion check ────────────────────────────────────
async function getDailyData(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=60d`, { headers:{"User-Agent":"Mozilla/5.0"} });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const q = result.indicators?.quote?.[0] || {};
    const closes = (q.close||[]).filter(Boolean);
    const highs  = (q.high||[]).filter(Boolean);
    const lows   = (q.low||[]).filter(Boolean);
    const price  = parseFloat((meta.regularMarketPrice||0).toFixed(2));
    const prev   = parseFloat((meta.chartPreviousClose||price).toFixed(2));
    const change = parseFloat(((price-prev)/prev*100).toFixed(2));
    const atr    = calcATR(highs, lows, closes) || price * 0.02;
    const avgMove = parseFloat((atr/price*100).toFixed(2));
    const moveRatio = avgMove > 0 ? parseFloat((Math.abs(change)/avgMove).toFixed(1)) : 0;
    const exhaustion = moveRatio>=5?"EXTREMELY_EXHAUSTED":moveRatio>=3?"VERY_EXHAUSTED":moveRatio>=2?"EXHAUSTED":moveRatio>=1.5?"EXTENDED":"FRESH";

    // Options chain for real Ask prices
    let options = [];
    try {
      const or = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`, { headers:{"User-Agent":"Mozilla/5.0"} });
      if (or.ok) {
        const od = await or.json();
        const calls = od.optionChain?.result?.[0]?.options?.[0]?.calls || [];
        options = calls
          .filter(c => c.ask > 0 && c.openInterest >= 50)
          .map(c => ({
            strike: c.strike,
            ask: parseFloat((c.ask||0).toFixed(2)),
            bid: parseFloat((c.bid||0).toFixed(2)),
            spread: parseFloat(((c.ask||0)-(c.bid||0)).toFixed(3)),
            spreadPct: c.ask > 0 ? parseFloat(((c.ask-c.bid)/c.ask*100).toFixed(1)) : 100,
            openInterest: c.openInterest || 0,
            expiration: new Date((c.expiration||0)*1000).toLocaleDateString(),
            totalCost: parseFloat(((c.ask||0)*100).toFixed(2))
          }))
          .sort((a,b) => a.strike - b.strike);
      }
    } catch(e) {}

    // News
    let news = { label:"NEUTRAL", headlines:[] };
    try {
      const nr = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5&enableFuzzyQuery=false`, { headers:{"User-Agent":"Mozilla/5.0"} });
      const nd = await nr.json();
      const articles = (nd.news||[]).filter(n => Date.now()-n.providerPublishTime*1000 < 24*60*60*1000);
      const bw=["surge","jump","gain","rise","rally","buy","upgrade","beat","profit","strong","positive","boost"];
      const mw=["drop","fall","loss","down","sell","downgrade","miss","decline","weak","negative","cut"];
      let bu=0, be=0;
      articles.forEach(n => { const t=(n.title||"").toLowerCase(); bw.forEach(w=>{if(t.includes(w))bu++;}); mw.forEach(w=>{if(t.includes(w))be++;}); });
      const tot = bu+be;
      const sc = tot > 0 ? Math.round(bu/tot*100) : 50;
      news = { label: sc>60?"BULLISH":sc<40?"BEARISH":"NEUTRAL", headlines: articles.slice(0,2).map(n=>n.title) };
    } catch(e) {}

    return { symbol, price, change, exhaustion, moveRatio, atr, rsi: calcRSI(closes), options, news };
  } catch(e) { return null; }
}

// ─── Market check ─────────────────────────────────────────────────────────────
async function getMarketStatus() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d", { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    const spyChange = parseFloat(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2));
    const isExtreme = Math.abs(spyChange) > 3;
    const isBull = spyChange > 0.5;
    return { spyChange, isExtreme, isBull };
  } catch(e) { return { spyChange:0, isExtreme:false, isBull:true }; }
}

// ─── Time window ──────────────────────────────────────────────────────────────
function getTradingWindow() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  const h = et.getHours(), m = et.getMinutes(), t = h + m/60, day = et.getDay();
  if (day===0||day===6) return { canTrade:false, window:"WEEKEND", msg:"Market closed. Come back Monday." };
  if (t < 9.5)  return { canTrade:false, window:"PRE_MARKET",  msg:"Market opens at 9:30 AM ET. Come back then." };
  if (t < 10.0) return { canTrade:false, window:"TOO_EARLY",   msg:"Wait until 10:00 AM. First 30 minutes are too volatile." };
  if (t < 11.5) return { canTrade:true,  window:"BEST_WINDOW", msg:"Best window — 10:00 to 11:30 AM ET." };
  if (t < 12.0) return { canTrade:true,  window:"GOOD",        msg:"Still good. Fresh setups only." };
  if (t < 13.0) return { canTrade:false, window:"LUNCH",       msg:"Lunch dead zone. Volume dries up. Wait until 1 PM." };
  if (t < 15.5) return { canTrade:true,  window:"AFTERNOON",   msg:"Afternoon window. High confidence setups only." };
  return { canTrade:false, window:"CLOSED", msg:"3:30 PM ET — no new trades. Market closes soon." };
}

// ─── Learning System ──────────────────────────────────────────────────────────
function updateLearning(tradeData) {
  const learn = loadLearning();
  const { symbol, result, pnl, hour, gapPct, spyChange, exhaustion, fvgSize } = tradeData;

  learn.totalTrades++;
  if (result === "win") learn.wins++;
  else if (result === "loss") learn.losses++;

  // Record full setup
  learn.setupData.push({
    date: new Date().toISOString(),
    symbol, result, pnl, hour, gapPct, spyChange, exhaustion
  });

  // Update per-stock win rate
  if (!learn.bestStocks[symbol]) learn.bestStocks[symbol] = { wins:0, losses:0, trades:0 };
  learn.bestStocks[symbol].trades++;
  if (result==="win") learn.bestStocks[symbol].wins++;
  else if (result==="loss") learn.bestStocks[symbol].losses++;

  // Update per-hour win rate
  const hourKey = `${hour}:00`;
  if (!learn.bestTimes[hourKey]) learn.bestTimes[hourKey] = { wins:0, losses:0, trades:0 };
  learn.bestTimes[hourKey].trades++;
  if (result==="win") learn.bestTimes[hourKey].wins++;
  else if (result==="loss") learn.bestTimes[hourKey].losses++;

  // Track gap sizes that worked
  if (gapPct) learn.bestGapSizes.push({ gapPct, result });

  // Generate insights after enough trades
  const insights = [];
  if (learn.totalTrades >= 5) {
    const wr = Math.round(learn.wins / learn.totalTrades * 100);
    insights.push(`Overall win rate: ${wr}% across ${learn.totalTrades} SMC trades`);

    // Best stock
    const stocks = Object.entries(learn.bestStocks)
      .filter(([,v]) => v.trades >= 2)
      .map(([k,v]) => ({ symbol:k, wr: Math.round(v.wins/v.trades*100), trades:v.trades }))
      .sort((a,b) => b.wr - a.wr);
    if (stocks.length > 0) insights.push(`Best stock for SMC: ${stocks[0].symbol} (${stocks[0].wr}% win rate over ${stocks[0].trades} trades)`);

    // Best time
    const times = Object.entries(learn.bestTimes)
      .filter(([,v]) => v.trades >= 2)
      .map(([k,v]) => ({ hour:k, wr: Math.round(v.wins/v.trades*100), trades:v.trades }))
      .sort((a,b) => b.wr - a.wr);
    if (times.length > 0) insights.push(`Best time for SMC entry: ${times[0].hour} (${times[0].wr}% win rate)`);

    // Gap size insight
    const goodGaps = learn.bestGapSizes.filter(g => g.result==="win").map(g => g.gapPct);
    const badGaps  = learn.bestGapSizes.filter(g => g.result==="loss").map(g => g.gapPct);
    if (goodGaps.length >= 2) {
      const avgGood = parseFloat((goodGaps.reduce((a,b)=>a+b,0)/goodGaps.length).toFixed(2));
      insights.push(`Winning FVG gaps average ${avgGood}% — look for gaps this size or larger`);
    }
  }

  learn.insights = insights;
  saveLearning(learn);
  return insights;
}

// ─── Find best SMC opportunity ────────────────────────────────────────────────
async function findBestSMCSetup(market) {
  const learn = loadLearning();

  // Sort watchlist — prioritize stocks that have worked before
  const sortedWatchlist = [...WATCHLIST].sort((a, b) => {
    const aData = learn.bestStocks[a];
    const bData = learn.bestStocks[b];
    if (!aData && !bData) return 0;
    if (!aData) return 1;
    if (!bData) return -1;
    const aWR = aData.trades >= 2 ? aData.wins/aData.trades : 0.5;
    const bWR = bData.trades >= 2 ? bData.wins/bData.trades : 0.5;
    return bWR - aWR;
  });

  const results = [];

  // Fetch top 6 stocks in parallel
  const batch = sortedWatchlist.slice(0, 6);
  await Promise.allSettled(batch.map(async symbol => {
    try {
      const [candles, daily] = await Promise.allSettled([
        get5MinCandles(symbol),
        getDailyData(symbol)
      ]);

      const c = candles.status==="fulfilled" ? candles.value : null;
      const d = daily.status==="fulfilled" ? daily.value : null;

      if (!c || !d) return;

      // Skip exhausted stocks
      if (["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(d.exhaustion)) return;

      // Run SMC detection on 5-minute candles
      const smc = detectSMCSetup(c.closes, c.highs, c.lows, c.opens, c.volumes);

      // Score this setup
      let score = smc.step * 20; // Base score from SMC step (max 100)

      // Bonuses
      if (d.news.label === "BULLISH") score += 15;
      if (d.exhaustion === "FRESH") score += 10;
      if (market.isBull && smc.direction === "CALL") score += 10;
      if (market.isExtreme && d.change < market.spyChange * 0.3) score += 20; // Laggard bonus

      // Penalties
      if (d.news.label === "BEARISH" && smc.direction === "CALL") score -= 10;

      // Find best affordable option
      const bestOption = d.options.find(o =>
        o.strike > d.price &&
        o.ask <= 0.15 &&
        o.spreadPct <= 30 &&
        o.openInterest >= 50
      ) || d.options.find(o => o.strike > d.price && o.ask <= 0.30);

      results.push({
        symbol,
        score: Math.max(0, Math.min(100, score)),
        smc,
        daily: d,
        candles: c,
        bestOption,
        learnedWR: learn.bestStocks[symbol]?.trades >= 2
          ? Math.round(learn.bestStocks[symbol].wins / learn.bestStocks[symbol].trades * 100)
          : null
      });
    } catch(e) { console.error(`Error analyzing ${symbol}:`, e.message); }
  }));

  // Sort by score
  results.sort((a,b) => b.score - a.score);
  return results;
}

// ─── MAIN ANALYSIS ENDPOINT ───────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    const data = loadData();
    const learn = loadLearning();
    const tw = getTradingWindow();

    // Get market status
    const market = await getMarketStatus();

    // Find best SMC setups
    const setups = await findBestSMCSetup(market);
    const best = setups[0];

    // Build compact prompt for AI
    const learnInsights = learn.insights.length > 0
      ? learn.insights.join(". ")
      : "No trades yet — building your personal pattern library.";

    const prompt = `You are an SMC (Smart Money Concepts) trading AI. Respond ONLY with valid JSON.

THE STRATEGY: FVG + Liquidity + Break of Structure + Green candle confirmation
Step 1: Fair Value Gap found
Step 2: Liquidity levels identified  
Step 3: Break of Structure confirmed
Step 4: Price pulls back into FVG zone
Step 5: Green/Red confirmation candle = ENTER NOW

TODAY: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()} ET
SPY: ${market.spyChange}% ${market.isExtreme?"EXTREME DAY — laggards with own catalyst only":""}
Time: ${tw.window} — ${tw.msg}

BEST SETUP FOUND:
Stock: ${best?.symbol||"NONE"}
SMC Step: ${best?.smc?.step||0}/5 — ${best?.smc?.plain||"No setup found"}
Score: ${best?.score||0}/100
Price: $${best?.daily?.price||0} (${best?.daily?.change||0}% today)
Exhaustion: ${best?.daily?.exhaustion||"UNKNOWN"}
News: ${best?.daily?.news?.label||"NEUTRAL"}
Direction: ${best?.smc?.direction||"CALL"}
FVG Zone: ${best?.smc?.fvg?`$${best.smc.fvg.bottom.toFixed(2)}-$${best.smc.fvg.top.toFixed(2)}`:"None"}
BOS Level: ${best?.smc?.bos?`$${best.smc.bos.level.toFixed(2)} (${best.smc.bos.type})`:"Not confirmed yet"}
Best Option: ${best?.bestOption?`$${best.bestOption.strike} Call Ask $${best.bestOption.ask} ($${best.bestOption.totalCost} total) exp ${best.bestOption.expiration}`:"Check Robinhood"}

OTHER SETUPS:
${setups.slice(1,4).map(s=>`${s.symbol}: step ${s.smc?.step||0}/5 score ${s.score}`).join(", ")}

WHAT THE SYSTEM HAS LEARNED:
${learnInsights}

USER: $${data.balance} balance | max risk $${(data.balance*0.15).toFixed(2)} | ${data.trades.length} trades logged

RULES:
- Only recommend if SMC step >= 3
- If step 5 — ENTER NOW
- If step 4 — READY (watching for confirmation candle)  
- If step 1-3 — WAIT with specific next step
- Never recommend exhausted stocks
- Extreme days: laggard stocks with own catalyst only
- Keep response SHORT and CLEAR

Respond with this JSON:
{
  "shouldTrade": true or false,
  "marketStatus": "one sentence about today",
  "timeStatus": "${tw.msg}",
  "canTrade": ${tw.canTrade},
  "symbol": "${best?.symbol||"NONE"}",
  "step": ${best?.smc?.step||0},
  "stepPlain": "Which step of the 5-step SMC strategy are we on right now",
  "entrySignal": "ENTER NOW or WAIT — CANDLE CONFIRMATION or WAIT — PRICE NEEDS TO REACH FVG or WAIT — NEED BOS or WAIT — NO SETUP",
  "entryTrigger": "The exact thing that needs to happen to enter — 1 sentence",
  "fvgZone": "${best?.smc?.fvg?`$${best.smc.fvg.bottom.toFixed(2)}-$${best.smc.fvg.top.toFixed(2)}`:"Not found yet"}",
  "bosLevel": "${best?.smc?.bos?`$${best.smc.bos.level.toFixed(2)}`:"Not confirmed"}",
  "direction": "${best?.smc?.direction||"CALL"}",
  "smcExplanation": "Explain in plain English exactly what the 5-minute chart is showing right now for ${best?.symbol||"this stock"} — which step are we on and what needs to happen next",
  "strike": ${best?.bestOption?.strike||0},
  "expiration": "${best?.bestOption?.expiration||"5-10 days out"}",
  "askPrice": ${best?.bestOption?.ask||0},
  "totalCost": ${best?.bestOption?.totalCost||0},
  "stopLoss": ${best?.daily?.price?parseFloat((best.daily.price - (best.daily.atr||best.daily.price*0.02)).toFixed(2)):0},
  "target": ${best?.daily?.price?parseFloat((best.daily.price + (best.daily.atr||best.daily.price*0.02)*1.5).toFixed(2)):0},
  "news": "${best?.daily?.news?.label||"NEUTRAL"}",
  "newsHeadline": "${best?.daily?.news?.headlines?.[0]||""}",
  "exhaustion": "${best?.daily?.exhaustion||"UNKNOWN"}",
  "learnedInsight": "${learn.totalTrades >= 3 ? learnInsights.split(".")[0] : "Keep trading to unlock your personal insights"}",
  "otherStocks": ${JSON.stringify(setups.slice(1,4).map(s=>({symbol:s.symbol,step:s.smc?.step||0,score:s.score,plain:s.smc?.plain||""})))}
}`;

    const ai = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role:"user", content:prompt }]
    });

    const raw = ai.content[0]?.text || "";
    console.log("[Analysis] Response:", raw.length, "chars");

    let analysis;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON found");
      analysis = JSON.parse(match[0]);
    } catch(e) {
      console.error("[Parse error]", e.message, "Raw:", raw.substring(0,200));
      throw new Error("Analysis failed — please try again");
    }

    // Add computed data
    analysis._balance   = data.balance;
    analysis._trades    = data.trades.length;
    analysis._milestones = data.milestones || [];
    analysis._learning  = {
      totalTrades: learn.totalTrades,
      wins: learn.wins,
      losses: learn.losses,
      winRate: learn.totalTrades > 0 ? Math.round(learn.wins/learn.totalTrades*100) : 0,
      insights: learn.insights,
      bestStock: Object.entries(learn.bestStocks).sort((a,b) => {
        const aWR = a[1].trades>=2?a[1].wins/a[1].trades:0;
        const bWR = b[1].trades>=2?b[1].wins/b[1].trades:0;
        return bWR - aWR;
      })[0]?.[0] || null
    };
    analysis._currentPrice = best?.daily?.price || 0;
    analysis._allSetups = setups.slice(0,6).map(s => ({
      symbol: s.symbol,
      score: s.score,
      step: s.smc?.step || 0,
      plain: s.smc?.plain || "",
      learnedWR: s.learnedWR
    }));

    res.json({ success:true, data:analysis });

  } catch(err) {
    console.error("[Analysis Error]", err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ─── Standard Endpoints ───────────────────────────────────────────────────────
app.get("/api/challenge", (req,res) => { res.json({ success:true, data:loadData() }); });

app.post("/api/balance/update", (req,res) => {
  const { balance } = req.body;
  if (isNaN(balance) || balance < 0) return res.status(400).json({ success:false, error:"Invalid balance" });
  const data = loadData();
  const old = data.balance;
  data.balance = parseFloat(parseFloat(balance).toFixed(2));
  const m = checkMilestone(old, data.balance, data.milestones||[]);
  if (m) (data.milestones=data.milestones||[]).push(m);
  saveData(data);
  res.json({ success:true, balance:data.balance, milestone:m });
});

app.post("/api/reset", (req,res) => {
  const bal = parseFloat(req.body.startingBalance) || 10;
  saveData({ balance:bal, startingBalance:bal, trades:[], milestones:[], createdAt:new Date().toISOString() });
  res.json({ success:true, message:`Reset to $${bal}` });
});

app.post("/api/trade/log", (req,res) => {
  const { symbol, optionType, entryPrice, exitPrice, amount, result, notes, gapPct, spyChange, exhaustion } = req.body;
  const data = loadData();
  const pnl = result==="win" ? parseFloat((exitPrice-amount).toFixed(2)) : result==="skip" ? 0 : parseFloat((-amount).toFixed(2));
  const old = data.balance;
  if (result !== "skip") data.balance = parseFloat(Math.max(0, data.balance+pnl).toFixed(2));
  const m = checkMilestone(old, data.balance, data.milestones||[]);
  if (m) (data.milestones=data.milestones||[]).push(m);
  const trade = {
    id:Date.now(), date:new Date().toISOString(),
    symbol, optionType, entryPrice, exitPrice,
    amountRisked:amount, pnl, result,
    balanceAfter:data.balance, notes:notes||""
  };
  data.trades.unshift(trade);
  saveData(data);

  // Update learning system
  const hour = new Date().getHours();
  const insights = updateLearning({ symbol, result, pnl, hour, gapPct, spyChange, exhaustion });

  res.json({ success:true, trade, newBalance:data.balance, milestone:m, insights });
});

app.post("/api/trade/manual", (req,res) => {
  const { symbol, optionType, amount, exitValue, result, date, notes } = req.body;
  const data = loadData();
  const pnl = result==="win" ? parseFloat((exitValue-amount).toFixed(2)) : result==="loss" ? parseFloat((-amount).toFixed(2)) : 0;
  const trade = {
    id:Date.now(), date:date?new Date(date).toISOString():new Date().toISOString(),
    symbol, optionType, entryPrice:amount, exitPrice:exitValue,
    amountRisked:amount, pnl, result, balanceAfter:data.balance,
    notes:notes||"", manualEntry:true
  };
  data.trades.push(trade);
  saveData(data);
  res.json({ success:true, trade });
});

app.get("/api/learning", (req,res) => { res.json({ success:true, data:loadLearning() }); });

app.get("/api/export", (req,res) => {
  res.setHeader("Content-Disposition", "attachment; filename=smc-backup-"+new Date().toISOString().split("T")[0]+".json");
  res.json({ exportedAt:new Date().toISOString(), challenge:loadData(), learning:loadLearning() });
});

app.post("/api/import", (req,res) => {
  try {
    const { challenge, learning } = req.body;
    if (challenge) saveData(challenge);
    if (learning) saveLearning(learning);
    res.json({ success:true, message:"Data restored!" });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get("/api/price/:symbol", async (req,res) => {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${req.params.symbol}?interval=1m&range=1d`, { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const price = d.chart?.result?.[0]?.meta?.regularMarketPrice;
    res.json(price ? { success:true, price } : { success:false });
  } catch(e) { res.json({ success:false }); }
});

// Monitor
app.post("/api/monitor/start", async (req,res) => {
  const { email, symbol, stopLoss, profitTarget } = req.body;
  const id = `${symbol}_${Date.now()}`;
  activeMonitors[id] = { email, symbol, stopLoss, profitTarget, active:true };
  const interval = setInterval(async () => {
    if (!activeMonitors[id]?.active) { clearInterval(interval); return; }
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, { headers:{"User-Agent":"Mozilla/5.0"} });
      const d = await r.json();
      const cp = d.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (!cp) return;
      if (cp >= profitTarget || cp <= stopLoss) {
        clearInterval(interval);
        activeMonitors[id].active = false;
        const win = cp >= profitTarget;
        await sendEmail(email, win?"🟢 TAKE PROFIT!":"🔴 STOP LOSS!", `<div style="padding:20px;font-family:monospace"><h2>${win?"🟢 PROFIT HIT":"🔴 STOP HIT"} — ${symbol}</h2><p>Price: $${cp}. Open Robinhood NOW and ${win?"sell to lock profit!":"cut the loss!"}</p></div>`);
      }
    } catch(e) {}
  }, 180000);
  activeMonitors[id].intervalId = interval;
  await sendEmail(email, `👁 Watching ${symbol}`, `<div style="padding:20px"><h2>Monitoring ${symbol}</h2><p>Stop: $${stopLoss} | Target: $${profitTarget}</p><p>Checking every 3 minutes.</p></div>`);
  res.json({ success:true, monitorId:id });
});

app.post("/api/monitor/stop", (req,res) => {
  const { monitorId } = req.body;
  if (activeMonitors[monitorId]) { clearInterval(activeMonitors[monitorId].intervalId); activeMonitors[monitorId].active = false; }
  res.json({ success:true });
});

app.get("*", (req,res) => res.sendFile(path.join(__dirname, "public", "index.html")));


// ─── Paper Trading System ─────────────────────────────────────────────────────
// Runs automatically in background — practices the SMC strategy 24/7
const PAPER_FILE = path.join(__dirname, "paper_trades.json");

function loadPaperTrades() {
  if (!fs.existsSync(PAPER_FILE)) {
    const d = { balance:1000, trades:[], openPositions:[], totalTrades:0, wins:0, losses:0 };
    fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(PAPER_FILE,"utf8")); }
  catch(e) { return { balance:1000, trades:[], openPositions:[], totalTrades:0, wins:0, losses:0 }; }
}
function savePaperTrades(d) { fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2)); }

async function runPaperTrading() {
  try {
    const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const h = et.getHours(), m = et.getMinutes(), t = h+m/60, day = et.getDay();
    
    // Run during market hours 9:30am-4pm ET on weekdays
    if (day===0||day===6||t<9.5||t>16) return;
    console.log(`[Paper] Running scan at ${et.toLocaleTimeString()} ET`);

    const paper = loadPaperTrades();
    const learn = loadLearning();
    const market = await getMarketStatus().catch(()=>({spyChange:0,isExtreme:false,isBull:true}));

    // Step 1 — Check open positions for exits
    const stillOpen = [];
    for (const pos of (paper.openPositions||[])) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${pos.symbol}?interval=5m&range=1d`,{headers:{"User-Agent":"Mozilla/5.0"}});
        const d = await r.json();
        const cp = d.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!cp) { stillOpen.push(pos); continue; }

        const hitTarget = cp >= pos.target;
        const hitStop   = cp <= pos.stopLoss;
        const expired   = new Date() - new Date(pos.entryTime) > 4*60*60*1000; // 4 hour max hold

        if (hitTarget || hitStop || expired) {
          // Close the position
          const result = hitTarget ? "win" : "loss";
          const pnl = hitTarget
            ? parseFloat((pos.contracts * (pos.target - pos.entryPrice) * 100).toFixed(2))
            : parseFloat((-pos.amountRisked).toFixed(2));

          paper.totalTrades++;
          if (result==="win") paper.wins++;
          else paper.losses++;
          paper.balance = parseFloat((paper.balance + pnl).toFixed(2));

          const closedTrade = {
            id: pos.id,
            symbol: pos.symbol,
            entryPrice: pos.entryPrice,
            exitPrice: cp,
            entryTime: pos.entryTime,
            exitTime: new Date().toISOString(),
            result,
            pnl,
            amountRisked: pos.amountRisked,
            smcStep: pos.smcStep,
            fvgZone: pos.fvgZone,
            reason: hitTarget?"Target hit":hitStop?"Stop hit":"Time expired",
            spyChange: pos.spyChange,
            hour: new Date(pos.entryTime).getHours()
          };

          paper.trades.unshift(closedTrade);
          if (paper.trades.length > 200) paper.trades = paper.trades.slice(0,200);

          // Feed into learning system
          updateLearning({
            symbol: pos.symbol,
            result,
            pnl,
            hour: new Date(pos.entryTime).getHours(),
            gapPct: pos.gapPct || 0,
            spyChange: pos.spyChange || 0,
            exhaustion: pos.exhaustion || "UNKNOWN"
          });

          console.log(`[Paper] CLOSED ${pos.symbol} — ${result} $${pnl} (${closedTrade.reason})`);
        } else {
          stillOpen.push(pos);
        }
      } catch(e) { stillOpen.push(pos); }
    }
    paper.openPositions = stillOpen;

    // Step 2 — Look for new SMC ENTER NOW signals
    // Max 2 open positions at once
    if (paper.openPositions.length < 2) {
      const batch = WATCHLIST.slice(0,8);

      for (const symbol of batch) {
        // Skip if already in a position
        if (paper.openPositions.find(p=>p.symbol===symbol)) continue;

        try {
          const c = await get5MinCandles(symbol);
          if (!c) continue;

          const smc = detectSMCSetup(c.closes, c.highs, c.lows, c.opens, c.volumes);

          // Skip if SMC returned null
          if (!smc) { console.log(`[Paper] ${symbol} — no SMC data`); continue; }

          // Paper trade step 4+ setups
          if (smc.step < 4) { console.log(`[Paper] ${symbol} step ${smc.step}/5 — not ready`); continue; }
          // For step 4 — log as pending, step 5 — log as entered
          const isPending = smc.step === 4;
          console.log(`[Paper] ${symbol} ${isPending?"WATCHING (step 4)":"ENTERING (step 5)"}`);

          // Get daily data for exhaustion and ATR
          const daily = await getDailyData(symbol).catch(()=>null);
          if (!daily) continue;

          // Skip exhausted stocks
          if (["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(daily.exhaustion)) {
            console.log(`[Paper] ${symbol} skipped — ${daily.exhaustion}`);
            continue;
          }

          console.log(`[Paper] ${symbol} SMC step ${smc.step}/5 — ${smc.plain?.substring(0,60)}`);
          const currentPrice = c.currentPrice;
          const atr = daily.atr || currentPrice * 0.02;
          const stopLoss = parseFloat((currentPrice - atr).toFixed(2));
          const target = parseFloat((currentPrice + atr * 1.5).toFixed(2));
          const amountRisked = 50; // Paper trade $50 per position
          const contracts = Math.floor(amountRisked / (atr * 100)) || 1;

          const position = {
            id: Date.now(),
            symbol,
            entryPrice: currentPrice,
            stopLoss,
            target,
            amountRisked,
            contracts,
            entryTime: new Date().toISOString(),
            smcStep: smc.step,
            fvgZone: smc.fvg ? `${smc.fvg.bottom.toFixed(2)}-${smc.fvg.top.toFixed(2)}` : null,
            gapPct: smc.fvg?.gapPct || 0,
            spyChange: market.spyChange,
            exhaustion: daily.exhaustion,
            direction: smc.direction
          };

          paper.openPositions.push(position);
          console.log(`[Paper] ENTERED ${symbol} at $${currentPrice} — Stop $${stopLoss} Target $${target} (SMC step ${smc.step}/5)`);

          // Max 2 positions
          if (paper.openPositions.length >= 2) break;

        } catch(e) { console.error(`[Paper] Error scanning ${symbol}:`, e.message); }

        // Small delay between stocks
        await new Promise(r=>setTimeout(r,300));
      }

      if (paper.openPositions.length === 0) {
        console.log(`[Paper] No ENTER NOW signals found this scan — waiting for next scan`);
      }
    }

    savePaperTrades(paper);

    // Log summary every 10 trades
    if (paper.totalTrades > 0 && paper.totalTrades % 10 === 0) {
      const wr = Math.round(paper.wins/paper.totalTrades*100);
      console.log(`[Paper] Summary: ${paper.totalTrades} trades | ${wr}% win rate | Balance: $${paper.balance}`);
    }

  } catch(e) { console.error("[Paper Trading]", e.message); }
}

// Paper trading endpoint
app.get("/api/paper", (req,res) => {
  const paper = loadPaperTrades();
  const wr = paper.totalTrades > 0 ? Math.round(paper.wins/paper.totalTrades*100) : 0;
  res.json({
    success: true,
    data: {
      balance: paper.balance,
      startingBalance: 1000,
      totalTrades: paper.totalTrades,
      wins: paper.wins,
      losses: paper.losses,
      winRate: wr,
      openPositions: paper.openPositions || [],
      recentTrades: paper.trades.slice(0,20),
      pnl: parseFloat((paper.balance - 1000).toFixed(2))
    }
  });
});


// ─── Scanner ──────────────────────────────────────────────────────────────────
async function runScanner() {
  try {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
    const h = et.getHours(), day = et.getDay();
    if (day===0||day===6||h<9||h>=16) return;

    // Check for SMC entries on watchlist
    const market = await getMarketStatus().catch(() => ({ spyChange:0, isExtreme:false, isBull:true }));
    const alerts = [];

    // Quick BTC check for MARA/RIOT
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true", { headers:{"User-Agent":"Mozilla/5.0"} });
      const d = await r.json();
      const ch = parseFloat((d.bitcoin?.usd_24h_change||0).toFixed(2));
      if (Math.abs(ch) > 3) alerts.push({ type:"CRYPTO", symbol:ch>0?"MARA":"RIOT", message:`Bitcoin ${ch>0?"UP":"DOWN"} ${Math.abs(ch).toFixed(1)}% — ${ch>0?"MARA/RIOT calls likely":"avoid MARA/RIOT"}`, urgency:"HIGH" });
    } catch(e) {}

    // Check top 3 stocks for SMC ENTER NOW signals
    const quickBatch = ["SOUN","MARA","SOFI"];
    for (const sym of quickBatch) {
      try {
        const c = await get5MinCandles(sym);
        if (!c) continue;
        const smc = detectSMCSetup(c.closes, c.highs, c.lows, c.opens, c.volumes);
        if (smc.entrySignal === "ENTER_NOW") {
          alerts.push({ type:"SMC_ENTRY", symbol:sym, message:`🟢 SMC ENTER NOW — ${sym}: ${smc.plain}`, urgency:"HIGH" });
        }
      } catch(e) {}
    }

    if (alerts.length > 0) {
      fs.writeFileSync(path.join(__dirname, "latest_alerts.json"), JSON.stringify({ alerts, timestamp:new Date().toISOString() }, null, 2));
    }
  } catch(e) { console.error("[Scanner]", e.message); }
}

app.get("/api/alerts/latest", (req,res) => {
  const f = path.join(__dirname, "latest_alerts.json");
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f,"utf8"));
      if (new Date(d.timestamp) > new Date(Date.now()-30*60*1000)) return res.json({ success:true, ...d });
    }
  } catch(e) {}
  res.json({ success:true, alerts:[], timestamp:new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SMC Trading AI v5 on port ${PORT}`);
  setTimeout(() => {
    // Background scanner — checks for alerts
    setInterval(() => runScanner().catch(e => console.error("[Scanner]", e.message)), 90000);
    console.log("[Scanner] Started");
    
    // Paper trading — practices SMC strategy 24/7
    setInterval(() => runPaperTrading().catch(e => console.error("[Paper]", e.message)), 120000); // Every 2 minutes
    console.log("[Paper Trading] Started — practicing SMC strategy automatically");
  }, 15000);
});
