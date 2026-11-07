# Shop setup and day-to-day use

## 1. Netlify browser configuration

Open your Netlify project's Environment variables configuration. Add these variables for the production **build** context, then trigger a new deployment:

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://fyssbtadzjqvmxglowdf.supabase.co` for the connected project |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The active default publishable key (`sb_publishable_...`) from Supabase → Settings → API Keys |

Build command: `npm run build`. Publish directory: `dist`. Node 22 or newer is recommended. Vite inserts `VITE_` values into the browser bundle during the build, so changing them requires another build. These two values are browser-safe. Never put an Mnotify key, database password, Supabase service-role key, or admin password in a `VITE_` variable.

The login page explains missing browser configuration instead of silently opening a local demo. After deploying over the earlier version, reload the app to allow the new service worker to activate, then reload once more if the old dashboard remains visible. Do not clear site storage before exporting any previous local records.

## 2. Sign in and create the team

The requested first admin account was seeded directly in Supabase Auth and assigned the database `owner` role. Its login details are supplied privately, never in this repository.

1. Open the updated app and sign in online.
2. Select **trusted shop device** only on a shop-controlled phone or computer if offline work is needed.
3. Open **Settings → Your password** to change the initial password.
4. In **Settings → Create a user**, enter the seller's name, email, temporary password (at least 10 characters), and role.
5. Give each person their own account. Share temporary credentials privately.
6. To remove access, use **Disable access** beside the team member. Current server operations are blocked immediately. An already-offline trusted device can keep local work for the remainder of its 24-hour offline window; its queued records cannot sync while the account is disabled.

| Role shown in the app | Database role | Permissions |
| --- | --- | --- |
| Admin | `owner` | All shop screens; create and disable accounts; add, edit, archive and restore products; receive stock; record supplier payments; see reports; configure owner SMS |
| Seller | `attendant` | Record paid, part-paid and credit sales; view sale history and inventory; collect customer payments; issue receipts; view their SMS requests; change their own password |

Seller access to supplier purchases, supplier payments, product writes and account creation is also restricted on the server. Knowing an API URL does not grant access. Public signup does not grant shop membership.

## 3. Set up stock before trading

The starter catalog has **zero opening stock**. Count the physical goods, open Inventory, and use the product's row menu to set its opening count, standard price, loose-unit price, and low-stock threshold. Ketchup and noodle prices must be filled in before selling. Sale prices must be positive.

The starter rice pack labels interpret “10 kg, four in a bag” as four 10 kg packs in one outer bag (40 kg total). One single pack deducts 0.25 outer bag. Outer bags start at GHS 1,200; single 10 kg packs start at GHS 320, with the agreed negotiated price (such as GHS 300) entered for each sale. Confirm the physical pack sizes during the opening stocktake.

After the initial stocktake, record deliveries in **Purchases**. Enter the full supplier cost, the amount paid now and a due date if appropriate. Unpaid purchases still increase stock because this screen records goods already received. A purchase plan for goods not delivered should not be entered as received stock.

Credit sales require a customer name and a payment/release note. Record who authorized collection without payment and the expected payment date. Later payments belong under Balances; entering another sale would reduce stock twice.

## 4. Supabase secrets for SMS

Open the connected Supabase project → Edge Functions → Secrets. Add:

