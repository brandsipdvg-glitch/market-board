# Market Board

A single live dashboard showing the current values from three sites together:

- **SGX Nifty** — https://sgxnifty.org/?shem=aimgspe
- **NIFTY 50 (NSE)** — https://www.nseindia.in/index-tracker/NIFTY%2050
- **India VIX (Moneycontrol)** — https://www.moneycontrol.com/indian-indices/india-vix-36.html?shem=aimgspe

## Run

```bash
npm start
```

Open **http://localhost:3000**.

## How it stays live

NSE and Moneycontrol block their pages from being embedded in an iframe, so the dashboard does not rely on iframes. `server.mjs` keeps one headless browser page open per source. A change detector watches each quote element in the source page; the moment that element changes, Node reads the new value and pushes it to the dashboard over Server-Sent Events. A 0.5s poll runs only as a safety net in case a site updates in a way the detector misses.

Some source sites pause their own feed when a visitor is idle — SGX Nifty stops updating after 10 minutes without mouse/keyboard activity. The backend sends each page a harmless activity signal every 30 seconds so the source keeps refreshing itself and the dashboard never freezes on an old value.

Use the **Auto refresh** control to change the safety poll (0.5s, 2s, 5s, 15s) or turn it off. **Refresh now** forces an immediate read of all three sources.

The dashboard cannot change a value before the source website changes it — the source site's own update cadence is the limiting factor. Outside market hours values are naturally static.

## Configuration

- `PORT` — server port (default `3000`)
- `POLL_MS` — default poll interval in milliseconds (default `500`; minimum `250`)
- `CHROME_PATH` — path to a Chromium/Chrome executable if auto-detection fails

## View on mobile (no account needed)

This dashboard needs a running browser on the machine that reads the three sites, so the simplest working method is a Cloudflare tunnel from your Mac.

```bash
./start-mobile.sh
```

The script starts the dashboard (if it is not already running) and then prints a public `https://....trycloudflare.com` URL. Open that URL on your phone.

Important:
- The Mac must stay awake and online while you view the dashboard.
- A quick-tunnel URL is temporary. Every time you restart the script you get a new URL, so send the new one to your phone.
- Press `Ctrl+C` in the terminal to stop the tunnel.

If `cloudflared` is missing, install it first:

```bash
brew install cloudflare/cloudflare/cloudflared
```

## Deploy to Koyeb (Mac can be off)

This is the easiest way to get a public URL that works without your Mac. The repo includes a `Dockerfile`, and the app is tuned for a small free instance (ads, images and fonts in source pages are blocked to keep memory low).

1. Sign up at https://app.koyeb.com/auth/signup with GitHub.
2. Create a new Service → **Deploy from GitHub** → select `brandsipdvg-glitch/market-board`.
3. Builder: **Dockerfile** (detected automatically). Instance: **Free**. Port: **10000**.
4. Add env vars `PORT=10000` and `POLL_MS=500` (the Dockerfile sets these already).
5. Deploy, then open the generated `https://....koyeb.app` URL on your phone.

If a source blocks Koyeb's cloud IP, restart the service or use a host with a dedicated IP.

## Deploy to Render (alternative)

The repo also includes a `render.yaml` blueprint. On Render, choose **New → Blueprint**, select the repository, and click **Apply**. The free plan may sleep after inactivity.

## Notes

- Each card links to its original site for full interactive detail.
- If a source fails to load, the dashboard keeps the last value, marks it as stale/error, and retries automatically.
