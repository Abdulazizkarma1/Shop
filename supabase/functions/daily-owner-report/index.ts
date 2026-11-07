import { service, member, preflight, reply } from '../_shared/server.ts';
import { enqueueDaily, processSMS } from '../_shared/sms.ts';
Deno.serve(async req => {
  const early = preflight(req); if (early) return early;
  try {
    const db = service(), access = await member(req, db, true);
    const queued = await enqueueDaily(db, true, access.user_id);
    await processSMS(db, 10);
    const { data } = await db.from('shop_sms_queue').select('dispatch_state').eq('id', queued.id).single();
    return reply(req, { queued: true, sent: data?.dispatch_state === 'sent', status: data?.dispatch_state });
  } catch (error) { return reply(req, { error: error instanceof Error ? error.message : 'Daily report failed.' }, 403); }
});
