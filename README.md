# Grainkeeper Shop Desk

A React + Tailwind shop ledger for rice and groceries, with Supabase Auth, database roles, durable IndexedDB transactions, receipts and a server-owned Mnotify queue. The interface is designed for phones and can record trading activity while offline after a trusted-device sign-in.

See **[the setup and operating guide](docs/SETUP.md)** for Netlify variables, Supabase secrets, account roles, stock setup, receipts and the daily 7 pm report.

## Features

- Login on startup; Admin and Seller accounts with server-enforced permissions.
- Inventory catalog, opening counts, prices, product archiving and an audit record of product changes.
- Full rice bags and quarter-bag loose units; negotiated selling prices.
- Paid, part-paid and credit sales, supplier purchases, and subsequent payments.
- Customer name and release/payment note required for credit sales.
- Printable receipts generated immediately, stable random receipt URLs, and optional receipt SMS.
- Local records and their outbox saved atomically; UUID-based replay protection and visible sync conflicts.
- Lightweight change detection and background server SMS processing.
- Daily owner report around 19:00 Africa/Accra, including current stock, notes and balances.
- No passwords, Mnotify credentials or service-role keys in this repository.

## Development

```sh
npm ci
cp .env.example .env.local
# Set the two browser-safe Supabase values in .env.local
npm run dev
```

```sh
npm test
npm run build
```

Netlify build command: `npm run build`; publish directory: `dist`. The build precaches hashed assets and ships a network-first navigation service worker so deployments do not stay stuck behind the old cached dashboard.

## Operational limits

First login, user management and product configuration need internet. Trusted offline access lasts 24 hours after online verification. Offline receipts can be printed immediately; SMS delivery and links on new devices require the sale to sync. Keep the app open after reconnecting until its pending queue drains. Offline stock across multiple disconnected devices can conflict; rejected records remain saved for investigation.

Starter stock is zero and non-rice prices require configuration. Existing records from the earlier local-only app are preserved for export, rather than silently merged. Dashboard smart notes use transparent local rules; they are not an external AI service. See the setup guide before recording live trading data.
