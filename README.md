# Whale Intelligence Dashboard

Real-time crypto market intelligence dashboard that detects whale activity, smart money flows, and generates actionable trading signals — all from live CoinGecko data with zero hardcoded scores.

![HTML](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![CoinGecko](https://img.shields.io/badge/CoinGecko_API-8DC63F?style=flat&logo=coingecko&logoColor=white)

## Features

### Dynamic Scoring Engine
Every score is computed algorithmically from live market data — nothing is hardcoded.

- **Whale Activity Score** — Volume/MCap intensity, 24h range, ATH distance, volume spikes
- **Smart Money Score** — Multi-timeframe momentum, MCap rank, supply ratio, institutional patterns
- **Accumulation Score** — ATH discount, volume buildup, price consolidation, low float detection
- **Pump Probability** — Volume spikes + momentum + accumulation convergence

### Trading Signals (LONG / SHORT)
Algorithmically generated signals with:
- Direction (LONG or SHORT) based on multi-factor scoring
- Confidence level (0–95%) reflecting factor alignment
- Entry price, Target 1, Target 2, and Stop Loss (ATR-based)
- Risk:Reward ratio
- Reasoning and active signal tags

### Whale Wallet Activity
Simulated real-time feed of whale transactions derived from on-chain volume data:
- Wallet addresses with labels (Smart Money, Institution, Whale, Fund, VC)
- Buy/Sell/Transfer actions with token amounts
- % of total supply moved per transaction
- Timestamps in WIB (UTC+7)

### Volume Anomaly Detection
Card-based view of coins with abnormally high volume relative to market cap:
- Intensity gauge bars with threshold markers
- EXTREME / HIGH / MODERATE severity levels
- Signal flag indicators per coin

### Additional Panels
- **Global Stats** — Total market cap, 24h volume, BTC dominance, Fear & Greed index, active signal count
- **Top Accumulation Coins** — Top 15 by accumulation score
- **Early Pump Candidates** — Top 15 by pump probability
- **Live Market Insights** — Auto-generated summary of whale activity, smart money, accumulation leaders, big movers
- **Detail Modal** — Click any coin for a full breakdown: scores, price performance, volume, supply metrics, active signals, trading signal, whale transactions, CoinGecko link

### UX
- Dark theme with responsive design (desktop, tablet, mobile)
- Sticky header with live market ticker
- Section quick-nav bar with scroll-spy
- Grid / Table view toggle for the asset list
- Search, filter (pump threshold), and sort controls
- Pagination for large datasets
- Skeleton loading states
- Auto-refresh every 90 seconds with countdown

## Getting Started

No build step required. This is a static HTML/CSS/JS project.

### Option 1: Open directly
```
open index.html
```

### Option 2: Local server (recommended for CORS)
```bash
# Python
python3 -m http.server 8000

# Node
npx serve .
```

Then open `http://localhost:8000` in your browser.

## Project Structure

```
├── index.html    # Dashboard layout + modal + section nav
├── style.css     # Dark theme styles, responsive breakpoints
├── app.js        # Scoring engine, API layer, signal generation, rendering
└── README.md
```

## Data Sources

| Source | Endpoint | Data |
|--------|----------|------|
| [CoinGecko](https://www.coingecko.com) | `/coins/markets` | Price, volume, MCap, ATH, supply |
| [CoinGecko](https://www.coingecko.com) | `/global` | Total market cap, BTC dominance |
| [Alternative.me](https://alternative.me) | `/fng` | Fear & Greed Index |

The free CoinGecko API allows ~10–30 calls/minute. The dashboard handles rate limiting with exponential backoff retry logic and sequential API calls.

## How Scores Work

All scores range from 0–100 and are derived purely from live data:

| Score | Key Inputs |
|-------|-----------|
| Whale Activity | Vol/MCap ratio, 24h range, ATH distance, volume spikes, price movement |
| Smart Money | MCap rank, multi-timeframe momentum, supply ratio, steady climb detection |
| Accumulation | ATH discount depth, volume buildup, price consolidation, low float |
| Pump Probability | Vol/MCap spike, 1h/24h momentum, ATH distance, volume change, accumulation |

**Trading signals** fire when either the LONG or SHORT factor score exceeds 40 and is at least 10 points ahead of the opposite direction.

## Disclaimer

This dashboard is for **educational and informational purposes only**. It is not financial advice. All scores and signals are algorithmically generated from public market data and should not be used as the sole basis for trading decisions. Always do your own research (DYOR).

## License

MIT
