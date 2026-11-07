import { phoneNumber, service } from './server.ts';
type DB = ReturnType<typeof service>;
export const smsConfigured = () => Boolean(Deno.env.get('MNOTIFY_API_KEY') && Deno.env.get('MNOTIFY_SENDER_ID') && Deno.env.get('PUBLIC_APP_URL'));
export async function enqueueDaily(db: DB, manual = false, userId?: string) {
  const { data: settings, error } = await db.from('shop_settings').select('*').eq('id', true).single();
  if (error) throw new Error('Shop settings could not be loaded.');
  if (!settings.daily_sms_enabled || !settings.owner_phone) {
    if (manual) throw new Error('Add the owner phone number and enable daily SMS in Settings.');
    return null;
  }
  const now = new Date(), hour = now.getUTCHours();
  if (!manual && hour < 19) return null;
  const day = now.toISOString().slice(0, 10), start = `${day}T00:00:00Z`, end = `${day}T23:59:59.999Z`;
  // Aggregates run in Postgres so the Data API row cap cannot truncate a daily total.
  const { data: summary, error: summaryError } = await db.rpc('shop_daily_summary', { day_key: day });
  if (summaryError) throw new Error('Daily report could not be prepared.');
  const cash = (n: unknown) => Number(n || 0).toFixed(2);
  const stock = (summary.products || []).map((p: any) => `${p.name} ${p.stock} ${p.stock_unit}`).join('; ');
  const message = [ `${settings.shop_name || 'Shop'} | ${day}`, `Sales ${summary.sale_count}: GHS ${cash(summary.sales_value)}. Collected GHS ${cash(summary.collected)}.`, `Customer due GHS ${cash(summary.customer_due)}; supplier due GHS ${cash(summary.supplier_due)}.`, `Stock: ${stock || 'None'}.`, `Notes: ${(summary.notes || []).slice(0, 3).join('; ') || 'None'}. Synced records only.` ].join('\n').slice(0, 1200);
  const key = `daily:${day}`;
  const { error: queueError } = await db.from('shop_sms_queue').upsert({ kind: 'daily_report', recipient: phoneNumber(settings.owner_phone), payload: { message, day }, idempotency_key: key, requested_by: userId || null }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  if (queueError) throw new Error('Daily SMS could not be queued.');
  const { data } = await db.from('shop_sms_queue').select('id,dispatch_state').eq('idempotency_key', key).single();
  return data;
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
      if (item.kind === 'receipt') {
        const { data: receipt, error: receiptError } = await db.rpc('shop_public_receipt', { receipt_token: item.payload.receipt_token });
        if (receiptError || !receipt) {
          await db.from('shop_sms_queue').update({ status: 'failed', dispatch_state: 'failed', last_error: 'The receipt is unavailable.' }).eq('id', item.id); processed++; continue;
        }
        const base = Deno.env.get('PUBLIC_APP_URL')!.replace(/\/$/, '');
        message = `${receipt.shop?.name || 'Shop'}: Receipt ${receipt.receipt_code}. Total GHS ${Number(receipt.sale_total).toFixed(2)}, balance GHS ${Number(receipt.balance).toFixed(2)}. ${base}/?receipt=${encodeURIComponent(item.payload.receipt_token)}`;
      }
      const response = await fetch(`https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(Deno.env.get('MNOTIFY_API_KEY')!)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ recipient: [item.recipient], sender: Deno.env.get('MNOTIFY_SENDER_ID'), message, is_schedule: false, schedule_date: '' }) });
      const result = await response.json();
      const accepted = response.ok && result.status === 'success';
      const transient = response.status >= 500;
      const { error: updateError } = await db.from('shop_sms_queue').update({ status: accepted ? 'sent' : 'failed', dispatch_state: accepted ? 'sent' : transient ? 'unknown' : 'failed', sent_at: accepted ? new Date().toISOString() : null, provider_id: result.summary?._id || result._id || null, last_error: accepted ? null : transient ? 'Provider outcome uncertain. Check Mnotify before retrying.' : String(result.message || 'Mnotify rejected the request.').slice(0, 180) }).eq('id', item.id);
      if (updateError) throw new Error('Could not save provider result.');
    } catch {
      await db.from('shop_sms_queue').update({ dispatch_state: 'unknown', last_error: 'Provider outcome uncertain. Check Mnotify before retrying.' }).eq('id', item.id);
    }
    processed++;
  }
  return { configured: true, processed };
}
