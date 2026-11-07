import { service, member, preflight, reply } from '../_shared/server.ts';
import { enqueueDaily, processSMS } from '../_shared/sms.ts';
Deno.serve(async req => {
  const early = preflight(req); if (early) return early;
  try {
    const db = service(), supplied = req.headers.get('x-job-secret');
    let scheduled = false;
    if (supplied) { const { data, error } = await db.rpc('shop_job_authorized', { job_secret: supplied }); scheduled = !error && data === true; }
    if (!scheduled) await member(req, db, true);
    await enqueueDaily(db);
    return reply(req, await processSMS(db));
  } catch { return reply(req, { error: 'An authorized scheduler or admin session is required.' }, 403); }
});
