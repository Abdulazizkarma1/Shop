import { service, member, preflight, reply } from '../_shared/server.ts';
import { enqueueDaily, processSMS } from '../_shared/sms.ts';
Deno.serve(async req => {
  const early = preflight(req); if (early) return early;
  try {
    const db = service(), access = await member(req, db, true);
    const keys = await enqueueDaily(db, true, access.user_id);
    await processSMS(db, 10);
    const { data, error } = await db.from('shop_sms_queue').select('dispatch_state').in('idempotency_key', keys);
    if (error) throw new Error('Daily SMS status could not be loaded.');
    const accepted = data.filter(row => row.dispatch_state === 'sent').length;
    return reply(req, { queued: true, recipients: keys.length, accepted, sent: accepted === keys.length });
  } catch (error) { return reply(req, { error: error instanceof Error ? error.message : 'Daily report failed.' }, 403); }
});
