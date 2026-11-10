import { phoneNumber, service } from './server.ts';
type DB = ReturnType<typeof service>;
export const smsConfigured = () => Boolean(Deno.env.get('MNOTIFY_API_KEY') && Deno.env.get('MNOTIFY_SENDER_ID') && Deno.env.get('PUBLIC_APP_URL'));
export async function enqueueDaily(db: DB, manual = false, userId?: string) {
  const now = new Date();
  if (!manual && now.getUTCHours() < 19) return [];
  const { data: settings, error } = await db.from('shop_settings').select('*').eq('id', true).single();
  if (error) throw new Error('Shop settings could not be loaded.');
  const contacts = [settings.owner_phone, settings.report_phone_2, settings.report_phone_3];
  if (!settings.daily_sms_enabled || !contacts.some(Boolean)) {
    if (manual) throw new Error('Add a report phone number and enable daily SMS in Settings.');
    return [];
  }

  const recipients = [...new Set(contacts.filter(Boolean).map(phoneNumber))];
  const day = now.toISOString().slice(0, 10);
  const legacyKey = `daily:${day}`;
  const keys = recipients.map(phone => `${legacyKey}:${phone}`);
  const { data: existing, error: lookupError } = await db.from('shop_sms_queue')
    .select('idempotency_key,recipient,payload').in('idempotency_key', [legacyKey, ...keys]);
  if (lookupError) throw new Error('Daily SMS status could not be loaded.');
  const byPhone = new Map(existing.map(row => [row.recipient, row.idempotency_key]));
  const missing = recipients.filter(phone => !byPhone.has(phone));
  if (!missing.length) return recipients.map((phone, index) => byPhone.get(phone) ?? keys[index]);

  // Reuse today's snapshot if another contact already received this report.
  let message = existing[0]?.payload?.message;
  if (typeof message !== 'string' || !message) {
    const { data: summary, error: summaryError } = await db.rpc('shop_daily_summary', { day_key: day });
    if (summaryError) throw new Error('Daily report could not be prepared.');
    const cash = (n: unknown) => Number(n || 0).toFixed(2);
    const stock = (summary.products || []).map((p: any) => `${p.name} ${p.stock} ${p.stock_unit}`).join('; ');
    message = [ `${settings.shop_name || 'Shop'} | ${day}`, `Sales ${summary.sale_count}: GHS ${cash(summary.sales_value)}. Collected GHS ${cash(summary.collected)}.`, `Customer due GHS ${cash(summary.customer_due)}; supplier due GHS ${cash(summary.supplier_due)}.`, `Stock: ${stock || 'None'}.`, `Notes: ${(summary.notes || []).slice(0, 3).join('; ') || 'None'}. Synced records only.` ].join('\n').slice(0, 1200);
  }
  const { error: queueError } = await db.from('shop_sms_queue').upsert(missing.map(recipient => ({
    kind: 'daily_report', recipient, payload: { message, day },
    idempotency_key: `${legacyKey}:${recipient}`, requested_by: userId || null,
  })), { onConflict: 'idempotency_key', ignoreDuplicates: true });
  if (queueError) throw new Error('Daily SMS could not be queued.');
  return recipients.map((phone, index) => byPhone.get(phone) ?? keys[index]);
}

function receiptMessage(receiptCode: string, token: string) {
  const link = new URL(Deno.env.get('PUBLIC_APP_URL')!.trim());
  if (link.protocol !== 'https:' || link.username || link.password) {
    throw new Error('Set PUBLIC_APP_URL to the public HTTPS shop address.');
  }
  link.hash = '';
  link.search = '';
  link.searchParams.set('receipt', token);
  return `Your shop receipt ${receiptCode}: ${link.href}`;
}

