# Stock Watch

A lightweight real-time stock watchlist that runs entirely in the browser. No build step, no server, so it can be hosted on GitHub Pages.

- Live prices via the [Finnhub](https://finnhub.io) WebSocket trade stream, plus a quote refresh every minute
- Add stocks by ticker or company name (with search suggestions), remove them with one click (and undo)
- Day range, open, previous close, and a live intraday sparkline for each stock
- Sort by order added, top gainers, top losers, or ticker
- English and Hebrew (RTL) interface, light and dark theme, works on phones
- The watchlist and the API key are saved in the browser (`localStorage`). Nothing is sent anywhere except Finnhub

Default watchlist: NVDA, ASML, AMD, INTC, ORCL, FSLR, ENPH, JKS, SHLS, PLUG, ONON, IONQ, QBTS, RGTI.

## Getting started

1. Get a free API key at [finnhub.io/register](https://finnhub.io/register).
2. Open the app and paste the key when asked. You can change it later under the gear icon.

The free Finnhub plan covers US-listed stocks (ASML is tracked through its NASDAQ listing). Live trades arrive only while the US market is open; outside market hours the app shows the last price.

## Run locally

Any static file server works, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

In the repository, go to **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`, and save. The site will be published at `https://<user>.github.io/<repo>/`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup and the stock card template |
| `style.css` | Styles (light/dark, RTL, mobile) |
| `i18n.js` | English and Hebrew UI strings |
| `app.js` | Data fetching, live WebSocket updates, watchlist logic |

---

## בעברית

אפליקציה למעקב אחר מניות בזמן אמת, שרצה כולה בדפדפן. כדי להתחיל צריך מפתח API חינמי מ-[Finnhub](https://finnhub.io/register): מדביקים אותו באפליקציה, ומשם אפשר להוסיף ולהסיר מניות. רשימת המניות והמפתח נשמרים רק בדפדפן.
