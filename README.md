# Grainkeeper Shop Desk

A mobile-first shop ledger built around the daily work of a small rice and grocery shop: record a sale in a few taps, keep track of full bags and loose units, record unpaid sales and supplier purchases, and see the closing position clearly. The app shell is a React + Tailwind PWA with an offline-friendly local mode.

## Current state

- The React interface and responsive layouts are built.
- Sales, payment status, customer balances, purchases, supplier balances, stock, and printable receipts work in local browser storage.
- Rice loose-unit sales deduct 0.25 of a 10 kg bag for each 2.5 kg unit. The displayed standard prices start at GH₵1,200 per 10 kg bag and GH₵320 per 2.5 kg unit; attendants can enter the negotiated price (for example GH₵300).
- Starter product rows are based on the names shared for the shop. Their opening stock is zero because no verified counts were supplied.
- The service worker caches the app shell. Local records stay on the device.
- Shop-specific Supabase schema and row-level security were added to the connected Supabase project. The migration is in `supabase/migrations/`.
- The Mnotify Edge Function source is in `supabase/functions/`. It is not live until deployed and given the Mnotify key, sender ID, public app URL, and owner phone.

**Important:** this build does not yet connect the interface to Supabase Auth or cloud sync. It is a useful single-device prototype, not yet a multi-device production ledger. Daily 7 pm SMS scheduling also needs a scheduler and secrets configured. The UI labels these integrations as not configured.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

To use the app with sample starter products, open it in a browser. Local records persist in that browser on that device. Do not use multiple devices for real records until cloud sync is connected.

## Build for Netlify

Netlify build command: `npm run build`  
Publish directory: `dist`

The included `netlify.toml` provides the single-page app redirect. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to Netlify after cloud auth and sync are wired. Never add a Supabase secret/service-role key or Mnotify API key to frontend environment variables.

## Supabase data model

The migration creates isolated `shop_*` tables alongside any existing project data. Tables have RLS enabled; shop members are required for reads and writes. `shop_record_sale(jsonb)` locks and updates inventory atomically and supports idempotent offline replay. The public receipt RPC resolves a receipt only by its random token.

The migration uses a dedicated `shop_*` namespace and does not alter unrelated application tables. To onboard the owner, first create the Supabase Auth user, then add that user ID to `public.shop_members` with the `owner` role using a trusted admin session. Do not expose a service-role key in the client.

## Mnotify setup

The Edge Functions expect server-side secrets:

- `MNOTIFY_API_KEY`
- `MNOTIFY_SENDER_ID`
- `PUBLIC_APP_URL`
- `APP_ORIGIN`
- `DAILY_REPORT_JOB_SECRET` for a scheduled daily report call

`send-receipt` checks the caller's shop membership and sends a receipt URL to the supplied customer number. `daily-owner-report` accepts an owner JWT for manual sends or a server-side job secret for scheduling; it compiles sales, amount collected, customer and supplier balances, low-stock products, and transaction notes. The daily SMS setting must be enabled before it will send.

Schedule the function for 19:00 Africa/Accra (UTC) after the owner phone and Mnotify credentials are configured. SMS is not sent by the current local-only interface.

## Smart notes

The dashboard notes use transparent local rules (low stock, customer balances, supplier balances). They are not a generative AI model. A real AI interpretation service needs a chosen provider and server-side API credential; none was provided, so no model calls or fabricated AI claims are included.
