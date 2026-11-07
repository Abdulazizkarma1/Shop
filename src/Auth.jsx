import React, { useEffect, useState } from 'react';
import { Wheat, LockKeyhole, WifiOff, LogIn } from 'lucide-react';
import { supabase, storageScope } from './client.js';

const TICKET = `gk_offline_access_v2:${storageScope}`;
const MAX_OFFLINE = 24 * 60 * 60 * 1000;
const cached = () => { try { return JSON.parse(localStorage.getItem(TICKET)); } catch { return null; } };
export function AuthGate({ children }) {
  const [member, setMember] = useState(null);
  const [candidate, setCandidate] = useState(cached);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user && !candidate) setCandidate({ userId: data.session.user.id, email: data.session.user.email });
    });
  }, []);
  async function verify(user, remember) {
    const { data, error } = await supabase.from('shop_members').select('user_id,display_name,role,active').eq('user_id', user.id).single();
    if (error || !data?.active) throw new Error('This account does not have active shop access. Contact the admin.');
    const access = { ...data, userId: user.id, email: user.email, verifiedAt: Date.now(), trusted: remember };
    if (remember) localStorage.setItem(TICKET, JSON.stringify(access));
    else localStorage.removeItem(TICKET);
    setCandidate(access); setMember(access); setError('');
  }
  async function signIn(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!navigator.onLine) throw new Error('First sign-in needs internet. Use Continue offline only after signing in on a trusted device.');
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error('Sign-in failed. Check your email and password.');
      await verify(data.user, trusted);
      setPassword('');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function continueSession() {
    setBusy(true); setError('');
    try {
      if (!navigator.onLine) {
        const ticket = cached();
        if (!ticket?.trusted || Date.now() - ticket.verifiedAt >= MAX_OFFLINE) throw new Error('Offline access has expired. Connect and sign in again.');
        setMember(ticket);
      } else {
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) throw new Error('Please enter your password to sign in again.');
        await verify(data.user, Boolean(candidate?.trusted));
      }
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function signOut() {
    localStorage.removeItem(TICKET);
    await supabase.auth.signOut({ scope: 'local' });
    setMember(null); setCandidate(null); setPassword('');
  }
  useEffect(() => {
    if (!member) return;
    const check = async () => {
      if (!navigator.onLine) {
        if (!member.trusted || Date.now() - member.verifiedAt >= MAX_OFFLINE) { setMember(null); setError('Connect and sign in to renew offline access.'); }
        return;
      }
      const { data, error } = await supabase.from('shop_members').select('active,role').eq('user_id', member.userId).single();
      if (!error && !data?.active) { setMember(null); localStorage.removeItem(TICKET); setError('Your shop access has been disabled.'); }
      else if (!error && data?.active) {
        const renewed = { ...member, role: data.role, verifiedAt: Date.now() };
        if (renewed.trusted) localStorage.setItem(TICKET, JSON.stringify(renewed));
        setMember(renewed);
      }
    };
    const timer = setInterval(check, 60000);
    addEventListener('online', check);
    return () => { clearInterval(timer); removeEventListener('online', check); };
  }, [member]);
  if (member) return children(member, signOut);
  const offlineAllowed = candidate?.trusted && Date.now() - candidate.verifiedAt < MAX_OFFLINE;
  return <main className="login-screen"><section className="login-story"><div className="brand-mark"><Wheat size={25}/></div><span className="eyebrow">GRAINKEEPER SHOP DESK</span><h1>A clear record.<br/>A calmer shop.</h1><p>Keep sales, stock, and every promise to pay in one place.</p><img src="/rice-sacks.svg" alt="Rice sacks illustration"/></section><section className="login-card"><LockKeyhole size={27}/><h2>Sign in to your shop</h2><p>Your admin creates your account and assigns your role.</p>{!supabase ? <div className="form-error">The shop connection is missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in Netlify, then redeploy.</div> : <><form onSubmit={signIn}><label className="form-label">EMAIL<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)}/></label><label className="form-label">PASSWORD<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/></label><label className="checkbox-label"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)}/>This is a trusted shop device. Allow offline work for 24 hours.</label>{error && <div className="form-error" role="alert">{error}</div>}<button className="button submit-button" disabled={busy}>{busy ? 'Signing in…' : <><LogIn size={17}/> Sign in</>}</button></form>{candidate && <button disabled={busy || !navigator.onLine && !offlineAllowed} className="button button-secondary continue-session" onClick={continueSession}>{navigator.onLine ? 'Continue current session' : 'Continue offline'} {candidate.display_name || candidate.email}</button>}<div className="login-note"><WifiOff size={17}/><span>Sign in online once on a trusted device. Sales and receipts then work offline. Queued SMS sends after reconnection.</span></div></>}</section></main>;
}
