# Stock Watch

A lightweight real-time stock watchlist that installs like a desktop app. It doesn't need an API key, an account or a server: it's plain HTML/CSS/JS hosted on GitHub Pages.

**Open / install:** https://persei80.github.io/stock-watch/

- Live prices refresh every 3 seconds while a market is open (real-time for US stocks)
- Pre-market and after-hours prices
- Add stocks by ticker or company name, including non-US listings (e.g. `ASML-NL`, `2330-TW`); remove them with one click (and undo)
- Day range, open, previous close, and a live intraday sparkline for each stock
- Sort by order added, top gainers, top losers, or ticker
- English and Hebrew (RTL) interface, light and dark theme, works on phones
- The watchlist is saved on the device (`localStorage`)

Default watchlist: NVDA, ASML, AMD, INTC, ORCL, FSLR, ENPH, JKS, SHLS, PLUG, ONON, IONQ, QBTS, RGTI.

## Install on a computer

1. Open the link above in Chrome or Edge.
2. Click **Install app** in the top bar (or the install icon at the right end of the address bar).
3. The app gets its own window and a desktop / Start menu shortcut. Updates arrive automatically.

On iPhone: Safari → Share → **Add to Home Screen**. On Android: Chrome menu → **Install app**.

## Data source

Quotes and symbol search come from CNBC's public quote endpoints (`quote.cnbc.com`, `symlookup.cnbc.com`), which allow browser requests without a key. They are unofficial, so they could change without notice. Non-US exchanges are usually delayed and are marked as such in the app.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup and the stock card template |
| `style.css` | Styles (light/dark, RTL, mobile) |
| `i18n.js` | English and Hebrew UI strings |
| `app.js` | Quote polling, search, watchlist logic |
| `manifest.webmanifest`, `sw.js`, `icons/` | Make the site installable as an app |

---

## בעברית

אפליקציה למעקב אחר מניות בזמן אמת. אין צורך במפתח, בחשבון או בסיסמה.

1. פותחים את הקישור ב-Chrome או ב-Edge: https://persei80.github.io/stock-watch/
2. לוחצים על **התקנת האפליקציה** בסרגל העליון.
3. האפליקציה נפתחת בחלון משלה ומקבלת קיצור דרך בשולחן העבודה.

אפשר להוסיף ולהסיר מניות, והרשימה נשמרת במחשב.
