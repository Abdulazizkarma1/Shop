import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
export const service = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
export function headers(req: Request) {
  return { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') || '*', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info,x-job-secret', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin' };
}
export function reply(req: Request, body: unknown, status = 200) { return Response.json(body, { status, headers: headers(req) }); }
export async function member(req: Request, db: ReturnType<typeof service>, owner = false) {
  const token = req.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!token) throw new Error('Sign in first.');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new Error('A valid account is required.');
  const { data: access, error: membershipError } = await db.from('shop_members').select('*').eq('user_id', data.user.id).single();
  if (membershipError || !access?.active || owner && access.role !== 'owner') throw new Error(owner ? 'Admin access required.' : 'Shop access required.');
  return access;
}
export function phoneNumber(value: unknown) {
  let phone = String(value || '').replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (/^0\d{9}$/.test(phone)) phone = `233${phone.slice(1)}`;
  if (!/^[1-9]\d{9,14}$/.test(phone)) throw new Error('A valid phone number is required.');
  return phone;
}
export function preflight(req: Request) {
  const allowed = Deno.env.get('APP_ORIGIN');
  if (allowed && req.headers.get('origin') && req.headers.get('origin') !== allowed) return reply(req, { error: 'Origin is not allowed.' }, 403);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: headers(req) });
  if (req.method !== 'POST') return reply(req, { error: 'POST required.' }, 405);
  return null;
}
