import { service, member, preflight, reply, phoneNumber } from '../_shared/server.ts';
import { processSMS } from '../_shared/sms.ts';
Deno.serve(async req => {
  const early = preflight(req); if (early) return early;
  try {
    const db = service(), access = await member(req, db);
    const { receipt_token, phone } = await req.json(), recipient = phoneNumber(phone);
    if (!/^[0-9a-f-]{36}$/i.test(String(receipt_token))) return reply(req, { error: 'A valid receipt is required.' }, 400);
    const { data: sale } = await db.from('shop_sales').select('id,customer_phone').eq('receipt_token', receipt_token).is('voided_at', null).single();
    if (!sale) return reply(req, { error: 'Sync the sale before sending its receipt.' }, 404);
    if (sale.customer_phone && phoneNumber(sale.customer_phone) !== recipient && access.role !== 'owner') return reply(req, { error: 'Ask the admin to correct this receipt phone number.' }, 403);
    if (!sale.customer_phone || phoneNumber(sale.customer_phone) !== recipient) {
      const { error } = await db.from('shop_sales').update({ customer_phone: recipient }).eq('id', sale.id);
      if (error) throw new Error('Could not save the receipt phone number.');
    }
    const key = `receipt:${receipt_token}:${recipient}`;
    const { error } = await db.from('shop_sms_queue').upsert({ kind: 'receipt', recipient, payload: { receipt_token }, idempotency_key: key, requested_by: access.user_id }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    if (error) throw new Error('Could not queue the receipt.');
    await processSMS(db, 3);
    const { data: queued } = await db.from('shop_sms_queue').select('dispatch_state').eq('idempotency_key', key).single();
    return reply(req, { queued: true, status: queued?.dispatch_state || 'queued' });
  } catch (error) { return reply(req, { error: error instanceof Error ? error.message : 'Receipt request failed.' }, 403); }
});