function providerRejection(result: any, status: number, apiKey: string) {
  const code = String(result?.code ?? '');
  const label = `Mnotify rejected the SMS (HTTP ${status}${/^\d{3,6}$/.test(code) ? `, code ${code}` : ''}).`;
  const detail = [result?.message, result?.error?.message, result?.error, result?.detail, result?.errors?.message, result?.errors?.recipient?.[0], result?.errors?.sender?.[0]]
    .find(value => typeof value === 'string' && value.trim());
  if (!detail) return label;
  const safeDetail = detail.replaceAll(apiKey, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '[id]')
    .replace(/\+?\d{7,}/g, '[number]')
    .replace(/[\r\n]+/g, ' ');
  return `${label} ${safeDetail}`.slice(0, 220);
}

export async function processSMS(db: DB, limit = 10) {
  // Never retry a request whose outcome is uncertain: it may have been charged/sent.
  await db.from('shop_sms_queue').update({ dispatch_state: 'unknown', last_error: 'Sending was interrupted. Check Mnotify before resending.' }).eq('dispatch_state', 'sending').lt('claimed_at', new Date(Date.now() - 600000).toISOString());
  if (!smsConfigured()) return { configured: false, processed: 0 };
  let processed = 0;
  while (processed < limit) {
    const { data, error } = await db.rpc('shop_claim_sms');
    if (error) throw new Error('Could not claim the SMS queue.');
    const item = data?.[0]; if (!item) break;
    try {
      let message = item.payload.message;
      let recipient = item.recipient;
      if (item.kind === 'receipt') {
        const { data: receipt, error: receiptError } = await db.rpc('shop_public_receipt', { receipt_token: item.payload.receipt_token });
        if (receiptError || !receipt) {
          await db.from('shop_sms_queue').update({ status: 'failed', dispatch_state: 'failed', last_error: 'The receipt is unavailable.' }).eq('id', item.id);
          processed++;
          continue;
        }
        try {
          message = receiptMessage(receipt.receipt_code, item.payload.receipt_token);
        } catch {
          await db.from('shop_sms_queue').update({ status: 'failed', dispatch_state: 'failed', last_error: 'Set PUBLIC_APP_URL to the public HTTPS shop address.' }).eq('id', item.id);
          processed++;
          continue;
        }
        // Quick SMS documents Ghana recipients in local format. Keep the
        // international form in the queue for deduplication and display.
        if (/^233\d{9}$/.test(recipient)) recipient = `0${recipient.slice(3)}`;
      }
      const apiKey = Deno.env.get('MNOTIFY_API_KEY')!;
      const response = await fetch(`https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ recipient: [recipient], sender: Deno.env.get('MNOTIFY_SENDER_ID'), message, is_schedule: false, schedule_date: '' }),
      });
      const result = await response.json().catch(() => null);
      const totalSent = result?.summary?.total_sent;
      const noRecipients = totalSent != null && Number(totalSent) === 0;
      const accepted = response.ok && result?.status === 'success' && !noRecipients;
      const rejected = !accepted && (noRecipients || (response.status >= 400 && response.status < 500 && response.status !== 408) || (response.ok && ['error', 'failed', 'failure'].includes(result?.status)));
      const dispatch_state = accepted ? 'sent' : rejected ? 'failed' : 'unknown';
      const { error: updateError } = await db.from('shop_sms_queue').update({
        status: accepted ? 'sent' : 'failed',
        dispatch_state,
        sent_at: accepted ? new Date().toISOString() : null,
        provider_id: result?.summary?._id || result?._id || null,
        last_error: accepted ? null : rejected ? providerRejection(result, response.status, apiKey) : `Provider outcome uncertain (HTTP ${response.status}). Check Mnotify before retrying.`,
      }).eq('id', item.id);
      if (updateError) throw new Error('Could not save provider result.');
    } catch {
      await db.from('shop_sms_queue').update({ dispatch_state: 'unknown', last_error: 'Provider outcome uncertain. Check Mnotify before retrying.' }).eq('id', item.id);
    }
    processed++;
  }
  return { configured: true, processed };
}
