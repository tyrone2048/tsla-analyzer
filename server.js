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

// ─── Data persistence ─────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "challenge_data.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      balance: 10,
      startingBalance: 10,
      goal: 10000,
      trades: [],
      milestones: [],
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Watchlist of high-volatility options stocks ──────────────────────────────
const WATCHLIST = ["TSLA", "NVDA", "AAPL", "AMD", "META", "AMZN", "GOOGL", "MSFT", "SPY", "QQQ"];

// ─── Email alerts ─────────────────────────────────────────────────────────────
const activeMonitors = {};

async function sendAlertEmail(to, subject, html) {
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASSWORD) return false;
  try {
    const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.ALERT_EMAIL, pass: process.env.ALERT_EMAIL_PASSWORD } });
    await t.sendMail({ from: process.env.ALERT_EMAIL, to, subject, html });
    return true;
  } catch (e) { console.error("Email:", e.message); return false; }
}

// ─── Yahoo Finance helpers ────────────────────────────────────────────────────
async function getQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Quote error ${symbol}: ${r.status}`);
  return r.json();
}

async function getOptions(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  return r.json();
}

async function getCurrentPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const d = await r.json();
  return parseFloat(d.chart.result[0].meta.regularMarketPrice.toFixed(2));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcRSI(c, p=14) {
  if (c.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>=0)g+=d;else l+=Math.abs(d);}
  let ag=g/p,al=l/p;
  for (let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}
  return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2));
}
function calcEMA(c,p){
  if(c.length<p)return null;
  const k=2/(p+1);let e=c.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<c.length;i++)e=c[i]*k+e*(1-k);
  return parseFloat(e.toFixed(2));
}
function calcMACD(c){const e12=calcEMA(c,12),e26=calcEMA(c,26);if(!e12||!e26)return null;return{macdLine:parseFloat((e12-e26).toFixed(2)),bullish:e12>e26};}
function calcBoll(c,p=20){if(c.length<p)return null;const s=c.slice(-p),m=s.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(s.reduce((sum,v)=>sum+Math.pow(v-m,2),0)/p);return{upper:parseFloat((m+2*std).toFixed(2)),middle:parseFloat(m.toFixed(2)),lower:parseFloat((m-2*std).toFixed(2))};}
function calcATR(h,l,c,p=14){if(h.length<p+1)return null;const t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return parseFloat((t.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(2));}
function calcStoch(h,l,c,p=14){if(c.length<p)return null;const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)),cur=c[c.length-1];return hh===ll?50:parseFloat(((cur-ll)/(hh-ll)*100).toFixed(2));}
function calcWR(h,l,c,p=14){if(c.length<p)return null;const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)),cur=c[c.length-1];return hh===ll?-50:parseFloat(((hh-cur)/(hh-ll)*-100).toFixed(2));}
function calcOBV(c,v){let o=0;const vals=[0];for(let i=1;i<c.length;i++){if(c[i]>c[i-1])o+=v[i];else if(c[i]<c[i-1])o-=v[i];vals.push(o);}const r=vals.slice(-10);return{trend:r[r.length-1]>r[0]?"RISING":"FALLING"};}
function volAnalysis(v){const avg=v.slice(-20).reduce((a,b)=>a+b,0)/20,today=v[v.length-1],ratio=today/avg;return{today,avg20:Math.round(avg),ratio:parseFloat(ratio.toFixed(2)),trend:ratio>1.2?"HIGH":ratio<0.8?"LOW":"AVERAGE"};}
function findSR(h,l,c,price){const rh=h.slice(-60),rl=l.slice(-60);const sup=[],res=[];for(let i=2;i<rl.length-2;i++){if(rl[i]<rl[i-1]&&rl[i]<rl[i-2]&&rl[i]<rl[i+1]&&rl[i]<rl[i+2])sup.push(parseFloat(rl[i].toFixed(2)));if(rh[i]>rh[i-1]&&rh[i]>rh[i-2]&&rh[i]>rh[i+1]&&rh[i]>rh[i+2])res.push(parseFloat(rh[i].toFixed(2)));}return{supports:[...new Set(sup)].filter(s=>s<price).sort((a,b)=>b-a).slice(0,3),resistances:[...new Set(res)].filter(r=>r>price).sort((a,b)=>a-b).slice(0,3)};}

// ─── Fetch full market data for a symbol ─────────────────────────────────────
async function fetchMarketData(symbol) {
  const [qd, od] = await Promise.all([getQuote(symbol), getOptions(symbol).catch(()=>null)]);
  const chart = qd.chart.result[0];
  const meta = chart.meta;
  const q = chart.indicators.quote[0];
  const closes = q.close.filter(Boolean);
  const highs = q.high.filter(Boolean);
  const lows = q.low.filter(Boolean);
  const volumes = q.volume.filter(Boolean);
  const price = parseFloat(meta.regularMarketPrice.toFixed(2));
  const prev = parseFloat(meta.chartPreviousClose.toFixed(2));

  let iv=null, nearATM=[];
  if (od?.optionChain?.result?.[0]) {
    const calls = od.optionChain.result[0].options?.[0]?.calls||[];
    nearATM = calls.filter(c=>Math.abs(c.strike-price)<price*0.05).slice(0,3)
      .map(c=>({strike:c.strike,lastPrice:c.lastPrice,iv:c.impliedVolatility?parseFloat((c.impliedVolatility*100).toFixed(1)):null,exp:new Date(c.expiration*1000).toLocaleDateString()}));
    if (calls[0]?.impliedVolatility) iv=parseFloat((calls[0].impliedVolatility*100).toFixed(1));
  }

  const vol = volAnalysis(volumes);
  const sr = findSR(highs, lows, closes, price);
  return {
    symbol, price,
    priceData:{ current:price, prev, change:parseFloat(((price-prev)/prev*100).toFixed(2)), high52:parseFloat(meta.fiftyTwoWeekHigh.toFixed(2)), low52:parseFloat(meta.fiftyTwoWeekLow.toFixed(2)) },
    volume:vol,
    indicators:{ rsi:calcRSI(closes), macd:calcMACD(closes), ema20:calcEMA(closes,20), ema50:calcEMA(closes,50), ema200:calcEMA(closes,200), bollinger:calcBoll(closes), atr:calcATR(highs,lows,closes), stochastic:calcStoch(highs,lows,closes), williamsR:calcWR(highs,lows,closes), obv:calcOBV(closes,volumes) },
    levels:sr,
    options:{ iv, nearATM },
    volume20:Math.round(vol.avg20/1e6),
    volumeToday:Math.round(vol.today/1e6),
  };
}

// ─── Position sizing based on balance and confidence ─────────────────────────
function calcPositionSize(balance, confidence, accuracyScore) {
  let pct;
  if (confidence === "HIGH" && accuracyScore >= 70) pct = 0.10;
  else if (confidence === "HIGH") pct = 0.07;
  else if (confidence === "MEDIUM" && accuracyScore >= 60) pct = 0.05;
  else if (confidence === "MEDIUM") pct = 0.03;
  else pct = 0.02;

  const amount = Math.max(1, parseFloat((balance * pct).toFixed(2)));
  return { amount, percent: Math.round(pct * 100), remainingAfterTrade: parseFloat((balance - amount).toFixed(2)) };
}

// ─── Milestone check ──────────────────────────────────────────────────────────
const MILESTONES = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
function checkMilestone(oldBalance, newBalance, existingMilestones) {
  for (const m of MILESTONES) {
    if (oldBalance < m && newBalance >= m && !existingMilestones.includes(m)) {
      return m;
    }
  }
  return null;
}

// ─── MAIN ANALYSIS ENDPOINT ───────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    const data = loadData();

    // Fetch data for all watchlist symbols in parallel (limit to 5 at a time)
    const batch = WATCHLIST.slice(0, 6);
    const allData = await Promise.allSettled(batch.map(s => fetchMarketData(s)));
    const marketDataMap = {};
    for (let i = 0; i < batch.length; i++) {
      if (allData[i].status === "fulfilled") marketDataMap[batch[i]] = allData[i].value;
    }

    const summaries = Object.entries(marketDataMap).map(([sym, d]) => ({
      symbol: sym,
      price: d.priceData.current,
      change: d.priceData.change,
      rsi: d.indicators.rsi,
      macdBullish: d.indicators.macd?.bullish,
      volume: d.volume.trend,
      iv: d.options.iv,
      atr: d.indicators.atr,
      aboveEMA50: d.priceData.current > d.indicators.ema50,
      aboveEMA200: d.priceData.current > d.indicators.ema200,
      stoch: d.indicators.stochastic,
      williamsR: d.indicators.williamsR,
      obvTrend: d.indicators.obv?.trend,
    }));

    const prompt = `You are an elite options trading analyst. You have LIVE market data for ${batch.length} stocks. The user is on a $10 → $10,000 challenge. Current balance: $${data.balance}. Total trades so far: ${data.trades.length}. Win rate: ${data.trades.length > 0 ? Math.round((data.trades.filter(t=>t.result==='win').length/data.trades.length)*100) : 0}%.

