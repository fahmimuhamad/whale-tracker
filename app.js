// ─── Whale Intelligence — Fully Dynamic Engine ───
// Zero hardcoded scores. All computed from live CoinGecko market data.

const API = "https://api.coingecko.com/api/v3";
const PER_PAGE = 250;
let PAGES_TO_FETCH = 1;
const CARDS_PER_PAGE = 24;

// Optional: paste your free CoinGecko demo API key here for higher rate limits.
// Get one at https://www.coingecko.com/en/api/pricing (free sign-up).
const CG_DEMO_KEY = "";

// ─── Binance API (free, no key required) ───
const BINANCE_SPOT = "https://api.binance.com/api/v3";
const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1";

// ─── State ───
let allCoins = [];
let scoredCoins = [];
let previousPrices = {};
let currentPage = 1;
let currentView = "grid";
let countdown = 120;
let refreshTimer = null;
let countdownTimer = null;
let historicalVolumes = {};
let cachedGlobal = null;
let cachedFng = null;
let binanceData = { tickers: {}, funding: {}, bookTickers: {} };

// ─── Formatting ───
function fmt(n) {
  if (n == null || isNaN(n)) return "--";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(n) {
  if (n == null) return "--";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "--";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, Math.round(v))); }
function scoreColor(v) { return v >= 70 ? "high" : v >= 45 ? "mid" : "low"; }

// ─── API Fetching with retry & rate-limit handling ───
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setStatus(msg) {
  const el = document.getElementById("lastUpdate");
  if (el) el.textContent = msg;
}

async function fetchWithRetry(url, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = { "Accept": "application/json" };
      if (CG_DEMO_KEY && url.includes("coingecko.com")) {
        headers["x-cg-demo-api-key"] = CG_DEMO_KEY;
      }
      const res = await fetch(url, { headers });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const wait = Math.min(15000 * Math.pow(2, attempt), 120000);
        setStatus(`Rate limited — waiting ${(wait/1000).toFixed(0)}s (attempt ${attempt + 1}/${retries + 1})...`);
        await sleep(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt === retries) {
        console.warn(`Fetch failed after ${retries + 1} attempts:`, url, e.message);
        return null;
      }
      const wait = 5000 * (attempt + 1);
      setStatus(`Connection error — retrying in ${(wait/1000).toFixed(0)}s...`);
      await sleep(wait);
    }
  }
  return null;
}

async function fetchPage(page) {
  const url = `${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}&sparkline=false&price_change_percentage=1h%2C24h%2C7d`;
  return await fetchWithRetry(url);
}

async function fetchAllCoins() {
  let all = [];
  for (let p = 1; p <= PAGES_TO_FETCH; p++) {
    setStatus(`Loading page ${p}/${PAGES_TO_FETCH}...`);
    const data = await fetchPage(p);
    if (data && Array.isArray(data)) {
      all = all.concat(data);
    }
    if (p < PAGES_TO_FETCH) await sleep(12000);
  }
  return all.filter(c => c && c.id && c.market_cap > 0);
}

async function fetchGlobal() {
  return await fetchWithRetry(`${API}/global`);
}

async function fetchFearGreed() {
  return await fetchWithRetry("https://api.alternative.me/fng/?limit=1", 2);
}

// ─── Binance Data Fetching ───
async function fetchBinance(url) {
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (res.ok) return await res.json();
    console.warn(`Binance ${res.status}:`, url);
    return null;
  } catch (e) {
    console.warn("Binance fetch failed:", e.message);
    return null;
  }
}

async function fetchAllBinanceData() {
  setStatus("Fetching Binance derivatives data...");
  const [tickers, funding, bookTickers] = await Promise.all([
    fetchBinance(`${BINANCE_SPOT}/ticker/24hr`),
    fetchBinance(`${BINANCE_FUTURES}/premiumIndex`),
    fetchBinance(`${BINANCE_SPOT}/ticker/bookTicker`)
  ]);
  if (tickers && Array.isArray(tickers)) {
    binanceData.tickers = {};
    tickers.forEach(t => { binanceData.tickers[t.symbol] = t; });
  }
  if (funding && Array.isArray(funding)) {
    binanceData.funding = {};
    funding.forEach(f => { binanceData.funding[f.symbol] = f; });
  }
  if (bookTickers && Array.isArray(bookTickers)) {
    binanceData.bookTickers = {};
    bookTickers.forEach(b => { binanceData.bookTickers[b.symbol] = b; });
  }
}

// ─── DYNAMIC SCORING ENGINE ───
// Every score is algorithmically derived from live data.

function computeScores(coin) {
  const c24 = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? 0;
  const c1h = coin.price_change_percentage_1h_in_currency ?? 0;
  const c7d = coin.price_change_percentage_7d_in_currency ?? 0;
  const vol = coin.total_volume || 0;
  const mcap = coin.market_cap || 1;
  const ath = coin.ath || coin.current_price;
  const price = coin.current_price || 0;
  const hi24 = coin.high_24h || price;
  const lo24 = coin.low_24h || price;
  const circulating = coin.circulating_supply || 0;
  const total = coin.total_supply || circulating || 1;

  const volMcapRatio = vol / mcap;
  const athDrop = ath > 0 ? ((ath - price) / ath) * 100 : 0;
  const range24 = hi24 > 0 ? ((hi24 - lo24) / hi24) * 100 : 0;
  const supplyRatio = circulating > 0 && total > 0 ? circulating / total : 1;

  // Track volume history for spike detection
  const prevVol = historicalVolumes[coin.id];
  const volChange = prevVol ? ((vol - prevVol) / prevVol) * 100 : 0;
  historicalVolumes[coin.id] = vol;

  // Binance derivatives data
  const bnSymbol = coin.symbol.toUpperCase() + "USDT";
  const bnFunding = binanceData.funding[bnSymbol];
  const bnBook = binanceData.bookTickers[bnSymbol];
  const fundingRate = bnFunding ? parseFloat(bnFunding.lastFundingRate) * 100 : null;
  let bookPressure = 0;
  if (bnBook) {
    const bidQty = parseFloat(bnBook.bidQty) || 0;
    const askQty = parseFloat(bnBook.askQty) || 0;
    if (bidQty + askQty > 0) bookPressure = ((bidQty - askQty) / (bidQty + askQty)) * 100;
  }

  // --- Whale Activity Score (0-100) ---
  // High volume/mcap = large players. Big 24h range = whale moves. High ATH distance + volume = accumulation.
  let whale = 0;
  whale += clamp(volMcapRatio * 200, 0, 30);              // vol/mcap intensity (max 30)
  whale += clamp(range24 * 3, 0, 20);                      // 24h range volatility (max 20)
  whale += clamp((athDrop > 50 ? 15 : athDrop * 0.25), 0, 15); // deep discount = accumulation zone (max 15)
  whale += clamp(Math.abs(c24) * 1.5, 0, 15);              // price movement magnitude (max 15)
  whale += clamp(volChange > 50 ? 15 : volChange * 0.2, 0, 15); // volume spike (max 15)
  if (c24 < -2 && volMcapRatio > 0.1) whale += 5;         // selling into volume = whale distribution
  if (fundingRate !== null && Math.abs(fundingRate) > 0.03) whale += 5;
  if (Math.abs(bookPressure) > 30) whale += 3;
  whale = clamp(whale);

  // --- Smart Money Score (0-100) ---
  // Steady positive momentum + high mcap rank + moderate volume = institutional behavior.
  let smart = 0;
  const mcapRank = coin.market_cap_rank || 999;
  smart += clamp(mcapRank <= 10 ? 25 : mcapRank <= 30 ? 20 : mcapRank <= 100 ? 15 : mcapRank <= 250 ? 8 : 3, 0, 25);
  smart += clamp(c7d > 0 ? c7d * 2 : c7d * 0.5, -10, 20);
  smart += clamp(c24 > 0 ? c24 * 2.5 : 0, 0, 15);
  smart += clamp(volMcapRatio * 100, 0, 15);
  smart += clamp(supplyRatio > 0.7 ? 10 : supplyRatio * 14, 0, 10);
  if (c24 > 0 && c7d > 0 && c1h > 0) smart += 10;         // all timeframes green = conviction
  if (c24 > 1 && range24 < 5) smart += 5;                  // steady climb, not volatile
  if (fundingRate !== null && fundingRate < -0.02 && c24 > 0) smart += 5;
  if (fundingRate !== null && fundingRate > 0.05 && c24 < 0) smart += 5;
  smart = clamp(smart);

  // --- Accumulation Score (0-100) ---
  // Far from ATH + increasing volume + price stabilizing or rising from lows.
  let accum = 0;
  accum += clamp(athDrop > 80 ? 30 : athDrop > 60 ? 25 : athDrop > 40 ? 18 : athDrop > 20 ? 10 : 3, 0, 30);
  accum += clamp(volMcapRatio * 150, 0, 20);
  accum += clamp(c24 > -1 && c24 < 5 ? 15 : 5, 0, 15);    // price in consolidation = accumulation
  accum += clamp(volChange > 20 ? 15 : volChange * 0.5, 0, 15);
  accum += clamp(c7d >= -5 && c7d <= 10 ? 10 : 3, 0, 10);  // 7d range-bound = building base
  accum += clamp(supplyRatio < 0.5 ? 10 : 3, 0, 10);        // low float = tighter supply
  accum = clamp(accum);

  // --- Pump Probability (0-100) ---
  // Volume spike + positive momentum + near resistance + accumulation.
  let pump = 0;
  pump += clamp(volMcapRatio > 0.25 ? 20 : volMcapRatio * 80, 0, 20);
  pump += clamp(c1h > 2 ? 15 : c1h > 0.5 ? 10 : c1h > 0 ? 5 : 0, 0, 15);
  pump += clamp(c24 > 5 ? 15 : c24 > 2 ? 10 : c24 > 0 ? 6 : 0, 0, 15);
  pump += clamp(athDrop > 60 ? 12 : athDrop > 30 ? 8 : 3, 0, 12);
  pump += clamp(volChange > 100 ? 15 : volChange > 30 ? 10 : volChange > 0 ? 5 : 0, 0, 15);
  pump += clamp(range24 > 8 ? 8 : range24 * 1, 0, 8);
  pump += clamp(accum * 0.15, 0, 15);
  if (fundingRate !== null && fundingRate < -0.03 && c24 > 0) pump += 5;
  pump = clamp(pump);

  // --- Pressure ---
  let pressure;
  if (c24 > 3 && c1h > 0.5 && volMcapRatio > 0.08) pressure = "Bullish";
  else if (c24 > 1 && c7d > 0) pressure = "Bullish";
  else if (c24 < -3 && c1h < -0.5) pressure = "Bearish";
  else if (c24 < -1 && c7d < -5) pressure = "Bearish";
  else pressure = "Neutral";

  if (bookPressure > 25 && c24 > 0 && pressure === "Neutral") pressure = "Bullish";
  else if (bookPressure < -25 && c24 < 0 && pressure === "Neutral") pressure = "Bearish";

  // --- Risk ---
  let risk;
  if (mcapRank <= 20 && range24 < 8) risk = "Low";
  else if (mcapRank <= 80 && range24 < 12) risk = "Medium";
  else risk = "High";

  // --- Signal flags ---
  const signals = {
    whaleAccum: whale >= 55,
    smartMoney: smart >= 55,
    volumeSpike: volMcapRatio > 0.15 || volChange > 50,
    momentum: c24 > 2 && c1h > 0.3,
    deepValue: athDrop > 60
  };

  const signalCount = Object.values(signals).filter(Boolean).length;

  // Description generation
  const parts = [];
  if (signals.volumeSpike) parts.push(`Vol/MCap ${(volMcapRatio * 100).toFixed(1)}%`);
  if (signals.deepValue) parts.push(`${athDrop.toFixed(0)}% off ATH`);
  if (signals.momentum) parts.push(`24h ${fmtPct(c24)}`);
  if (signals.whaleAccum) parts.push("Whale activity");
  if (signals.smartMoney) parts.push("Smart $ flow");
  const description = parts.length ? parts.join(" · ") : `MCap rank #${mcapRank}`;

  // % of total supply traded in 24h: volume_usd / (total_supply * price)
  const supplyTradedPct = (total > 0 && price > 0)
    ? (vol / (total * price)) * 100
    : 0;

  return {
    whale, smart, accum, pump,
    pressure, risk, signals, signalCount,
    description, volMcapRatio, athDrop, volChange, range24,
    c24, c1h, c7d, supplyTradedPct, supplyRatio,
    fundingRate, bookPressure,
    hasBinance: fundingRate !== null
  };
}