| Secret | What to enter |
| --- | --- |
| `MNOTIFY_API_KEY` | Your enabled Mnotify/BMS API key |
| `MNOTIFY_SENDER_ID` | Your approved sender ID, at most 11 characters |
| `PUBLIC_APP_URL` | Your live Netlify URL, e.g. `https://your-shop.netlify.app`, without a trailing slash |
| `APP_ORIGIN` | That same origin, e.g. `https://your-shop.netlify.app`, without a path or trailing slash |

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` inside its Edge Functions. Do not add those credentials to Netlify or the browser. The scheduler credential is generated in Supabase Vault. No manually supplied `DAILY_REPORT_JOB_SECRET` is required by this version.

Keep sufficient SMS credit in Mnotify. Multi-part messages may use more than one SMS credit. Sender approval and the provider's current prices are managed in your Mnotify account.

In the app, save the shop name and receipt location, owner name and owner phone, then enable daily SMS in Settings. Local Ghana phone numbers such as `0241234567` are normalized to `233241234567`.

The deployed server functions are `shop-manage-users`, `send-receipt`, `daily-owner-report`, and `shop-process-sms`. The last function authenticates its scheduler using a Vault-backed secret, or verifies an admin session. It does not accept unauthenticated work. The other three require a signed-in user and verify shop membership; management and daily reports require Admin.

## 5. What works offline

| Action | Offline behavior |
| --- | --- |
| First sign-in or account creation | Needs internet |
| Start a trusted device | Continue offline is available for 24 hours after the last verified online session; passwords are not stored for offline verification |
| View downloaded stock and ledger | Available from IndexedDB |
| Record sales, received purchases and payments | Saved locally with an outbox in the same database transaction |
| Generate, view and print/save a receipt | Available immediately on the selling device |
| Customer supplies a phone | A receipt SMS request is automatically saved in the outbox |
| Deliver SMS through Mnotify | Needs internet; it cannot transmit while disconnected |
| Open a receipt link on a new customer phone | Works after the sale has synced; previously opened receipts can be cached on that phone |
| Edit product counts, save shop settings, manage users | Needs internet; product editing also waits for pending local records to sync |

Keep the app open after reconnecting until **pending requests = 0**. Browser Background Sync is not supported everywhere, so this app also retries in the foreground and on reconnection. Once an SMS request reaches Supabase, the server worker can send it even if the shop browser is closed.

Offline stock is the last known stock plus that device's saved transactions. Two disconnected devices can sell the same remaining stock. The server locks product rows and prevents negative stock; a conflict stays visible in Settings and the transaction remains on the device. An admin must investigate the physical count using a connected device and retry. Do not delete a pending real sale to make an error disappear.

The earlier app's `gk_products`, `gk_sales`, and `gk_purchases` storage is retained. Settings offers an export. Those old records are not silently imported into the new shared ledger; reconcile them before treating the new ledger as the shop's opening position.

## 6. Daily 7 pm report and SMS status

The installed `shop-sms-worker` Cron job runs every five minutes. At or after 19:00 Africa/Accra, it queues one daily summary for that date if daily SMS is enabled. It also processes queued receipts. The report includes sales value, collections (including today's payments on older credit sales), all customer and supplier balances, stock and notes. Only data synced to Supabase by report time can be included. Stock and note text is capped to keep the SMS summary bounded.

Settings shows:

- **queued**: saved, waiting for credentials or dispatch.
- **sending**: claimed by one worker.
- **sent**: accepted by Mnotify; this is not a handset delivery confirmation.
- **failed**: rejected. Correct credentials, sender or balance, then use Admin's retry button.
- **unknown**: a network timeout or interrupted send makes the result uncertain. Check Mnotify before resending. The system does not automatically repeat an uncertain message and risk duplicate charges.

Daily summaries use one idempotency key per day. Manual **Queue today's owner summary** uses that same key and does not send a second summary after one is accepted.

## 7. Verification and maintenance

Run `npm ci`, `npm test` and `npm run build`. The tests cover every dashboard page, empty data, stock conversion, credit/payment validation, IndexedDB durability and concurrent tabs. `tests/database-contract.sql` checks actual database roles and atomic writes inside a transaction that rolls back all fixtures.

For a new Supabase project, apply the shop migrations in order and change the project URL in the scheduler migration before scheduling the worker. Deploy the Edge Functions with their shared files and `supabase/config.toml`. Do not rerun migrations already listed in the hosted project's migration history.

Monitor failed Cron calls and Edge Function errors in Supabase, and failed deliveries in Mnotify. Export backups and verify the closing physical stock regularly. All new shop tables use RLS. The receipt RPC intentionally permits a public lookup by a random receipt token and returns receipt-only fields, excluding customer phone and internal release notes.

Smart dashboard notes currently use local rules. No external AI provider or AI key is needed for sales, stock, receipts, sync, users or SMS.

Official references: [Supabase server-side user creation](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [Supabase scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions), [MDN Background Synchronization](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API), [Vite environment variables](https://vite.dev/guide/env-and-mode), [Netlify environment variables](https://docs.netlify.com/build/configure-builds/environment-variables/), [Mnotify/BMS API](https://developer.bms.africa/).
