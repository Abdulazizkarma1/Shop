import { service, member, preflight, reply } from '../_shared/server.ts';
Deno.serve(async req => {
  const early = preflight(req); if (early) return early;
  try {
    const db = service(), caller = await member(req, db, true);
    const body = await req.json();
    if (body.action === 'create') {
      const email = String(body.email || '').trim().toLowerCase(), name = String(body.display_name || '').trim();
      const role = body.role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 100 || typeof body.password !== 'string' || body.password.length < 10 || !['owner', 'attendant'].includes(role)) return reply(req, { error: 'Provide a name, valid email, role, and password of at least 10 characters.' }, 400);
      const { data, error } = await db.auth.admin.createUser({ email, password: body.password, email_confirm: true, app_metadata: { application: 'shop' }, user_metadata: { name } });
      if (error) return reply(req, { error: error.message }, 400);
      const { error: addError } = await db.from('shop_members').insert({ user_id: data.user.id, display_name: name, email, role, active: true });
      if (addError) { await db.auth.admin.deleteUser(data.user.id); throw new Error('The account could not be linked to the shop. Please retry.'); }
      await db.from('shop_audit').insert({ actor_id: caller.user_id, action: 'user_created', details: { user_id: data.user.id, role } });
      return reply(req, { created: true, user_id: data.user.id });
    }
    if (body.action === 'set-active') {
      if (body.user_id === caller.user_id || typeof body.active !== 'boolean') return reply(req, { error: 'You cannot disable your own admin account.' }, 400);
      const { data: target, error } = await db.from('shop_members').update({ active: body.active }).eq('user_id', body.user_id).select('user_id').single();
      if (error || !target) return reply(req, { error: 'Shop account not found.' }, 404);
      await db.from('shop_audit').insert({ actor_id: caller.user_id, action: 'user_access_changed', details: { user_id: target.user_id, active: body.active } });
      return reply(req, { updated: true });
    }
    return reply(req, { error: 'Unknown account action.' }, 400);
  } catch (error) { return reply(req, { error: error instanceof Error ? error.message : 'Account request failed.' }, 403); }
});