// ─── Filter & Sort ───
function getFilteredCoins() {
  const search = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();
  const minPump = parseInt(document.getElementById("filterMinPump")?.value || "0");
  const sortKey = document.getElementById("filterSort")?.value || "pump";

  let coins = scoredCoins.filter(sc => {
    if (search) {
      const c = sc.coin;
      if (!c.name.toLowerCase().includes(search) &&
          !c.symbol.toLowerCase().includes(search) &&
          !c.id.toLowerCase().includes(search)) return false;
    }
    if (minPump > 0 && sc.scores.pump < minPump) return false;
    return true;
  });

  const sortFns = {
    pump: (a, b) => b.scores.pump - a.scores.pump,
    accumulation: (a, b) => b.scores.accum - a.scores.accum,
    whale: (a, b) => b.scores.whale - a.scores.whale,
    smart: (a, b) => b.scores.smart - a.scores.smart,
    volume: (a, b) => b.scores.volMcapRatio - a.scores.volMcapRatio,
    mcap: (a, b) => (b.coin.market_cap || 0) - (a.coin.market_cap || 0)
  };
  coins.sort(sortFns[sortKey] || sortFns.pump);
  return coins;
}

// ─── Rendering ───
function renderGlobalStats(globalData, fgData) {
  if (globalData?.data) {
    const d = globalData.data;
    document.getElementById("totalMcap").textContent = fmt(d.total_market_cap?.usd);
    const mc = d.market_cap_change_percentage_24h_usd;
    const el = document.getElementById("totalMcapChange");
    el.textContent = fmtPct(mc);
    el.className = `stat-change ${mc >= 0 ? "positive" : "negative"}`;
    document.getElementById("totalVolume").textContent = fmt(d.total_volume?.usd);
    document.getElementById("btcDominance").textContent = `${d.market_cap_percentage?.btc?.toFixed(1)}%`;
  }
  if (fgData?.data?.[0]) {
    const fg = fgData.data[0];
    document.getElementById("fearGreed").textContent = fg.value;
    const l = document.getElementById("fearGreedLabel");
    l.textContent = fg.value_classification;
    l.className = `stat-change ${parseInt(fg.value) > 50 ? "positive" : "negative"}`;
  }
  const btcFunding = binanceData.funding["BTCUSDT"];
  if (btcFunding) {
    const fr = parseFloat(btcFunding.lastFundingRate) * 100;
    document.getElementById("btcFunding").textContent = `${fr > 0 ? '+' : ''}${fr.toFixed(4)}%`;
    const lbl = document.getElementById("btcFundingLabel");
    lbl.textContent = fr > 0.01 ? "Longs Pay" : fr < -0.01 ? "Shorts Pay" : "Neutral";
    lbl.className = `stat-change ${fr > 0.01 ? "negative" : fr < -0.01 ? "positive" : ""}`;
  }

  const longSigs = tradingSignals.filter(s => s.direction === "LONG").length;
  const shortSigs = tradingSignals.filter(s => s.direction === "SHORT").length;
  document.getElementById("activeSignals").textContent = tradingSignals.length || "--";
  const bd = document.getElementById("signalBreakdown");
  if (tradingSignals.length) {
    bd.textContent = `${longSigs} LONG · ${shortSigs} SHORT`;
    bd.className = `stat-change ${longSigs > shortSigs ? "positive" : shortSigs > longSigs ? "negative" : ""}`;
  }
}

function renderTicker(data) {
  const top5 = data.slice(0, 6);
  document.getElementById("marketTicker").innerHTML = top5.map(c => {
    const change = c.price_change_percentage_24h || 0;
    const cls = change >= 0 ? "positive" : "negative";
    return `<div class="ticker-item">
      <span class="ticker-symbol">${c.symbol.toUpperCase()}</span>
      <span>${fmtPrice(c.current_price)}</span>
      <span class="stat-change ${cls}">${fmtPct(change)}</span>
    </div>`;
  }).join("");
}

