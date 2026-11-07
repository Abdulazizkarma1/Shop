import { createClient } from '@supabase/supabase-js';

const env = import.meta.env || {};
export function projectScope(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return 'unconfigured'; }
}
export const storageScope = projectScope(env.VITE_SUPABASE_URL);
export const configReady = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY);
function connect() {
  if(!configReady) return null;
  try { return createClient(env.VITE_SUPABASE_URL.trim(), env.VITE_SUPABASE_PUBLISHABLE_KEY.trim(), { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }); } catch { return null; }
}
export const supabase = connect();
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const normalizePhone = value => {
  let phone = String(value || '').replace(/[\s()-]/g, '');
  if (/^0\d{9}$/.test(phone)) phone = `233${phone.slice(1)}`;
  phone = phone.replace(/^\+/, '');
  if (phone && !/^[1-9]\d{9,14}$/.test(phone)) throw new Error('Enter a valid phone number, for example 0241234567.');
  return phone;
};

export async function invoke(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const details = await error.context?.json?.().catch(() => null);
    throw new Error(details?.error || error.message || 'The request failed.');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