LIVE MARKET SUMMARIES:
${JSON.stringify(summaries, null, 2)}

DETAILED DATA FOR TOP CANDIDATES:
${JSON.stringify(marketDataMap, null, 2)}

Your job:
1. Pick the SINGLE BEST stock to trade today for maximum probability of profit
2. Decide BUY (CALL) or SELL (PUT)
3. Give a complete day-trading plan
4. Recommend how much of $${data.balance} to risk based on signal confidence

Return ONLY valid JSON, no markdown:
{
  "chosenSymbol": string,
  "symbolReason": "2 sentences explaining why this stock was chosen over others today",
  "stockRankings": [
    {"symbol":string,"score":number,"reason":string}
  ],
  "signal": "BUY" or "SELL" or "HOLD",
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "accuracyScore": number,
  "indicatorConsensus": {"bullish":number,"bearish":number,"neutral":number},
  "signalExplanation": "2-3 plain English sentences with real data values",
  "currentPrice": number,
  "priceChange": number,
  "weekHigh": number,
  "weekLow": number,
  "volume": string,
  "avgVolume": string,
  "positionSizing": {
    "recommendedAmount": number,
    "percentOfBalance": number,
    "reasoning": "Plain English explanation of why this amount based on confidence and current balance",
    "balanceAfterTrade": number,
    "growthNeeded": "How many successful trades like this needed to reach $10,000 at this rate"
  },
  "challengeContext": "1-2 sentences putting this trade in context of the $10→$10,000 journey. Be honest about realistic timeline.",
  "exitStrategy": {
    "recommendedHoldTime": string,
    "latestExitTime": string,
    "sellSignals": [string,string,string,string,string],
    "doNotHoldIf": [string,string],
    "dayTradingTips": string
  },
  "probability": {
    "overallPercent": number,
    "factors": [
      {"label":"Trend Alignment","score":number,"note":string},
      {"label":"Momentum (MACD/RSI/Stoch)","score":number,"note":string},
      {"label":"Volume & OBV","score":number,"note":string},
      {"label":"Options Delta (est.)","score":number,"note":string},
      {"label":"Implied Volatility","score":number,"note":string},
      {"label":"Support/Resistance","score":number,"note":string},
      {"label":"Williams %R","score":number,"note":string}
    ],
    "verdict": string
  },
  "scenarios": [
    {"type":"bull","label":"Bull Case","probability":string,"target":number,"result":string},
    {"type":"base","label":"Base Case","probability":string,"target":number,"result":string},
    {"type":"bear","label":"Bear Case","probability":string,"target":number,"result":string},
    {"type":"worst","label":"Worst Case","probability":string,"target":number,"result":string}
  ],
  "entryPrice": number,
  "entryNote": string,
  "stopLoss": number,
  "stopNote": string,
  "profitTarget": number,
  "targetNote": string,
  "riskReward": string,
  "atrNote": string,
  "budget": {
    "suggestedOptionType": "CALL" or "PUT",
    "strikePrice": number,
    "expiration": string,
    "estimatedOptionCost": string,
    "maxLoss": string,
    "estimatedGain": string,
    "robinhoodNote": string
  },
  "indicators": [
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
  "support": [{"level":number,"strength":string},{"level":number,"strength":string},{"level":number,"strength":string}],
  "resistance": [{"level":number,"strength":string},{"level":number,"strength":string},{"level":number,"strength":string}],
  "analysis": "5-6 plain English sentences with real values. Day trading focused.",
  "robinhoodSteps": "6-8 numbered steps for this exact trade on Robinhood including position size and when to exit same day."
}`;

    const ai = await anthropic.messages.create({ model: "claude-opus-4-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] });
    const raw = ai.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI parse failed");
    const analysis = JSON.parse(match[0]);

    // Attach position sizing from server-side calc too
    const sizing = calcPositionSize(data.balance, analysis.confidence, analysis.accuracyScore);
    analysis._sizing = sizing;
    analysis._balance = data.balance;
    analysis._goal = data.goal;
    analysis._trades = data.trades.slice(-20); // last 20 trades
    analysis._milestones = data.milestones;
    analysis._fetchedAt = new Date().toISOString();

    res.json({ success: true, data: analysis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Log a trade ──────────────────────────────────────────────────────────────
app.post("/api/trade/log", (req, res) => {
  const { symbol, optionType, entryPrice, exitPrice, amount, result, notes } = req.body;
  const data = loadData();

  const pnl = result === "win"
    ? parseFloat((exitPrice - amount).toFixed(2))
    : parseFloat((-amount).toFixed(2));

  const oldBalance = data.balance;
  data.balance = parseFloat((data.balance + pnl).toFixed(2));
  if (data.balance < 0) data.balance = 0;

  const trade = {
    id: Date.now(),
    date: new Date().toISOString(),
    symbol, optionType, entryPrice, exitPrice,
    amountRisked: amount, pnl, result,
    balanceAfter: data.balance,
    notes: notes || "",
  };

  data.trades.unshift(trade);

  // Check milestones
  const hit = checkMilestone(oldBalance, data.balance, data.milestones);
  if (hit) {
    data.milestones.push(hit);
    trade.milestone = hit;
  }

  saveData(data);
  res.json({ success: true, trade, newBalance: data.balance, milestone: hit || null });
});

// ─── Update balance manually ──────────────────────────────────────────────────
app.post("/api/balance/update", (req, res) => {
  const { balance } = req.body;
  if (isNaN(balance) || balance < 0) return res.status(400).json({ success: false, error: "Invalid balance" });
  const data = loadData();
  const old = data.balance;
  data.balance = parseFloat(parseFloat(balance).toFixed(2));
  const hit = checkMilestone(old, data.balance, data.milestones);
  if (hit) data.milestones.push(hit);
  saveData(data);
  res.json({ success: true, balance: data.balance, milestone: hit || null });
});

// ─── Get challenge data ───────────────────────────────────────────────────────
app.get("/api/challenge", (req, res) => {
  const data = loadData();
  res.json({ success: true, data });
});

// ─── Live price ───────────────────────────────────────────────────────────────
app.get("/api/price/:symbol", async (req, res) => {
  try {
    const price = await getCurrentPrice(req.params.symbol.toUpperCase());
    res.json({ success: true, price });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Monitor ─────────────────────────────────────────────────────────────────
app.post("/api/monitor/start", async (req, res) => {
  const { email, symbol, entryPrice, stopLoss, profitTarget, signal, optionType } = req.body;
  if (!email || !symbol || !entryPrice || !stopLoss || !profitTarget)
    return res.status(400).json({ success: false, error: "Missing fields" });

  const id = Date.now().toString();
  await sendAlertEmail(email, `🟢 ${symbol} Monitor Started`,
    `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px">
      <h2 style="color:#00e5ff">📊 ${symbol} Monitor Active</h2>
      <p><strong style="color:#00ff88">Signal:</strong> ${signal} ${optionType}</p>
      <p><strong style="color:#00e5ff">Entry:</strong> $${entryPrice}</p>
      <p><strong style="color:#ff3b5c">Stop Loss:</strong> $${stopLoss}</p>
      <p><strong style="color:#00ff88">Target:</strong> $${profitTarget}</p>
      <p style="color:#4a6b85;margin-top:12px;font-size:12px">Checking every 3 minutes.</p>
    </div>`
  );

  const intervalId = setInterval(async () => {
    const m = activeMonitors[id];
    if (!m || m.triggered) { clearInterval(intervalId); delete activeMonitors[id]; return; }
    try {
      const cp = await getCurrentPrice(symbol);
      const isBuy = signal === "BUY";
      const hitStop = isBuy ? cp <= stopLoss : cp >= stopLoss;
      const hitTarget = isBuy ? cp >= profitTarget : cp <= profitTarget;
      if (hitStop || hitTarget) {
        m.triggered = true;
        clearInterval(intervalId);
        const win = hitTarget;
        await sendAlertEmail(email,
          win ? `🟢 TAKE PROFIT — ${symbol} Target Hit!` : `🔴 STOP LOSS HIT — ${symbol} — Sell Now!`,
          `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px">
            <h2 style="color:${win?"#00ff88":"#ff3b5c"}">${win?"🟢 PROFIT TARGET HIT!":"🔴 STOP LOSS HIT!"}</h2>
            <p style="font-size:20px">${symbol} is at <strong style="color:${win?"#00ff88":"#ff3b5c"}">$${cp}</strong></p>
            <div style="background:rgba(${win?"0,255,136":"255,59,92"},0.1);padding:12px;border-left:3px solid ${win?"#00ff88":"#ff3b5c"};margin-top:12px">
              <strong>Open Robinhood NOW and ${win?"sell to lock in profits!":"sell to limit your loss!"}</strong>
            </div>
          </div>`
        );
        delete activeMonitors[id];
      }
    } catch(e) { console.error("Monitor err:", e.message); }
  }, 3*60*1000);

  activeMonitors[id] = { email, symbol, entryPrice, stopLoss, profitTarget, signal, optionType, intervalId, triggered: false };
  res.json({ success: true, monitorId: id });
});

app.post("/api/monitor/stop", (req, res) => {
  const { monitorId } = req.body;
  if (activeMonitors[monitorId]) { clearInterval(activeMonitors[monitorId].intervalId); delete activeMonitors[monitorId]; }
  res.json({ success: true });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Challenge app on port ${PORT}`));