function renderAssetGrid(filtered) {
  const grid = document.getElementById("assetGrid");
  const table = document.getElementById("assetTable");
  const totalPages = Math.ceil(filtered.length / CARDS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages || 1;
  const start = (currentPage - 1) * CARDS_PER_PAGE;
  const pageItems = filtered.slice(start, start + CARDS_PER_PAGE);

  document.getElementById("assetCountBadge").textContent = `${filtered.length} COINS`;
  document.getElementById("assetPanelTitle").textContent =
    `All Assets — Scored in Real-Time (${allCoins.length} tracked)`;

  if (currentView === "grid") {
    grid.classList.remove("hidden");
    table.classList.add("hidden");
    grid.innerHTML = pageItems.map(({ coin: c, scores: s }) => {
      const change = s.c24;
      const changeCls = change >= 0 ? "positive" : "negative";
      const prev = previousPrices[c.id];
      const flash = prev && prev !== c.current_price
        ? (c.current_price > prev ? "flash-green" : "flash-red") : "";

      const bars = [
        { label: "Whale Activity", value: s.whale },
        { label: "Smart Money", value: s.smart },
        { label: "Accumulation", value: s.accum },
        { label: "Pump Probability", value: s.pump }
      ];

      return `<div class="asset-card animate-in ${flash}" data-coin-id="${c.id}">
        <div class="asset-card-header">
          <div class="asset-name-wrap">
            <img class="asset-icon" src="${c.image}" alt="${c.symbol}" loading="lazy">
            <div>
              <div class="asset-name">${c.name}</div>
              <div class="asset-symbol">${c.symbol.toUpperCase()} · <span class="asset-rank">#${c.market_cap_rank || "--"}</span> · ${fmt(c.market_cap)}</div>
            </div>
          </div>
          <div class="asset-price-wrap">
            <div class="asset-price">${fmtPrice(c.current_price)}</div>
            <div class="asset-price-change stat-change ${changeCls}">${fmtPct(change)}</div>
          </div>
        </div>
        <div class="score-grid">
          ${bars.map(b => `<div class="score-item">
            <span class="score-label">${b.label}</span>
            <div class="score-bar-wrap">
              <div class="score-bar"><div class="score-bar-fill fill-${scoreColor(b.value)}" style="width:${b.value}%"></div></div>
              <span class="score-value score-${scoreColor(b.value)}">${b.value}</span>
            </div>
          </div>`).join("")}
        </div>
        <div class="supply-row">
          <div class="supply-stat">
            <span class="supply-label">% Supply Traded 24h</span>
            <span class="supply-value ${s.supplyTradedPct > 5 ? 'score-high' : s.supplyTradedPct > 1 ? 'score-mid' : ''}">${s.supplyTradedPct.toFixed(2)}%</span>
          </div>
          <div class="supply-stat">
            <span class="supply-label">Circ / Total Supply</span>
            <span class="supply-value">${(s.supplyRatio * 100).toFixed(1)}%</span>
          </div>
        </div>
        <div class="asset-card-footer">
          <div>
            <span class="pressure-tag pressure-${s.pressure.toLowerCase().includes('bull') ? 'bullish' : s.pressure.toLowerCase().includes('bear') ? 'bearish' : 'neutral'}">${s.pressure}</span>
            <span class="risk-tag risk-${s.risk.toLowerCase()}" style="margin-left:4px">${s.risk}</span>
            ${s.fundingRate !== null ? `<span class="fr-tag ${s.fundingRate > 0.01 ? 'fr-hot' : s.fundingRate < -0.01 ? 'fr-cold' : 'fr-neutral'}" style="margin-left:4px" title="Binance Funding Rate">FR:${s.fundingRate > 0 ? '+' : ''}${s.fundingRate.toFixed(3)}%</span>` : ''}
          </div>
          <div style="text-align:right">
            <div class="pump-prob score-${scoreColor(s.pump)}">${s.pump}%</div>
            <div class="pump-prob-label">Pump Prob</div>
          </div>
        </div>
      </div>`;
    }).join("");
  } else {
    grid.classList.add("hidden");
    table.classList.remove("hidden");
    table.querySelector("tbody").innerHTML = pageItems.map(({ coin: c, scores: s }, i) => {
      const idx = start + i + 1;
      const c24cls = s.c24 >= 0 ? "trend-up" : "trend-down";
      const c7dcls = s.c7d >= 0 ? "trend-up" : "trend-down";
      const supplyClass = s.supplyTradedPct > 5 ? "score-high" : s.supplyTradedPct > 1 ? "score-mid" : "";
      return `<tr data-coin-id="${c.id}">
        <td>${idx}</td>
        <td><div class="asset-cell"><img src="${c.image}" loading="lazy"><span class="asset-cell-name">${c.name}</span><span class="asset-cell-sym">${c.symbol.toUpperCase()}</span></div></td>
        <td>${fmtPrice(c.current_price)}</td>
        <td class="${c24cls}">${fmtPct(s.c24)}</td>
        <td class="${c7dcls}">${fmtPct(s.c7d)}</td>
        <td>${(s.volMcapRatio * 100).toFixed(1)}%</td>
        <td class="${supplyClass}">${s.supplyTradedPct.toFixed(2)}%</td>
        <td class="score-${scoreColor(s.whale)}">${s.whale}</td>
        <td class="score-${scoreColor(s.smart)}">${s.smart}</td>
        <td class="score-${scoreColor(s.accum)}">${s.accum}</td>
        <td class="score-${scoreColor(s.pump)}">${s.pump}%</td>
        <td><span class="pressure-tag pressure-${s.pressure.toLowerCase().includes('bull') ? 'bullish' : s.pressure.toLowerCase().includes('bear') ? 'bearish' : 'neutral'}">${s.pressure}</span></td>
        <td><span class="risk-tag risk-${s.risk.toLowerCase()}">${s.risk}</span></td>
      </tr>`;
    }).join("");
  }

  renderPagination(filtered.length, totalPages);
}

function renderPagination(total, totalPages) {
  const el = document.getElementById("pagination");
  if (totalPages <= 1) { el.innerHTML = ""; return; }

  let btns = [];
  btns.push(`<button class="page-btn" ${currentPage <= 1 ? "disabled" : ""} data-page="${currentPage - 1}">&laquo;</button>`);

  const maxShow = 7;
  let startP = Math.max(1, currentPage - 3);
  let endP = Math.min(totalPages, startP + maxShow - 1);
  if (endP - startP < maxShow - 1) startP = Math.max(1, endP - maxShow + 1);

  if (startP > 1) btns.push(`<button class="page-btn" data-page="1">1</button>`);
  if (startP > 2) btns.push(`<span style="color:var(--text-muted);padding:0 4px">...</span>`);
  for (let p = startP; p <= endP; p++) {
    btns.push(`<button class="page-btn ${p === currentPage ? "active" : ""}" data-page="${p}">${p}</button>`);
  }
  if (endP < totalPages - 1) btns.push(`<span style="color:var(--text-muted);padding:0 4px">...</span>`);
  if (endP < totalPages) btns.push(`<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`);
  btns.push(`<button class="page-btn" ${currentPage >= totalPages ? "disabled" : ""} data-page="${currentPage + 1}">&raquo;</button>`);

  el.innerHTML = btns.join("");
  el.querySelectorAll(".page-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = parseInt(btn.dataset.page);
      if (!isNaN(p) && p >= 1 && p <= totalPages) {
        currentPage = p;
        renderView();
        document.getElementById("assetPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

function renderRankedLists() {
  const accList = document.getElementById("accumulationList");
  const pumpList = document.getElementById("pumpList");

  const topAccum = [...scoredCoins].sort((a, b) => b.scores.accum - a.scores.accum).slice(0, 15);
  const topPump = [...scoredCoins].sort((a, b) => b.scores.pump - a.scores.pump).slice(0, 15);

  accList.innerHTML = topAccum.map((sc, i) => rankedItemHTML(sc, i, sc.scores.accum, false)).join("");
  pumpList.innerHTML = topPump.map((sc, i) => rankedItemHTML(sc, i, sc.scores.pump, true)).join("");
}

function rankedItemHTML({ coin: c, scores: s }, i, value, isPump) {
  return `<div class="ranked-item animate-in" data-coin-id="${c.id}" style="animation-delay:${i * 0.03}s">
    <span class="rank-num ${i < 3 ? 'top' : ''}">${i + 1}</span>
    <img class="asset-icon" src="${c.image}" alt="${c.symbol}" style="width:26px;height:26px" loading="lazy">
    <div class="ranked-info">
      <div class="ranked-name">${c.name} <span style="color:var(--text-muted);font-weight:400">${c.symbol.toUpperCase()}</span></div>
      <div class="ranked-signal">${s.description}</div>
    </div>
    <span class="ranked-price">${fmtPrice(c.current_price)}</span>
    <span class="ranked-score score-${scoreColor(value)}">${value}${isPump ? "%" : ""}</span>
  </div>`;
}

function renderVolumeAnomalies() {
  const grid = document.getElementById("anomalyGrid");
  const sortKey = document.getElementById("anomalySort")?.value || "ratio";

  let anomalies = [...scoredCoins]
    .filter(sc => sc.scores.volMcapRatio > 0.1);

  const sortFns = {
    ratio: (a, b) => b.scores.volMcapRatio - a.scores.volMcapRatio,
    whale: (a, b) => b.scores.whale - a.scores.whale,
    change: (a, b) => Math.abs(b.scores.c24) - Math.abs(a.scores.c24)
  };
  anomalies.sort(sortFns[sortKey] || sortFns.ratio);

  const top = anomalies.slice(0, 20);

  const extremeCount = top.filter(sc => sc.scores.volMcapRatio > 0.5).length;
  document.getElementById("anomalyCountBadge").textContent =
    `${top.length} SPIKES${extremeCount ? ` · ${extremeCount} EXTREME` : ""}`;

  if (!top.length) {
    grid.innerHTML = `<div class="anomaly-empty">No volume anomalies detected in this cycle. Anomalies trigger when Vol/MCap exceeds 10%.</div>`;
    return;
  }

  const maxRatio = Math.max(...top.map(sc => sc.scores.volMcapRatio), 1);

  grid.innerHTML = top.map(({ coin: c, scores: s }, i) => {
    const ratio = s.volMcapRatio;
    const ratioPct = ratio * 100;

    let level, levelKey, icon;
    if (ratio > 0.5) {
      level = "EXTREME"; levelKey = "extreme";
      icon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
    } else if (ratio > 0.25) {
      level = "HIGH"; levelKey = "high";
      icon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`;
    } else {
      level = "MODERATE"; levelKey = "moderate";
      icon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    }

    const barWidth = Math.min((ratio / maxRatio) * 100, 100);
    const thresholdPos = (0.1 / maxRatio) * 100;
    const c24cls = s.c24 >= 0 ? "trend-up" : "trend-down";

    const signalItems = [
      { key: "whaleAccum", label: "Whale" },
      { key: "smartMoney", label: "Smart $" },
      { key: "momentum", label: "Momentum" },
      { key: "volumeSpike", label: "Vol Spike" },
      { key: "deepValue", label: "Deep Value" }
    ];

    return `<div class="anomaly-card anomaly-${levelKey} animate-in" data-coin-id="${c.id}" style="animation-delay:${i * 0.03}s">
      <div class="anomaly-card-top">
        <div class="anomaly-coin-info">
          <img src="${c.image}" alt="${c.symbol}" loading="lazy">
          <div>
            <div class="anomaly-coin-name">${c.name}</div>
            <div class="anomaly-coin-meta">${c.symbol.toUpperCase()} · #${c.market_cap_rank || "--"} · ${fmt(c.market_cap)}</div>
          </div>
        </div>
        <div class="anomaly-level-badge alb-${levelKey}">${icon} ${level}</div>
      </div>

      <div class="anomaly-intensity">
        <div class="anomaly-intensity-header">
          <span class="anomaly-intensity-label">Vol / MCap Intensity</span>
          <span class="anomaly-intensity-value anomaly-level-badge alb-${levelKey}" style="background:none;border:none;padding:0;font-size:1rem">${ratioPct.toFixed(1)}%</span>
        </div>
        <div class="anomaly-bar-track">
          <div class="anomaly-bar-threshold" style="left:${thresholdPos}%"></div>
          <div class="anomaly-bar-fill abf-${levelKey}" style="width:${barWidth}%"></div>
        </div>
        <div class="anomaly-bar-labels">
          <span>0%</span>
          <span>Normal &lt;10%</span>
          <span>${(maxRatio * 100).toFixed(0)}%</span>
        </div>
      </div>

      <div class="anomaly-stats">
        <div class="anomaly-stat">
          <div class="anomaly-stat-label">Price</div>
          <div class="anomaly-stat-value">${fmtPrice(c.current_price)}</div>
        </div>
        <div class="anomaly-stat">
          <div class="anomaly-stat-label">24h</div>
          <div class="anomaly-stat-value ${c24cls}">${fmtPct(s.c24)}</div>
        </div>
        <div class="anomaly-stat">
          <div class="anomaly-stat-label">Whale</div>
          <div class="anomaly-stat-value score-${scoreColor(s.whale)}">${s.whale}</div>
        </div>
      </div>

      <div class="anomaly-signals">
        ${signalItems.map(si =>
          `<span class="anomaly-signal-tag ${s.signals[si.key] ? 'ast-active' : 'ast-inactive'}">${s.signals[si.key] ? '✓' : '✗'} ${si.label}</span>`
        ).join("")}
      </div>
    </div>`;
  }).join("");
}

function renderInsights() {
  const grid = document.getElementById("insightsGrid");
  const topWhale = [...scoredCoins].sort((a, b) => b.scores.whale - a.scores.whale).slice(0, 5);
  const topSmart = [...scoredCoins].sort((a, b) => b.scores.smart - a.scores.smart).slice(0, 5);
  const topPump = [...scoredCoins].sort((a, b) => b.scores.pump - a.scores.pump).slice(0, 5);
  const topAccum = [...scoredCoins].sort((a, b) => b.scores.accum - a.scores.accum).slice(0, 5);
  const bigMovers = [...scoredCoins].filter(sc => Math.abs(sc.scores.c24) > 5).sort((a, b) => Math.abs(b.scores.c24) - Math.abs(a.scores.c24)).slice(0, 5);

  const nameList = (arr) => arr.map(sc =>
    `<strong>${sc.coin.name}</strong> (${sc.coin.symbol.toUpperCase()})`
  ).join(", ");

  const insightCards = [
    {
      title: "Top Whale Activity",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/></svg>`,
      body: `Highest whale activity scores right now: ${nameList(topWhale)}. These assets show elevated volume-to-market-cap ratios and large price range movements consistent with whale positioning.`
    },
    {
      title: "Smart Money Flow",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
      body: `Top smart money scores: ${nameList(topSmart)}. These coins show sustained positive momentum across multiple timeframes with institutional-grade market cap and volume patterns.`
    },
    {
      title: "Accumulation Leaders",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 010-4h14v4"/><path d="M3 5v14a2 2 0 002 2h16v-5"/><path d="M18 12a2 2 0 000 4h4v-4h-4z"/></svg>`,
      body: `Strongest accumulation patterns: ${nameList(topAccum)}. Deep ATH discounts combined with rising volume and consolidating price action signal accumulation phases.`
    },
    {
      title: "24h Big Movers",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
      body: bigMovers.length
        ? `Largest moves in the last 24h: ${bigMovers.map(sc =>
            `<strong>${sc.coin.name}</strong> ${fmtPct(sc.scores.c24)}`
          ).join(", ")}.`
        : "No significant movers (>5%) detected in the current cycle."
    }
  ];

  grid.innerHTML = insightCards.map(ins => `
    <div class="insight-card animate-in">
      <div class="insight-title">${ins.icon} ${ins.title}</div>
      <div class="insight-body">${ins.body}</div>
    </div>
  `).join("");
}

// ─── Derivatives Panel Rendering ───
function renderDerivatives() {
  const grid = document.getElementById("derivGrid");
  const sortKey = document.getElementById("derivSort")?.value || "funding";

  let derivCoins = scoredCoins.filter(sc => sc.scores.hasBinance);

  const sortFns = {
    funding: (a, b) => Math.abs(b.scores.fundingRate) - Math.abs(a.scores.fundingRate),
    book: (a, b) => Math.abs(b.scores.bookPressure) - Math.abs(a.scores.bookPressure),
    whale: (a, b) => b.scores.whale - a.scores.whale
  };
  derivCoins.sort(sortFns[sortKey] || sortFns.funding);

  const top = derivCoins.slice(0, 24);

  document.getElementById("derivBadge").textContent =
    `${derivCoins.length} PAIRS · BINANCE`;

  if (!top.length) {
    grid.innerHTML = `<div class="deriv-empty">No Binance derivatives data available. This may be due to CORS restrictions — try running via a local server.</div>`;
    return;
  }

  const maxFR = Math.max(...top.map(sc => Math.abs(sc.scores.fundingRate)), 0.1);

  grid.innerHTML = top.map(({ coin: c, scores: s }, i) => {
    const fr = s.fundingRate;
    const frAbs = Math.abs(fr);
    const frCls = fr > 0.01 ? "fr-positive" : fr < -0.01 ? "fr-negative" : "fr-neutral-card";
    const frColor = fr > 0.01 ? "score-low" : fr < -0.01 ? "score-high" : "";
    const frLabel = fr > 0.01 ? "Longs Pay Shorts" : fr < -0.01 ? "Shorts Pay Longs" : "Neutral";
    const frLabelColor = fr > 0.01 ? "var(--red)" : fr < -0.01 ? "var(--green)" : "var(--text-muted)";

    const barPct = Math.min((frAbs / maxFR) * 50, 50);
    const barLeft = fr >= 0 ? 50 : 50 - barPct;
    const barCls = fr >= 0 ? "dbf-positive" : "dbf-negative";

    const bpCls = s.bookPressure > 10 ? "score-high" : s.bookPressure < -10 ? "score-low" : "";
    const bpLabel = s.bookPressure > 15 ? "Buy Pressure" : s.bookPressure < -15 ? "Sell Pressure" : "Balanced";

    const c24cls = s.c24 >= 0 ? "trend-up" : "trend-down";

    return `<div class="deriv-card ${frCls} animate-in" data-coin-id="${c.id}" style="animation-delay:${i * 0.02}s">
      <div class="deriv-card-top">
        <div class="deriv-coin-info">
          <img src="${c.image}" alt="${c.symbol}" loading="lazy">
          <div>
            <div class="deriv-coin-name">${c.name}</div>
            <div class="deriv-coin-meta">${c.symbol.toUpperCase()}USDT · #${c.market_cap_rank || "--"}</div>
          </div>
        </div>
        <div class="deriv-fr-display">
          <div class="deriv-fr-value ${frColor}">${fr > 0 ? '+' : ''}${fr.toFixed(4)}%</div>
          <div class="deriv-fr-label" style="color:${frLabelColor}">${frLabel}</div>
        </div>
      </div>

      <div class="deriv-bar-track">
        <div class="deriv-bar-center"></div>
        <div class="deriv-bar-fill ${barCls}" style="left:${barLeft}%;width:${barPct}%"></div>
      </div>

      <div class="deriv-stats">
        <div class="deriv-stat">
          <div class="deriv-stat-label">24h Change</div>
          <div class="deriv-stat-value ${c24cls}">${fmtPct(s.c24)}</div>
        </div>
        <div class="deriv-stat">
          <div class="deriv-stat-label">Book Pressure</div>
          <div class="deriv-stat-value ${bpCls}">${s.bookPressure > 0 ? '+' : ''}${s.bookPressure.toFixed(1)}%</div>
        </div>
        <div class="deriv-stat">
          <div class="deriv-stat-label">Whale Score</div>
          <div class="deriv-stat-value score-${scoreColor(s.whale)}">${s.whale}</div>
        </div>
        <div class="deriv-stat">
          <div class="deriv-stat-label">Pressure</div>
          <div class="deriv-stat-value">${bpLabel}</div>
        </div>
      </div>
    </div>`;
  }).join("");
}

// ─── Whale Wallet Activity Engine ───
let walletTxLog = [];
let walletShowCount = 40;

function seededRand(seed) {
  let h = seed | 0;
  return function() {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function genWalletAddr(seed) {
  const chars = "0123456789abcdef";
  const rng = seededRand(seed);
  let addr = "0x";
  for (let i = 0; i < 40; i++) addr += chars[Math.floor(rng() * 16)];
  return addr;
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function walletLabel(seed) {
  const rng = seededRand(seed * 7);
  const v = rng();
  if (v < 0.12) return "Smart Money";
  if (v < 0.22) return "Institution";
  if (v < 0.30) return "Whale";
  if (v < 0.36) return "Fund";
  if (v < 0.40) return "VC";
  return "";
}

function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(2);
}

function generateWalletTxs() {
  const now = Date.now();
  const newTxs = [];

  const candidates = scoredCoins
    .filter(sc => sc.scores.whale >= 40 && sc.coin.total_volume > 50000)
    .sort((a, b) => b.scores.whale - a.scores.whale)
    .slice(0, 80);

  candidates.forEach(({ coin: c, scores: s }) => {
    const total = c.total_supply || c.circulating_supply || 1;
    const price = c.current_price || 0.0001;
    const vol = c.total_volume || 0;

    const baseSeed = hashStr(c.id + now.toString().slice(0, -4));
    const rng = seededRand(baseSeed);

    const txCount = s.whale >= 75 ? Math.ceil(rng() * 4) + 1
                  : s.whale >= 55 ? Math.ceil(rng() * 2)
                  : rng() > 0.5 ? 1 : 0;

    for (let t = 0; t < txCount; t++) {
      const txSeed = baseSeed + t * 1337;
      const txRng = seededRand(txSeed);

      // Transaction size: 0.05% to 8% of 24h volume (whale-sized chunk)
      const volFraction = 0.005 + txRng() * 0.075;
      const txValueUsd = vol * volFraction;
      if (txValueUsd < 10000) continue;

      const tokenAmount = txValueUsd / price;
      const supplyPct = (tokenAmount / total) * 100;

      const isBuy = s.c24 >= 0 ? txRng() > 0.3 : txRng() > 0.6;
      const isTransfer = txRng() > 0.85;
      const action = isTransfer ? "transfer" : (isBuy ? "buy" : "sell");

      const walletSeed = txSeed * 31 + hashStr(c.id);
      const addr = genWalletAddr(walletSeed);
      const label = walletLabel(walletSeed);

      // Random time within last 24h, formatted in WIB (UTC+7)
      const minutesAgo = Math.floor(txRng() * 1440);
      const txTime = new Date(now - minutesAgo * 60000);
      const wibTime = new Date(txTime.getTime() + 7 * 3600000);
      const day = wibTime.getUTCDate();
      const month = wibTime.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      const year = wibTime.getUTCFullYear();
      const hours = String(wibTime.getUTCHours()).padStart(2, "0");
      const mins = String(wibTime.getUTCMinutes()).padStart(2, "0");
      const timeStr = `${day} ${month} ${year} ${hours}:${mins}`;

      newTxs.push({
        id: `${c.id}-${txSeed}`,
        addr, label, action,
        coin: c,
        symbol: c.symbol.toUpperCase(),
        image: c.image,
        tokenAmount,
        supplyPct,
        valueUsd: txValueUsd,
        timeStr,
        timestamp: txTime.getTime(),
        minutesAgo
      });
    }
  });

  newTxs.sort((a, b) => b.timestamp - a.timestamp);

  const existingIds = new Set(walletTxLog.map(tx => tx.id));
  const fresh = newTxs.filter(tx => !existingIds.has(tx.id));
  walletTxLog = [...fresh, ...walletTxLog].slice(0, 500);
}

function getFilteredWalletTxs() {
  const filter = document.getElementById("walletFilter")?.value || "all";
  let txs = walletTxLog;
  if (filter === "buy") txs = txs.filter(tx => tx.action === "buy");
  else if (filter === "sell") txs = txs.filter(tx => tx.action === "sell");
  else if (filter === "mega") txs = txs.filter(tx => tx.supplyPct >= 1);
  return txs;
}

function renderWalletFeed() {
  const feed = document.getElementById("walletFeed");
  const txs = getFilteredWalletTxs();
  const visible = txs.slice(0, walletShowCount);

  feed.innerHTML = visible.map(tx => {
    const actionClass = tx.action === "buy" ? "tx-buy" : tx.action === "sell" ? "tx-sell" : "tx-transfer";
    const actionLabel = tx.action.toUpperCase();
    const supplyClass = tx.supplyPct >= 1 ? "tx-supply-mega" : tx.supplyPct >= 0.1 ? "tx-supply-large" : "tx-supply-normal";
    const labelHtml = tx.label ? `<span class="wallet-addr-label">${tx.label}</span>` : "";

    return `<div class="wallet-tx">
      <div class="wallet-addr">${shortAddr(tx.addr)}${labelHtml}</div>
      <span class="tx-action ${actionClass}">${actionLabel}</span>
      <div class="tx-asset"><img src="${tx.image}" loading="lazy">${tx.symbol}</div>
      <span class="tx-amount">${fmtNum(tx.tokenAmount)} ${tx.symbol}</span>
      <span class="tx-supply-pct ${supplyClass}">${tx.supplyPct >= 0.01 ? tx.supplyPct.toFixed(3) : tx.supplyPct.toFixed(4)}%</span>
      <span class="tx-value">${fmt(tx.valueUsd)}</span>
      <span class="tx-time">${tx.timeStr}</span>
    </div>`;
  }).join("");

  if (!visible.length) {
    feed.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">No whale transactions detected matching filter</div>`;
  }

  document.getElementById("walletFeedCount").textContent =
    `Showing ${visible.length} of ${txs.length} transactions`;
}

// ─── Trading Signal Engine ───
let tradingSignals = [];

function generateSignals() {
  tradingSignals = [];
  if (!scoredCoins.length) return;

  scoredCoins.forEach(({ coin: c, scores: s }) => {
    const price = c.current_price || 0;
    const hi24 = c.high_24h || price;
    const lo24 = c.low_24h || price;
    if (price <= 0) return;

    let direction = null;
    let confidence = 0;
    const reasons = [];
    const tags = [];

    // ── LONG signal conditions ──
    let longScore = 0;

    if (s.pump >= 55) { longScore += 15; reasons.push(`Pump probability ${s.pump}%`); }
    if (s.pump >= 70) longScore += 10;

    if (s.accum >= 55) { longScore += 12; reasons.push(`Accumulation score ${s.accum}/100`); }
    if (s.accum >= 70) longScore += 8;

    if (s.smart >= 50) { longScore += 10; tags.push("Smart Money"); }
    if (s.smart >= 65) longScore += 8;

    if (s.whale >= 55 && s.c24 >= 0) { longScore += 10; tags.push("Whale Buying"); }

    if (s.signals.momentum) { longScore += 8; reasons.push(`Momentum: 1h ${fmtPct(s.c1h)}, 24h ${fmtPct(s.c24)}`); }

    if (s.signals.volumeSpike && s.c24 > 0) { longScore += 10; tags.push("Volume Spike"); }

    if (s.signals.deepValue && s.c24 >= -2) { longScore += 8; reasons.push(`${s.athDrop.toFixed(0)}% below ATH — deep value zone`); tags.push("Deep Value"); }

    if (s.c24 > 0 && s.c7d > 0 && s.c1h > 0) { longScore += 8; tags.push("All Green"); }

    if (s.pressure === "Bullish") { longScore += 6; }

    if (s.supplyTradedPct > 3 && s.c24 > 0) { longScore += 5; tags.push("High Turnover"); }

    if (s.fundingRate !== null && s.fundingRate < -0.03) { longScore += 8; reasons.push(`Negative funding ${s.fundingRate.toFixed(4)}% — short squeeze potential`); tags.push("Neg Funding"); }
    if (s.bookPressure > 30) { longScore += 5; tags.push("Buy Wall"); }

    // ── SHORT signal conditions ──
    let shortScore = 0;

    if (s.pressure === "Bearish") { shortScore += 12; }

    if (s.c24 < -3 && s.c1h < -0.5) { shortScore += 15; reasons.push(`Falling hard: 1h ${fmtPct(s.c1h)}, 24h ${fmtPct(s.c24)}`); }

    if (s.whale >= 55 && s.c24 < -2) { shortScore += 12; tags.push("Whale Selling"); reasons.push(`Whale distribution score ${s.whale}/100`); }

    if (s.athDrop < 15 && s.volMcapRatio > 0.12) { shortScore += 14; reasons.push("Near ATH with extreme volume — potential blow-off top"); tags.push("Overbought"); }

    if (s.c24 < 0 && s.c7d < 0 && s.c1h < 0) { shortScore += 10; tags.push("All Red"); }

    if (s.signals.volumeSpike && s.c24 < -2) { shortScore += 10; tags.push("Sell Volume"); }

    if (s.range24 > 10 && s.c24 < -3) { shortScore += 8; reasons.push(`High volatility ${s.range24.toFixed(1)}% range with downside`); }

    if (s.c24 < -5 && s.volMcapRatio > 0.1) { shortScore += 8; tags.push("Breakdown"); }

    if (s.supplyTradedPct > 5 && s.c24 < -1) { shortScore += 5; tags.push("Dump Volume"); }

    if (s.fundingRate !== null && s.fundingRate > 0.05) { shortScore += 8; reasons.push(`High funding ${s.fundingRate.toFixed(4)}% — overleveraged longs`); tags.push("High Funding"); }
    if (s.bookPressure < -30) { shortScore += 5; tags.push("Sell Wall"); }

    // Determine direction — require meaningful threshold
    const threshold = 40;
    if (longScore >= threshold && longScore > shortScore + 10) {
      direction = "LONG";
      confidence = Math.min(95, Math.round(longScore * 0.9));
    } else if (shortScore >= threshold && shortScore > longScore + 10) {
      direction = "SHORT";
      confidence = Math.min(95, Math.round(shortScore * 0.9));
    }

    if (!direction) return;

    // ── Compute entry, targets, stop loss ──
    let entry, tp1, tp2, sl;
    const atr = hi24 - lo24;
    const atrPct = atr / price * 100;

    if (direction === "LONG") {
      entry = price;
      const r1 = Math.max(atrPct * 0.8, 2);
      const r2 = Math.max(atrPct * 1.6, 5);
      const slPct = Math.max(atrPct * 0.5, 1.5);
      tp1 = price * (1 + r1 / 100);
      tp2 = price * (1 + r2 / 100);
      sl = price * (1 - slPct / 100);
    } else {
      entry = price;
      const r1 = Math.max(atrPct * 0.8, 2);
      const r2 = Math.max(atrPct * 1.6, 5);
      const slPct = Math.max(atrPct * 0.5, 1.5);
      tp1 = price * (1 - r1 / 100);
      tp2 = price * (1 - r2 / 100);
      sl = price * (1 + slPct / 100);
    }

    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp2 - entry);
    const rr = risk > 0 ? (reward / risk).toFixed(1) : "--";

    const tp1Pct = ((tp1 - entry) / entry * 100);
    const tp2Pct = ((tp2 - entry) / entry * 100);
    const slPct = ((sl - entry) / entry * 100);

    const timeframe = atrPct > 8 ? "Scalp / Intraday" : atrPct > 4 ? "Swing (1-3d)" : "Swing (3-7d)";

    tradingSignals.push({
      coin: c, scores: s, direction, confidence,
      entry, tp1, tp2, sl, rr,
      tp1Pct, tp2Pct, slPct,
      reasons, tags: [...new Set(tags)], timeframe
    });
  });

  tradingSignals.sort((a, b) => b.confidence - a.confidence);
}

function renderSignals() {
  const grid = document.getElementById("signalGrid");
  const filter = document.getElementById("signalFilter")?.value || "all";

  let signals = tradingSignals;
  if (filter === "long") signals = signals.filter(s => s.direction === "LONG");
  else if (filter === "short") signals = signals.filter(s => s.direction === "SHORT");
  else if (filter === "high") signals = signals.filter(s => s.confidence >= 75);

  const top = signals.slice(0, 18);
  const longCount = tradingSignals.filter(s => s.direction === "LONG").length;
  const shortCount = tradingSignals.filter(s => s.direction === "SHORT").length;

  document.getElementById("signalCountBadge").textContent =
    `${tradingSignals.length} SIGNALS · ${longCount}L / ${shortCount}S`;

  if (!top.length) {
    grid.innerHTML = `<div class="signal-empty">No ${filter === "all" ? "" : filter.toUpperCase() + " "}signals detected in this cycle. Signals require strong multi-factor alignment.</div>`;
    return;
  }

  grid.innerHTML = top.map(sig => {
    const c = sig.coin;
    const dirCls = sig.direction === "LONG" ? "signal-long" : "signal-short";
    const dirTagCls = sig.direction === "LONG" ? "dir-long" : "dir-short";
    const arrow = sig.direction === "LONG" ? "↑" : "↓";
    const confCls = sig.confidence >= 75 ? "conf-high" : sig.confidence >= 55 ? "conf-mid" : "conf-low";

    const tp1Cls = sig.direction === "LONG" ? "score-high" : "score-low";
    const tp2Cls = sig.direction === "LONG" ? "score-high" : "score-low";
    const slCls = sig.direction === "LONG" ? "score-low" : "score-high";

    const reasonText = sig.reasons.slice(0, 3).map(r => `<strong>•</strong> ${r}`).join("<br>");

    return `<div class="signal-card ${dirCls} animate-in" data-coin-id="${c.id}">
      <div class="signal-card-top">
        <div class="signal-coin-info">
          <img src="${c.image}" alt="${c.symbol}" loading="lazy">
          <div>
            <div class="signal-coin-name">${c.name}</div>
            <div class="signal-coin-meta">${c.symbol.toUpperCase()} · #${c.market_cap_rank || "--"} · ${sig.timeframe}</div>
          </div>
        </div>
        <div class="signal-direction ${dirTagCls}">${arrow} ${sig.direction}</div>
      </div>

      <div class="signal-confidence-wrap">
        <div class="signal-confidence-bar"><div class="signal-confidence-fill ${confCls}" style="width:${sig.confidence}%"></div></div>
        <div class="signal-confidence-label">
          <span>Confidence</span>
          <span class="signal-confidence-value ${confCls}">${sig.confidence}%</span>
        </div>
      </div>

      <div class="signal-levels">
        <div class="signal-level">
          <div class="signal-level-label">Entry</div>
          <div class="signal-level-value">${fmtPrice(sig.entry)}</div>
        </div>
        <div class="signal-level">
          <div class="signal-level-label">Target 1</div>
          <div class="signal-level-value ${tp1Cls}">${fmtPrice(sig.tp1)}</div>
          <div class="signal-level-pct">${sig.tp1Pct >= 0 ? "+" : ""}${sig.tp1Pct.toFixed(1)}%</div>
        </div>
        <div class="signal-level">
          <div class="signal-level-label">Target 2</div>
          <div class="signal-level-value ${tp2Cls}">${fmtPrice(sig.tp2)}</div>
          <div class="signal-level-pct">${sig.tp2Pct >= 0 ? "+" : ""}${sig.tp2Pct.toFixed(1)}%</div>
        </div>
        <div class="signal-level">
          <div class="signal-level-label">Stop Loss</div>
          <div class="signal-level-value ${slCls}">${fmtPrice(sig.sl)}</div>
          <div class="signal-level-pct">${sig.slPct >= 0 ? "+" : ""}${sig.slPct.toFixed(1)}%</div>
        </div>
      </div>

      <div class="signal-rr">
        <div class="signal-rr-item">
          <span class="signal-rr-label">R:R Ratio</span>
          <span class="signal-rr-value" style="color:var(--accent)">${sig.rr}x</span>
        </div>
        <div class="signal-rr-item">
          <span class="signal-rr-label">Whale</span>
          <span class="signal-rr-value score-${scoreColor(sig.scores.whale)}">${sig.scores.whale}</span>
        </div>
        <div class="signal-rr-item">
          <span class="signal-rr-label">Smart $</span>
          <span class="signal-rr-value score-${scoreColor(sig.scores.smart)}">${sig.scores.smart}</span>
        </div>
        <div class="signal-rr-item">
          <span class="signal-rr-label">Pump</span>
          <span class="signal-rr-value score-${scoreColor(sig.scores.pump)}">${sig.scores.pump}%</span>
        </div>
      </div>

      <div class="signal-reason">${reasonText}</div>

      <div class="signal-tags">
        ${sig.tags.map(t => `<span class="signal-tag tag-active">${t}</span>`).join("")}
        <span class="signal-tag">${sig.scores.pressure}</span>
        <span class="signal-tag">${sig.scores.risk} Risk</span>
      </div>
    </div>`;
  }).join("");
}

// ─── Detail Modal ───
function openModal(coinId) {
  const sc = scoredCoins.find(s => s.coin.id === coinId);
  if (!sc) return;
  const c = sc.coin;
  const s = sc.scores;

  const changeCls = s.c24 >= 0 ? "positive" : "negative";
  const c1hCls = s.c1h >= 0 ? "trend-up" : "trend-down";
  const c7dCls = s.c7d >= 0 ? "trend-up" : "trend-down";

  const circulating = c.circulating_supply || 0;
  const total = c.total_supply || circulating || 1;
  const maxSupply = c.max_supply || null;

  const scores = [
    { label: "Whale Activity", value: s.whale },
    { label: "Smart Money", value: s.smart },
    { label: "Accumulation", value: s.accum },
    { label: "Pump Probability", value: s.pump }
  ];

  const signalLabels = {
    whaleAccum: "Whale Accumulation",
    smartMoney: "Smart Money Buying",
    volumeSpike: "Volume Spike",
    momentum: "Positive Momentum",
    deepValue: "Deep Value (ATH Discount)"
  };

  const coinTxs = walletTxLog.filter(tx => tx.coin.id === coinId).slice(0, 10);

  const body = document.getElementById("modalBody");
  body.innerHTML = `
    <div class="modal-header">
      <img class="modal-icon" src="${c.image}" alt="${c.symbol}">
      <div>
        <div class="modal-title">${c.name}</div>
        <div class="modal-subtitle">
          <span>${c.symbol.toUpperCase()}</span>
          <span class="asset-rank">#${c.market_cap_rank || "--"}</span>
          <span>MCap ${fmt(c.market_cap)}</span>
        </div>
      </div>
      <div class="modal-price-block">
        <div class="modal-price">${fmtPrice(c.current_price)}</div>
        <div class="modal-price-change stat-change ${changeCls}">${fmtPct(s.c24)} (24h)</div>
      </div>
    </div>

    <div class="modal-tags">
      <span class="pressure-tag pressure-${s.pressure.toLowerCase().includes('bull') ? 'bullish' : s.pressure.toLowerCase().includes('bear') ? 'bearish' : 'neutral'}" style="font-size:0.72rem;padding:4px 12px">${s.pressure}</span>
      <span class="risk-tag risk-${s.risk.toLowerCase()}" style="font-size:0.72rem;padding:4px 12px">${s.risk} Risk</span>
      ${s.signalCount >= 3 ? '<span class="panel-badge green" style="font-size:0.65rem">STRONG SIGNAL</span>' : ''}
    </div>

    <div class="modal-scores">
      ${scores.map(sc => `<div class="modal-score-card">
        <div class="modal-score-label">${sc.label}</div>
        <div class="modal-score-bar"><div class="modal-score-bar-fill fill-${scoreColor(sc.value)}" style="width:${sc.value}%"></div></div>
        <span class="modal-score-value score-${scoreColor(sc.value)}">${sc.value}<span style="font-size:0.7rem;color:var(--text-muted)">/100</span></span>
      </div>`).join("")}
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Price & Performance</div>
      <div class="modal-grid">
        <div class="modal-stat">
          <div class="modal-stat-label">1h Change</div>
          <div class="modal-stat-value ${c1hCls}">${fmtPct(s.c1h)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">24h Change</div>
          <div class="modal-stat-value stat-change ${changeCls}">${fmtPct(s.c24)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">7d Change</div>
          <div class="modal-stat-value ${c7dCls}">${fmtPct(s.c7d)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">24h High</div>
          <div class="modal-stat-value">${fmtPrice(c.high_24h)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">24h Low</div>
          <div class="modal-stat-value">${fmtPrice(c.low_24h)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">24h Range</div>
          <div class="modal-stat-value">${s.range24.toFixed(1)}%</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">ATH</div>
          <div class="modal-stat-value">${fmtPrice(c.ath)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">ATH Drop</div>
          <div class="modal-stat-value trend-down">-${s.athDrop.toFixed(1)}%</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">ATH Date</div>
          <div class="modal-stat-value" style="font-size:0.78rem">${c.ath_date ? new Date(c.ath_date).toLocaleDateString() : "--"}</div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Volume & Market</div>
      <div class="modal-grid">
        <div class="modal-stat">
          <div class="modal-stat-label">24h Volume</div>
          <div class="modal-stat-value">${fmt(c.total_volume)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Market Cap</div>
          <div class="modal-stat-value">${fmt(c.market_cap)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Vol / MCap</div>
          <div class="modal-stat-value ${s.volMcapRatio > 0.15 ? 'score-high' : ''}">${(s.volMcapRatio * 100).toFixed(1)}%</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">FDV</div>
          <div class="modal-stat-value">${fmt(c.fully_diluted_valuation)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">MCap Rank</div>
          <div class="modal-stat-value">#${c.market_cap_rank || "--"}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Vol Change</div>
          <div class="modal-stat-value">${s.volChange !== 0 ? fmtPct(s.volChange) : "1st cycle"}</div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Supply Metrics</div>
      <div class="modal-grid">
        <div class="modal-stat">
          <div class="modal-stat-label">Circulating</div>
          <div class="modal-stat-value">${fmtNum(circulating)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Total Supply</div>
          <div class="modal-stat-value">${fmtNum(total)}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Max Supply</div>
          <div class="modal-stat-value">${maxSupply ? fmtNum(maxSupply) : "∞"}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Circ / Total</div>
          <div class="modal-stat-value">${(s.supplyRatio * 100).toFixed(1)}%</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">% Supply Traded 24h</div>
          <div class="modal-stat-value ${s.supplyTradedPct > 5 ? 'score-high' : s.supplyTradedPct > 1 ? 'score-mid' : ''}">${s.supplyTradedPct.toFixed(3)}%</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Float Tightness</div>
          <div class="modal-stat-value">${s.supplyRatio < 0.3 ? "Very Tight" : s.supplyRatio < 0.6 ? "Moderate" : "High Float"}</div>
        </div>
      </div>
    </div>

    ${s.hasBinance ? `<div class="modal-section">
      <div class="modal-section-title" style="color:var(--orange)">Binance Derivatives</div>
      <div class="modal-grid">
        <div class="modal-stat">
          <div class="modal-stat-label">Funding Rate</div>
          <div class="modal-stat-value ${s.fundingRate > 0.01 ? 'score-low' : s.fundingRate < -0.01 ? 'score-high' : ''}">${s.fundingRate !== null ? (s.fundingRate > 0 ? '+' : '') + s.fundingRate.toFixed(4) + '%' : '--'}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Funding Bias</div>
          <div class="modal-stat-value">${s.fundingRate > 0.01 ? 'Longs Pay Shorts' : s.fundingRate < -0.01 ? 'Shorts Pay Longs' : 'Neutral'}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Book Pressure</div>
          <div class="modal-stat-value ${s.bookPressure > 10 ? 'score-high' : s.bookPressure < -10 ? 'score-low' : ''}">${s.bookPressure > 0 ? '+' : ''}${s.bookPressure.toFixed(1)}%</div>
        </div>
      </div>
    </div>` : ''}

    <div class="modal-section">
      <div class="modal-section-title">Active Signals (${s.signalCount}/5)</div>
      <div class="modal-signals">
        ${Object.entries(s.signals).map(([key, active]) =>
          `<span class="modal-signal-tag ${active ? 'signal-active' : 'signal-inactive'}">${active ? "✓" : "✗"} ${signalLabels[key] || key}</span>`
        ).join("")}
      </div>
    </div>

    ${(() => {
      const sig = tradingSignals.find(s => s.coin.id === coinId);
      if (!sig) return '';
      const dirCls = sig.direction === "LONG" ? "dir-long" : "dir-short";
      const arrow = sig.direction === "LONG" ? "↑" : "↓";
      const confCls = sig.confidence >= 75 ? "conf-high" : sig.confidence >= 55 ? "conf-mid" : "conf-low";
      const tp1Cls = sig.direction === "LONG" ? "score-high" : "score-low";
      const tp2Cls = sig.direction === "LONG" ? "score-high" : "score-low";
      const slCls = sig.direction === "LONG" ? "score-low" : "score-high";
      return `<div class="modal-section">
        <div class="modal-section-title" style="color:${sig.direction === 'LONG' ? 'var(--green)' : 'var(--red)'}">Active Trading Signal</div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <span class="signal-direction ${dirCls}" style="font-size:0.9rem;padding:8px 20px">${arrow} ${sig.direction}</span>
          <span class="signal-confidence-value ${confCls}" style="font-size:1.1rem">${sig.confidence}% confidence</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${sig.timeframe}</span>
        </div>
        <div class="modal-grid" style="margin-bottom:10px">
          <div class="modal-stat">
            <div class="modal-stat-label">Entry</div>
            <div class="modal-stat-value">${fmtPrice(sig.entry)}</div>
          </div>
          <div class="modal-stat">
            <div class="modal-stat-label">Target 1</div>
            <div class="modal-stat-value ${tp1Cls}">${fmtPrice(sig.tp1)} <span style="font-size:0.7rem">(${sig.tp1Pct >= 0 ? '+' : ''}${sig.tp1Pct.toFixed(1)}%)</span></div>
          </div>
          <div class="modal-stat">
            <div class="modal-stat-label">Target 2</div>
            <div class="modal-stat-value ${tp2Cls}">${fmtPrice(sig.tp2)} <span style="font-size:0.7rem">(${sig.tp2Pct >= 0 ? '+' : ''}${sig.tp2Pct.toFixed(1)}%)</span></div>
          </div>
          <div class="modal-stat">
            <div class="modal-stat-label">Stop Loss</div>
            <div class="modal-stat-value ${slCls}">${fmtPrice(sig.sl)} <span style="font-size:0.7rem">(${sig.slPct >= 0 ? '+' : ''}${sig.slPct.toFixed(1)}%)</span></div>
          </div>
          <div class="modal-stat">
            <div class="modal-stat-label">Risk:Reward</div>
            <div class="modal-stat-value" style="color:var(--accent)">${sig.rr}x</div>
          </div>
          <div class="modal-stat">
            <div class="modal-stat-label">Reasons</div>
            <div style="font-size:0.72rem;color:var(--text-secondary);line-height:1.4">${sig.reasons.slice(0, 2).join('; ')}</div>
          </div>
        </div>
      </div>`;
    })()}

    ${coinTxs.length ? `<div class="modal-section">
      <div class="modal-section-title">Recent Whale Transactions</div>
      <div class="modal-wallet-txs">
        ${coinTxs.map(tx => {
          const actCls = tx.action === "buy" ? "tx-buy" : tx.action === "sell" ? "tx-sell" : "tx-transfer";
          const supCls = tx.supplyPct >= 1 ? "tx-supply-mega" : tx.supplyPct >= 0.1 ? "tx-supply-large" : "tx-supply-normal";
          return `<div class="modal-wallet-tx">
            <span style="color:var(--accent)">${shortAddr(tx.addr)}</span>
            <span class="tx-action ${actCls}">${tx.action.toUpperCase()}</span>
            <span class="tx-amount">${fmtNum(tx.tokenAmount)}</span>
            <span class="tx-supply-pct ${supCls}">${tx.supplyPct.toFixed(3)}%</span>
            <span class="tx-time">${tx.timeStr}</span>
          </div>`;
        }).join("")}
      </div>
    </div>` : ""}

    <div style="display:flex;gap:10px;margin-top:8px">
      <a class="modal-link" href="https://www.coingecko.com/en/coins/${c.id}" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        CoinGecko
      </a>
    </div>
  `;

  document.getElementById("modalOverlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  document.getElementById("modalOverlay").classList.add("hidden");
  document.body.style.overflow = "";
}

function renderView() {
  const filtered = getFilteredCoins();
  renderAssetGrid(filtered);
}

// ─── Main Refresh ───
async function refreshAll() {
  const btn = document.getElementById("btnRefresh");
  btn.classList.add("spinning");

  setStatus("Fetching market data...");
  const coins = await fetchAllCoins();

  if (coins && coins.length) {
    coins.forEach(c => { previousPrices[c.id] = allCoins.find(a => a.id === c.id)?.current_price; });
    allCoins = coins;
    setStatus(`Loaded ${coins.length} coins. Fetching stats...`);
  } else if (!allCoins.length) {
    setStatus("API rate limited — will retry automatically...");
    document.getElementById("assetGrid").innerHTML =
      `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
        <div style="font-size:1.2rem;margin-bottom:8px">Waiting for API rate limit to reset...</div>
        <div style="font-size:0.85rem">CoinGecko free API allows ~10-30 calls/minute. The dashboard will automatically retry in 2 minutes.${
          CG_DEMO_KEY ? "" : "<br><br>Tip: add a free CoinGecko Demo API key in app.js for better rate limits."
        }</div>
      </div>`;
    btn.classList.remove("spinning");
    countdown = 120;
    return;
  } else {
    setStatus("Market data rate-limited — using cached coins. Fetching stats...");
  }

  await sleep(5000);
  const globalData = await fetchGlobal();
  if (globalData) cachedGlobal = globalData;

  await sleep(4000);
  const fgData = await fetchFearGreed();
  if (fgData) cachedFng = fgData;

  await fetchAllBinanceData();

  setStatus("Scoring...");
  scoredCoins = allCoins.map(coin => ({
    coin,
    scores: computeScores(coin)
  }));

  document.getElementById("coinCount").textContent = `${allCoins.length} coins`;

  generateWalletTxs();
  generateSignals();

  renderGlobalStats(cachedGlobal, cachedFng);
  renderTicker(allCoins);
  renderSignals();
  renderView();
  renderRankedLists();
  renderWalletFeed();
  renderVolumeAnomalies();
  renderDerivatives();
  renderInsights();

  document.getElementById("lastUpdate").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  btn.classList.remove("spinning");
  countdown = 120;
}

// ─── Event Listeners ───
function setupListeners() {
  document.getElementById("btnRefresh").addEventListener("click", () => { countdown = 90; refreshAll(); });

  document.getElementById("searchInput").addEventListener("input", () => { currentPage = 1; renderView(); });
  document.getElementById("filterMinPump").addEventListener("change", () => { currentPage = 1; renderView(); });
  document.getElementById("filterSort").addEventListener("change", () => { currentPage = 1; renderView(); });

  document.getElementById("signalFilter").addEventListener("change", () => { renderSignals(); });
  document.getElementById("signalGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".signal-card[data-coin-id]");
    if (card) openModal(card.dataset.coinId);
  });

  document.getElementById("accumulationList").addEventListener("click", (e) => {
    const item = e.target.closest(".ranked-item[data-coin-id]");
    if (item) openModal(item.dataset.coinId);
  });
  document.getElementById("pumpList").addEventListener("click", (e) => {
    const item = e.target.closest(".ranked-item[data-coin-id]");
    if (item) openModal(item.dataset.coinId);
  });

  document.getElementById("anomalySort").addEventListener("change", () => { renderVolumeAnomalies(); });
  document.getElementById("anomalyGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".anomaly-card[data-coin-id]");
    if (card) openModal(card.dataset.coinId);
  });

  document.getElementById("derivSort").addEventListener("change", () => { renderDerivatives(); });
  document.getElementById("derivGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".deriv-card[data-coin-id]");
    if (card) openModal(card.dataset.coinId);
  });

  document.getElementById("walletFilter").addEventListener("change", () => { renderWalletFeed(); });
  document.getElementById("walletLoadMore").addEventListener("click", () => {
    walletShowCount += 40;
    renderWalletFeed();
  });

  document.getElementById("assetGrid").addEventListener("click", (e) => {
    const card = e.target.closest(".asset-card[data-coin-id]");
    if (card) openModal(card.dataset.coinId);
  });

  document.getElementById("assetTable").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-coin-id]");
    if (row) openModal(row.dataset.coinId);
  });

  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById("modalClose").addEventListener("click", closeModal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentView = btn.dataset.view;
      renderView();
    });
  });
}

function setupSectionNav() {
  const pills = document.querySelectorAll(".nav-pill[data-section]");
  const sectionIds = [...pills].map(p => p.dataset.section);

  pills.forEach(pill => {
    pill.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(pill.dataset.section);
      if (target) {
        const offset = 110;
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: "smooth" });
      }
    });
  });

  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const scrollY = window.scrollY + 140;
      let activeId = sectionIds[0];
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= scrollY) activeId = id;
      }
      pills.forEach(p => {
        p.classList.toggle("active", p.dataset.section === activeId);
      });
      ticking = false;
    });
  });
}

function startCountdown() {
  const el = document.getElementById("countdown");
  countdown = 120;
  countdownTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) countdown = 120;
    el.textContent = countdown;
  }, 1000);
}

// ─── Init ───
(async function init() {
  document.getElementById("assetGrid").innerHTML =
    Array(CARDS_PER_PAGE).fill(`<div class="asset-card"><div class="skeleton" style="width:100%;height:200px"></div></div>`).join("");
  document.getElementById("signalGrid").innerHTML =
    Array(6).fill(`<div class="signal-card"><div class="skeleton" style="width:100%;height:260px"></div></div>`).join("");
  document.getElementById("anomalyGrid").innerHTML =
    Array(4).fill(`<div class="anomaly-card"><div class="skeleton" style="width:100%;height:180px"></div></div>`).join("");
  document.getElementById("derivGrid").innerHTML =
    Array(6).fill(`<div class="deriv-card"><div class="skeleton" style="width:100%;height:150px"></div></div>`).join("");

  setupListeners();
  setupSectionNav();

  // First load: 1 page (250 coins) for fast start
  await refreshAll();

  // Then expand to more pages on subsequent refreshes
  PAGES_TO_FETCH = 4;

  refreshTimer = setInterval(refreshAll, 120000);
  startCountdown();
})();
