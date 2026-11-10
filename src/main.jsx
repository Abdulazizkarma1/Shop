import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownLeft, ArrowDownRight, ArrowRight, ArrowUpRight, Banknote, Boxes, Check, CheckCircle2, ChevronRight, Clock3, Cloud, CloudOff, CreditCard, Download, FileText, HandCoins, Home, Info, LogOut, Menu, Minus, Package, Plus, Search, Send, Settings, ShoppingBag, ShoppingCart, Truck, Wheat, X } from 'lucide-react';
import { supabase, normalizePhone, today } from './client.js';
import { getLedger, collectedToday, cachedReceipt } from './offline.js';
import { AuthGate } from './Auth.jsx';
import { ShopSettings, downloadJSON } from './Settings.jsx';
import './styles.css';

const currency = n => `GH₵ ${Number(n || 0).toLocaleString('en-GH', { maximumFractionDigits: 2 })}`;
const dateKey = today;
const displayDate = value => { if (!value) return '—'; if (value === dateKey()) return 'Today'; const d = new Date(`${value}T00:00:00`); return new Intl.DateTimeFormat('en-GH', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(d); };
const newId = prefix => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
const todayLabel = () => new Intl.DateTimeFormat('en-GH', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

function RootApp() {
  if (new URLSearchParams(window.location.search).has('receipt')) return <PublicReceiptPage client={supabase}/>;
  return <AuthGate>{(member, onSignOut) => <App key={member.userId} member={member} onSignOut={onSignOut}/>}</AuthGate>;
}

class PageBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main className="recovery"><section className="surface"><h1>This page could not open</h1><p>Your saved shop records are still on this device.</p><button className="button" onClick={() => location.reload()}>Reload the app</button></section></main> : this.props.children; }
}

function App({ member, onSignOut }) {
  const ledger = useMemo(() => getLedger(member.userId), [member.userId]);
  const [state, setState] = useState(ledger.current);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [active, setActive] = useState('Overview');
  const [modal, setModal] = useState('');
  const [selected, setSelected] = useState(null);
  const [paymentTarget, setPaymentTarget] = useState('sale');
  const [receipt, setReceipt] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [saleFilter, setSaleFilter] = useState('All sales');
  const [mobileNav, setMobileNav] = useState(false);
  const busy = useRef(false);
  const adminMode = member.role === 'owner';
  const { products, sales, purchases } = state;
  const primary = [
    { name: 'Overview', label: 'Home', icon: Home },
    { name: 'Inventory', label: 'Stock', icon: Boxes },
    { name: 'New Sale', label: 'New sale', icon: Plus, action: true },
    { name: 'More', label: 'More', icon: Menu },
  ];
  const notify = message => { setToast(message); window.clearTimeout(notify.timer); notify.timer = window.setTimeout(() => setToast(''), 4200); };
  const go = requestedName => { const name = !adminMode && ['Purchases', 'Reports'].includes(requestedName) ? 'More' : requestedName; setActive(name); setSearch(''); setModal(''); setSelected(null); setMobileNav(false); history.replaceState(null, '', `#${name.toLowerCase().replaceAll(' ', '-')}`); };

  useEffect(() => {
    let alive = true;
    const listener = value => { if (alive) setState(value); };
    ledger.listeners.add(listener);
    ledger.start().then(() => { if (alive) { setReady(true); void ledger.sync(true); } }).catch(e => setLoadError(e.message));
    const on = () => { setOnline(true); void ledger.sync(true); };
    const off = () => setOnline(false);
    const refresh = () => { if (navigator.onLine && document.visibilityState === 'visible') void ledger.sync(); };
    addEventListener('online', on); addEventListener('offline', off); addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(refresh, 30000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(reg => reg.update()).catch(() => {});
    navigator.storage?.persist?.().catch(() => {});
    const chosen = location.hash.slice(1).replaceAll('-', ' ');
    const knownViews = ['overview', 'inventory', 'more', 'sales', 'receivables', 'settings', ...(adminMode ? ['purchases', 'reports'] : [])];
    if (knownViews.includes(chosen)) setActive(chosen === 'overview' ? 'Overview' : chosen[0].toUpperCase() + chosen.slice(1));
    return () => { alive = false; ledger.listeners.delete(listener); clearInterval(timer); removeEventListener('online', on); removeEventListener('offline', off); removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [ledger, adminMode]);

  const run = async fn => {
    if (busy.current) return;
    busy.current = true; setSaving(true);
    try {
      if (!online && (!member.trusted || Date.now() - member.verifiedAt >= 86400000)) throw new Error('Connect and sign in on this trusted device before working offline.');
      await fn();
    } catch (e) { notify(e.message || 'This could not be saved. Your existing records are safe.'); }
    finally { busy.current = false; setSaving(false); }
  };
  const doSale = sale => run(async () => {
    const saved = { ...sale, clientId: crypto.randomUUID(), receiptToken: crypto.randomUUID(), phone: normalizePhone(sale.phone) };
    await ledger.add('sale', saved);
    setModal(''); setReceipt(saved);
    notify(online ? 'Sale saved on this device. Sync is in progress.' : 'Sale saved on this device. Waiting to sync.');
  });
  const doPurchase = purchase => run(async () => {
    if (!adminMode) throw new Error('Only an Admin can record stock received.');
    await ledger.add('purchase', { ...purchase, clientId: crypto.randomUUID(), createdAt: new Date().toISOString() });
    setModal(''); notify(online ? 'Purchase saved. Stock updated on this device.' : 'Purchase saved. Stock updated; waiting to sync.');
  });
  const recordPayment = (id, amount, target) => run(async () => {
    if (target === 'purchase' && !adminMode) throw new Error('Only an Admin can record supplier payments.');
    const row = (target === 'sale' ? sales : purchases).find(x => x.id === id);
    if (!row) throw new Error('Account not found. Refresh and try again.');
    await ledger.add('payment', { clientId: crypto.randomUUID(), target, targetClientId: row.clientId, amount: Number(amount), date: dateKey(), createdAt: new Date().toISOString() });
    setModal(''); notify(online ? 'Payment saved. Sync is in progress.' : 'Payment saved on this device. Waiting to sync.');
  });
  const payBalance = (id, amount) => recordPayment(id, amount, 'sale');
  const paySupplierBalance = (id, amount) => recordPayment(id, amount, 'purchase');
  const addProduct = product => run(async () => {
    if (!adminMode) throw new Error('Admin access required.');
    await ledger.saveProduct({ ...product, id: crypto.randomUUID(), fraction: product.category === 'Rice' && product.unit === 'bag' ? 0.25 : 0 });
    setModal(''); notify('Product added.');
  });
  const updateProduct = (id, changes) => run(async () => {
    if (!adminMode) throw new Error('Admin access required.');
    await ledger.saveProduct({ ...products.find(p => p.id === id), ...changes });
    setModal(''); notify('Product updated.');
  });

  const todaySales = sales.filter(s => s.date === dateKey());
  const todayRevenue = todaySales.reduce((n, s) => n + Number(s.amount), 0);
  const todayCollected = collectedToday(state);
  const outstanding = sales.reduce((n, s) => n + Number(s.balance || 0), 0);
  const pendingPurchases = purchases.reduce((n, p) => n + Number(p.balance || 0), 0);
  const lowStock = products.filter(p => p.active !== false && p.stock <= p.low);
  const totalGoods = products.filter(p => p.active !== false).reduce((n, p) => n + p.stock, 0);
  const status = state.error ? 'Needs attention' : saving ? 'Saving' : !online ? 'Offline' : state.outbox.length ? 'Waiting to sync' : state.lastSync ? 'Synced' : 'Online';
  const signOut = async () => {
    if (state.outbox.length && !confirm(`${state.outbox.length} saved record(s) are still waiting to sync. They will stay on this device. Sign out anyway?`)) return;
    await onSignOut();
  };

  if (loadError) return <main className="recovery"><section className="surface" role="alert"><h1>Saved shop records could not open</h1><p>{loadError}</p><button className="button" onClick={() => location.reload()}>Try again</button></section></main>;
  if (!ready) return <main className="recovery"><section className="surface" role="status">Opening saved shop records…</section></main>;
  if (state.accessDenied) return <main className="recovery"><section className="surface"><h1>Shop access disabled</h1><p>Your saved records remain on this device. Contact the Admin before signing out.</p><button className="button" onClick={signOut}>Sign out</button></section></main>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`} aria-label="Main navigation">
      <div className="brand"><span className="brand-mark"><Wheat size={21}/></span><span><strong>Shop desk</strong><small>{state.settings.shop_name || 'Hajia Asumaya Shop'}</small></span><button className="icon-button close-nav" aria-label="Close menu" onClick={() => setMobileNav(false)}><X/></button></div>
      <button className="button sale-primary sidebar-sale" onClick={() => { setSelected(null); setModal('sale'); setMobileNav(false); }}><Plus/>New Sale</button>
      <nav className="primary-nav">{primary.filter(item => !item.action).map(({ name, label, icon: Icon }) => <button key={name} className={`nav-link ${active === name ? 'nav-active' : ''}`} onClick={() => go(name)}><Icon/><span>{label}</span></button>)}</nav>
      <button className="connection-card" onClick={() => go('Settings')} aria-label={`Connection status: ${status}. Open sync settings`}><span className={`status-icon ${statusClass(status)}`}>{status === 'Offline' ? <CloudOff/> : <Cloud/>}</span><span><b>{status}</b><small>{state.outbox.length ? `${state.outbox.length} waiting to sync` : online ? 'Shop is up to date' : 'Saved work stays on this device'}</small></span></button>
      <div className="profile-row"><span className="avatar">{(member.display_name || 'Shop').slice(0, 1).toUpperCase()}</span><span><b>{member.display_name || 'Shop user'}</b><small>{adminMode ? 'Admin' : 'Seller'}</small></span><button className="icon-button" aria-label="Sign out" onClick={signOut}><LogOut/></button></div>
    </aside>
    {mobileNav && <button className="nav-backdrop" aria-label="Close menu" onClick={() => setMobileNav(false)}/>}
    <main className="main-column">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open menu" onClick={() => setMobileNav(true)}><Menu/></button><div className="topbar-title"><b>{active === 'Overview' ? 'Shop counter' : active}</b><span>{todayLabel()}</span></div><button onClick={() => state.outbox.length && online ? ledger.sync(true) : go('Settings')} aria-label={`${status}${state.outbox.length ? `, ${state.outbox.length} waiting to sync. Tap to retry` : '. Tap for settings'}`} title={state.outbox.length && online ? 'Tap to retry sync' : 'Open sync settings'} className={`status-chip ${statusClass(status)}`}><i/>{status}{state.outbox.length > 0 && ` · ${state.outbox.length}`}</button></header>
      <div className="page-content">
        {(state.error || (!state.lastSync && !products.length)) && <div className={`sync-banner ${state.error ? 'sync-error' : ''}`} role={state.error ? 'alert' : 'status'}><span>{state.error || (online ? 'Stock will appear here after the first successful sync.' : 'You are offline. Previously saved stock and sales remain available.')}</span><button className="button button-small" disabled={!online} onClick={() => state.error || state.outbox.length ? ledger.sync(true) : go('Settings')}>{state.error || state.outbox.length ? 'Retry sync' : 'Sync details'}</button></div>}
        {active === 'Overview' && <Overview {...{ todaySales, todayRevenue, todayCollected, outstanding, lowStock, products, sales, online, status, state, adminMode, setModal, setActive: go, setSelectedProduct, saving, retrySync: () => ledger.sync(true) }}/>} 
        {active === 'Sales' && <SalesPage {...{ sales, products, state, search, setSearch, saleFilter, setSaleFilter, setModal, setSelected, setReceipt }}/>} 
        {active === 'Inventory' && <InventoryPage {...{ products, search, setSearch, adminMode, setModal, setSelected, selected, updateProduct, totalGoods }}/>} 
        {active === 'Purchases' && adminMode && <PurchasesPage {...{ purchases, products, setModal }}/>} 
        {active === 'Receivables' && <ReceivablesPage {...{ sales, purchases, adminMode, onPay: (row, target) => { setSelected(row); setPaymentTarget(target); setModal('payment'); } }}/>} 
        {active === 'Reports' && adminMode && <ReportsPage {...{ sales, purchases, products, todayRevenue, todayCollected, outstanding, pendingPurchases, lowStock }}/>} 
        {active === 'Settings' && <ShopSettings {...{ member, ledger, state, notify, online }}/>} 
        {active === 'More' && <MorePage {...{ adminMode, go, signOut, state }}/>} 
      </div>
    </main>
    <nav className="mobile-tabbar" aria-label="Quick actions">{primary.map(({ name, label, icon: Icon, action }) => <button key={name} className={`${(action ? modal === 'sale' : active === name) ? 'tab-active' : ''} ${action ? 'tab-sale' : ''}`} aria-label={label} onClick={() => action ? (setSelected(null), setModal('sale')) : go(name)}><Icon/><span>{label}</span></button>)}</nav>
    {modal === 'sale' && <SaleModal products={products.filter(p => p.active !== false)} initial={selected} online={online} onClose={() => setModal('')} onSave={doSale}/>}
    {modal === 'purchase' && adminMode && <PurchaseModal products={products.filter(p => p.active !== false)} onClose={() => setModal('')} onSave={doPurchase} onNewProduct={() => setModal('product')}/>}
    {modal === 'product' && adminMode && <ProductModal onClose={() => setModal('')} onSave={addProduct}/>}
    {modal === 'edit-product' && adminMode && <EditProductModal product={products.find(p => p.id === selected?.id)} onClose={() => setModal('')} onSave={changes => updateProduct(selected.id, changes)}/>}
    {modal === 'payment' && selected && <PaymentModal item={selected} target={paymentTarget} onClose={() => setModal('')} onSave={amount => paymentTarget === 'sale' ? payBalance(selected.id, amount) : paySupplierBalance(selected.id, amount)}/>}
    {receipt && <ReceiptModal sale={sales.find(s => s.id === receipt.id) || receipt} settings={state.settings} online={online} onClose={() => setReceipt(null)} onSend={phone => run(async () => { await ledger.queueSMS(receipt, phone); notify(online ? 'Receipt request saved. Check its status in Settings.' : 'Receipt request saved on this device. It will wait until you reconnect.'); setReceipt(null); })}/>}
    {toast && <div className="toast" role="status"><Info size={18}/>{toast}</div>}
  </div>;
}

function statusClass(status) { return status === 'Needs attention' ? 'status-attention' : status === 'Offline' ? 'status-offline' : status === 'Synced' ? 'status-synced' : 'status-pending'; }
function PageTitle({ title, subtitle, action }) { return <div className="page-title-row"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</div>; }
function EmptyState({ title, text, icon: Icon = FileText, action }) { return <div className="empty-state"><Icon/><b>{title}</b><span>{text}</span>{action}</div>; }
function Overview({ todaySales, todayRevenue, todayCollected, outstanding, lowStock, products, sales, online, status, state = { outbox: [] }, adminMode, setModal, setActive, setSelectedProduct, saving, retrySync }) {
  const recent = sales.slice(0, 4);
  return <>
    <div className="welcome-row"><div><p className="eyebrow">{todayLabel()}</p><h1>Welcome, {adminMode ? 'Admin' : 'shopkeeper'}</h1><p className="welcome-help">Ready for the next customer?</p></div><span className={`status-chip status-chip-large ${statusClass(status)}`}><i/>{status}{state.outbox.length > 0 && ` · ${state.outbox.length}`}</span></div>
    <button className="new-sale-card" onClick={() => { setSelectedProduct(null); setModal('sale'); }}><span className="sale-icon"><Plus/></span><span><b>New Sale</b><small>Choose an item and record payment</small></span><ArrowRight className="sale-arrow"/></button>
    <section className="today-summary" aria-label="Today's summary"><div className="summary-heading"><h2>Today</h2><span>Ghana cedis (GH₵)</span></div><div className="summary-values"><div><span>Sales</span><b>{currency(todayRevenue)}</b><small>{todaySales.length} {todaySales.length === 1 ? 'sale' : 'sales'}</small></div><div><span>Money collected</span><b>{currency(todayCollected)}</b><small>Including payments on older balances</small></div></div></section>
    {(state.error || !online && state.outbox.length > 0) && <div className={`notice ${state.error ? 'notice-error' : ''}`} role={state.error ? 'alert' : 'status'}><span className="notice-symbol">{state.error ? '!' : '↻'}</span><span><b>{state.error ? 'Needs attention' : 'Waiting to sync'}</b><small>{state.error || `${state.outbox.length} saved request(s) will sync when internet returns.`}</small></span><button className="text-link" disabled={!online} onClick={retrySync}>Retry</button></div>}
    {(lowStock.length > 0 || outstanding > 0) && <section className="alert-list"><h2>Needs a look</h2>{lowStock.length > 0 && <button className="alert-row" onClick={() => setActive('Inventory')}><span className="alert-icon alert-amber"><Boxes/></span><span><b>Low stock</b><small>{lowStock.slice(0, 3).map(p => `${p.name} (${p.stock} ${p.unit})`).join(' · ')}{lowStock.length > 3 ? ` · +${lowStock.length - 3} more` : ''}</small></span><ChevronRight/></button>}{outstanding > 0 && <button className="alert-row" onClick={() => setActive('Receivables')}><span className="alert-icon alert-green"><HandCoins/></span><span><b>Customer balances</b><small>{currency(outstanding)} still to collect</small></span><ChevronRight/></button>}</section>}
    <section className="recent-section"><div className="section-heading"><div><h2>Recent sales</h2><p>Latest records from this shop</p></div><button className="text-link" onClick={() => setActive('Sales')}>See all <ArrowRight/></button></div>{recent.length ? <div className="record-list">{recent.map(s => <SaleRecord key={s.clientId || s.id} sale={s} outbox={state.outbox} onReceipt={() => { setSelectedProduct(s); setActive('Sales'); }}/>)}</div> : <EmptyState icon={ShoppingBag} title="No sales recorded yet" text="Your first sale will appear here."/>}</section>
    {adminMode && <button className="admin-shortcut" onClick={() => setActive('More')}><Settings/><span><b>Admin tools</b><small>Purchases, reports, team and shop settings</small></span><ChevronRight/></button>}
  </>;
}

function SaleRecord({ sale, onReceipt, outbox = [] }) { const queued = outbox.find(op => op.kind === 'sale' && op.data?.clientId === sale.clientId); const syncLabel = queued?.error ? 'Needs attention' : queued || sale.syncStatus !== 'synced' ? 'Waiting to sync' : 'Synced'; return <article className="record-card"><div className="record-icon"><ShoppingBag/></div><div className="record-main"><b>{sale.product || 'Sale'}</b><span>{sale.variant} · {sale.quantity} · {displayDate(sale.date)} {sale.time || ''}</span><small>{sale.customer || 'Walk-in'} · {sale.balance > 0 ? `Owes ${currency(sale.balance)}` : 'Paid'}</small></div><div className="record-end"><b>{currency(sale.amount)}</b><span className={`text-status ${syncLabel === 'Synced' ? 'is-synced' : syncLabel === 'Needs attention' ? 'is-error' : 'is-pending'}`}>{syncLabel}</span></div>{onReceipt && <button aria-label={`Open receipt ${sale.id}`} className="icon-button" onClick={onReceipt}><FileText/></button>}</article>; }

function MorePage({ adminMode, go, signOut, state }) {
  const links = [{ name: 'Sales', detail: 'Find a receipt or review past sales', icon: ShoppingCart }, { name: 'Receivables', label: 'Balances', detail: 'Customer payments and amounts still owed', icon: HandCoins }, ...(adminMode ? [{ name: 'Purchases', detail: 'Deliveries and supplier balances', icon: Truck }, { name: 'Reports', detail: 'Daily sales, collections and stock', icon: FileText }] : []), { name: 'Settings', detail: `${state.outbox.length} waiting to sync · team and device settings`, icon: Settings }];
  return <><PageTitle title="More" subtitle="Other shop records and settings."/><div className="more-list">{links.map(({ name, label, detail, icon: Icon }) => <button key={name} className="more-link" onClick={() => go(name)}><span className="more-icon"><Icon/></span><span><b>{label || name}</b><small>{detail}</small></span><ChevronRight/></button>)}<button className="more-link signout-link" onClick={signOut}><span className="more-icon"><LogOut/></span><span><b>Sign out</b><small>Saved records stay on this device</small></span><ChevronRight/></button></div></>;
}

function SalesPage({ sales, products, state = { outbox: [] }, search, setSearch, saleFilter, setSaleFilter, setModal, setSelected, setReceipt }) {
  const filtered = sales.filter(s => (saleFilter === 'All sales' || (saleFilter === 'Outstanding' && s.balance > 0) || (saleFilter === 'Paid' && s.balance === 0)) && `${s.product} ${s.customer} ${s.id}`.toLowerCase().includes(search.toLowerCase()));
  return <><PageTitle title="Sales" subtitle="Receipts and payments recorded by the shop." action={<button className="button" onClick={() => { setSelected(null); setModal('sale'); }}><Plus/>New Sale</button>}/><label className="search-box"><Search/><span className="sr-only">Search sales</span><input placeholder="Search by item, customer or receipt" value={search} onChange={e => setSearch(e.target.value)}/></label><div className="filter-tabs">{['All sales', 'Outstanding', 'Paid'].map(f => <button key={f} className={saleFilter === f ? 'filter-active' : ''} onClick={() => setSaleFilter(f)}>{f}</button>)}</div><div className="record-list">{filtered.map(s => <SaleRecord key={s.clientId || s.id} sale={s} outbox={state?.outbox || []} onReceipt={() => setReceipt(s)}/>)}</div>{!filtered.length && <EmptyState icon={ShoppingBag} title="No sales found" text={sales.length ? 'Try a different search or filter.' : 'Saved sales will appear here.'}/>}</>;
}

function InventoryPage({ products, search, setSearch, adminMode, setModal, setSelected, selected, updateProduct, totalGoods }) {
  const [category, setCategory] = useState('All items');
  const filtered = products.filter(p => (category === 'All items' || (category === 'Rice' ? p.category === 'Rice' : p.category !== 'Rice')) && `${p.name} ${p.variant}`.toLowerCase().includes(search.toLowerCase()));
  return <><PageTitle title="Stock" subtitle={`${products.filter(p => p.active !== false).length} products · ${totalGoods} stock units`} action={adminMode && <button className="button" onClick={() => setModal('product')}><Plus/>Add product</button>}/>{adminMode && <button className="button button-secondary receive-button" onClick={() => setModal('purchase')}><ArrowDownLeft/>Record received stock</button>}<label className="search-box"><Search/><span className="sr-only">Search stock</span><input placeholder="Find a product" value={search} onChange={e => setSearch(e.target.value)}/></label><div className="filter-tabs">{['All items', 'Rice', 'Groceries'].map(f => <button key={f} className={category === f ? 'filter-active' : ''} onClick={() => setCategory(f)}>{f}</button>)}</div><div className="product-list">{filtered.map(p => <article className="product-card" key={p.id}><span className="product-mark"><Wheat/></span><div className="product-info"><b>{p.name}{p.active === false ? ' · Removed' : ''}</b><span>{p.variant}</span><small>{currency(p.price)} / {p.unit}{p.unitPrice !== p.price ? ` · Small unit ${currency(p.unitPrice)}` : ''}</small></div><div className="stock-number"><b>{p.stock}</b><span>{p.unit}{p.stock === 1 ? '' : 's'}</span><small className={p.stock <= p.low ? 'stock-low' : 'stock-ok'}>{p.stock === 0 ? 'Out of stock' : p.stock <= p.low ? 'Low stock' : 'In stock'}</small></div>{adminMode && <button className="button button-small button-secondary" onClick={() => { setSelected(p); setModal('edit-product'); }}>Edit</button>}</article>)}{!filtered.length && <EmptyState icon={Boxes} title="No products found" text={products.length ? 'Try another search or category.' : adminMode ? 'Add products to start recording sales.' : 'Ask the Admin to add products.'} action={adminMode && <button className="button" onClick={() => setModal('product')}>Add product</button>}/>}</div></>;
}

function PurchasesPage({ purchases, products, setModal }) { return <><PageTitle title="Purchases" subtitle="Stock deliveries and supplier payments." action={<button className="button" onClick={() => setModal('purchase')}><Plus/>Record delivery</button>}/><div className="record-list">{purchases.map(p => <article className="record-card" key={p.clientId || p.id}><div className="record-icon"><Truck/></div><div className="record-main"><b>{p.product} · {p.quantity} {products.find(x => x.id === p.productId)?.unit || 'units'}</b><span>{p.supplier} · {displayDate(p.date)}</span><small>{p.balance > 0 ? `Supplier balance ${currency(p.balance)}` : 'Paid in full'}{p.due ? ` · Due ${displayDate(p.due)}` : ''}</small></div><div className="record-end"><b>{currency(p.total)}</b><span className={`text-status ${p.syncStatus === 'synced' ? 'is-synced' : 'is-pending'}`}>{p.syncStatus === 'synced' ? 'Synced' : 'Saved'}</span></div></article>)}{!purchases.length && <EmptyState icon={Truck} title="No deliveries recorded" text="Add a delivery when stock arrives. Unpaid amounts appear under Balances."/>}</div></>; }

function ReceivablesPage({ sales, purchases, adminMode, onPay }) {
  const [tab, setTab] = useState('From customers');
  const customers = sales.filter(s => s.balance > 0), suppliers = purchases.filter(p => p.balance > 0);
  const rows = tab === 'From customers' ? customers : suppliers;
  return <><PageTitle title="Balances" subtitle="Payments still due from customers or suppliers."/><div className="balance-summary"><div><span><ArrowDownRight/> Customers owe</span><b>{currency(customers.reduce((n, x) => n + x.balance, 0))}</b></div>{adminMode && <div><span><ArrowUpRight/> Owed to suppliers</span><b>{currency(suppliers.reduce((n, x) => n + x.balance, 0))}</b></div>}</div><div className="filter-tabs">{['From customers', ...(adminMode ? ['To suppliers'] : [])].map(f => <button key={f} className={tab === f ? 'filter-active' : ''} onClick={() => setTab(f)}>{f}</button>)}</div><div className="record-list">{rows.map(row => <article className="balance-card" key={row.clientId || row.id}><div className="record-main"><b>{tab === 'From customers' ? row.customer : row.supplier}</b><span>{row.product} · {row.id}</span><small>{row.note || 'No payment note'}{row.due ? ` · Due ${displayDate(row.due)}` : ''}</small></div><div className="balance-card-end"><b>{currency(row.balance)}</b><button className="button button-small" onClick={() => onPay(row, tab === 'From customers' ? 'sale' : 'purchase')}>Record payment</button></div></article>)}{!rows.length && <EmptyState icon={CheckCircle2} title={tab === 'From customers' ? 'No customer balances due' : 'No supplier balances due'} text="Any unpaid balances will appear here."/>}</div></>;
}

function ReportsPage({ sales, purchases, products, todayRevenue, todayCollected, outstanding, pendingPurchases, lowStock }) {
  const notes = sales.filter(s => s.date === dateKey() && s.note);
  return <><PageTitle title="Daily report" subtitle={todayLabel()} action={<button className="button button-secondary" onClick={() => window.print()}><Download/>Print report</button>}/><section className="report-summary"><h2>Today’s trade</h2><div className="report-rows"><p><span>Sales value</span><b>{currency(todayRevenue)}</b></p><p><span>Money collected today</span><b>{currency(todayCollected)}</b></p><p><span>Customer balances still due</span><b>{currency(outstanding)}</b></p><p><span>Supplier balances still due</span><b>{currency(pendingPurchases)}</b></p></div></section><section className="recent-section"><div className="section-heading"><div><h2>Stock on hand</h2><p>{lowStock.length} product(s) at or below their low-stock level</p></div></div><div className="product-list">{products.map(p => <article className="product-card" key={p.id}><span className="product-mark"><Wheat/></span><div className="product-info"><b>{p.name}</b><span>{p.variant}</span></div><div className="stock-number"><b>{p.stock}</b><span>{p.unit}s</span></div></article>)}</div></section><section className="recent-section"><h2>Notes recorded today</h2>{notes.length ? notes.map(s => <p className="report-note" key={s.clientId}>{s.product}: {s.note}</p>) : <p className="muted-copy">No notes were recorded today.</p>}<p className="muted-copy">Includes {sales.length} sales and {purchases.length} received purchases saved in this shop.</p></section></>;
}

function ModalShell({ title, subtitle, onClose, children, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { const previous = document.activeElement; const focus = () => (ref.current?.querySelector('[autofocus]') || ref.current)?.focus(); requestAnimationFrame(focus); const key = e => { if (e.key === 'Escape') closeRef.current(); if (e.key === 'Tab' && ref.current) { const items = [...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null); if (!items.length) { e.preventDefault(); ref.current.focus(); return; } const first = items[0], last = items.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus?.(); }; }, []);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dialog-title" className={`modal-card ${wide ? 'modal-wide' : ''}`}><header className="modal-header"><div><h2 id="dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close" onClick={onClose}><X/></button></header>{children}</section></div>;
}

function SaleModal({ products, initial, onClose, onSave }) {
  const [query, setQuery] = useState('');
  const [productId, setProductId] = useState(initial?.id || products[0]?.id || '');
  const product = products.find(p => p.id === productId);
  const isRice = Number(product?.fraction) > 0;
  const [packMode, setPackMode] = useState('pack');
  const [quantity, setQuantity] = useState(1);
  const [customPrice, setCustomPrice] = useState(false);
  const [price, setPrice] = useState(product?.price || 0);
  const [customer, setCustomer] = useState(''); const [phone, setPhone] = useState('');
  const [paid, setPaid] = useState('full'); const [amountPaid, setAmountPaid] = useState('');
  const [method, setMethod] = useState('Cash'); const [note, setNote] = useState('');
  useEffect(() => { setPackMode('pack'); setCustomPrice(false); setPrice(product?.price || 0); }, [productId]);
  useEffect(() => { if (product) setPrice(packMode === 'loose' ? product.unitPrice : product.price); }, [packMode, productId]);
  const options = products.filter(p => `${p.name} ${p.variant}`.toLowerCase().includes(query.toLowerCase()));
  const total = Math.round(Number(price || 0) * Number(quantity || 0) * 100) / 100;
  const payment = paid === 'full' ? total : paid === 'part' ? Number(amountPaid || 0) : 0;
  const stockNeeded = Number(quantity || 0) * (packMode === 'loose' ? Number(product?.fraction || 0) : 1);
  const insufficient = Boolean(product && product.stock < stockNeeded);
  const priceReady = Number(price) > 0 && Number.isFinite(Number(price));
  const customerRequired = paid !== 'full';
  const validPayment = payment >= 0 && payment <= total && (paid !== 'part' || payment > 0 && payment < total);
  const submit = e => {
    e.preventDefault(); if (!product) return;
    const loose = packMode === 'loose';
    onSave({ id: newId('S'), productId, product: product.name, variant: loose ? `Single unit · ${Number(product.fraction) * 100}% of ${product.unit}` : product.variant, quantity: Number(quantity), unitPrice: Number(price), packMode: loose ? 'loose' : 'pack', stockDeduct: stockNeeded, amount: total, paid: payment, balance: Math.max(0, total - payment), customer: customer.trim() || 'Walk-in', phone: phone.trim(), method: payment === 0 ? 'Credit' : method, time: new Date().toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' }), date: dateKey(), createdAt: new Date().toISOString(), note: note.trim() });
  };
  return <ModalShell title="New Sale" subtitle="Choose the item, then confirm payment." onClose={onClose} wide><form className="modal-form sale-form" onSubmit={submit}>
    <label className="search-box sale-search"><Search/><span className="sr-only">Find a product</span><input autoFocus placeholder="Find a product" value={query} onChange={e => setQuery(e.target.value)}/></label>
    <div className="product-choice-list" role="group" aria-label="Choose a product">{options.map(p => <button type="button" key={p.id} className={`product-choice ${p.id === productId ? 'choice-selected' : ''}`} aria-pressed={p.id === productId} onClick={() => setProductId(p.id)}><span className="choice-check">{p.id === productId ? <Check/> : <Wheat/>}</span><span><b>{p.name}</b><small>{p.variant}</small></span><strong>{p.stock} {p.unit}{p.stock === 1 ? '' : 's'}</strong></button>)}{!options.length && <p className="muted-copy">No matching products.</p>}</div>
    {product && <>
      {isRice && <fieldset className="form-section"><legend>What did they buy?</legend><div className="choice-grid"><button type="button" className={`choice-button ${packMode === 'pack' ? 'selected' : ''}`} aria-pressed={packMode === 'pack'} onClick={() => setPackMode('pack')}><Package/><span><b>Full {product.unit}</b><small>{product.variant}</small></span><strong>{currency(product.price)}</strong></button><button type="button" className={`choice-button ${packMode === 'loose' ? 'selected' : ''}`} aria-pressed={packMode === 'loose'} onClick={() => setPackMode('loose')}><Wheat/><span><b>Loose unit</b><small>One unit uses {1 / Number(product.fraction)} of a {product.unit}</small></span><strong>{currency(product.unitPrice)}</strong></button></div></fieldset>}
      <div className="sale-input-grid"><div className="form-field"><label htmlFor="sale-quantity">Quantity</label><div className="quantity-control"><button type="button" aria-label="Decrease quantity" onClick={() => setQuantity(Math.max(1, Number(quantity) - 1))}><Minus/></button><input id="sale-quantity" type="number" min="1" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)}/><button type="button" aria-label="Increase quantity" onClick={() => setQuantity(Math.max(1, Number(quantity || 0) + 1))}><Plus/></button></div></div><div className="form-field"><label>Standard price</label><div className="standard-price">{currency(packMode === 'loose' ? product.unitPrice : product.price)} <span>each</span></div></div></div>
      <label className="toggle-row"><input type="checkbox" checked={customPrice} onChange={e => { setCustomPrice(e.target.checked); setPrice(packMode === 'loose' ? product.unitPrice : product.price); }}/><span>Use a different price for this sale</span></label>
      {customPrice && <label className="form-field negotiated-price"><span>Agreed price for this sale (GH₵)</span><input aria-label="Agreed price for this sale" type="number" inputMode="decimal" min="0.01" step="0.01" required value={price} onChange={e => setPrice(e.target.value)}/><small>The product’s standard price will not change.</small></label>}
      <fieldset className="form-section"><legend>Payment</legend><div className="choice-grid payment-grid">{[['full', 'Paid in full'], ['part', 'Part paid'], ['credit', 'Pay later']].map(([key, label]) => <button type="button" key={key} className={`choice-button payment-choice ${paid === key ? 'selected' : ''}`} aria-pressed={paid === key} onClick={() => setPaid(key)}>{paid === key ? <CheckCircle2/> : <CreditCard/>}<b>{label}</b></button>)}</div>
        {paid === 'part' && <div className="form-field amount-field"><label htmlFor="amount-paid">How much was received?</label><input id="amount-paid" type="number" inputMode="decimal" min="0.01" max={total} step="0.01" required value={amountPaid} onChange={e => setAmountPaid(e.target.value)} placeholder="GH₵"/><small>Balance left: {currency(Math.max(0, total - Number(amountPaid || 0)))}</small></div>}
        {paid !== 'credit' && <label className="form-field payment-method"><span>How was it paid?</span><select value={method} onChange={e => setMethod(e.target.value)}><option>Cash</option><option>MoMo</option><option>Bank transfer</option><option>Other</option></select></label>}
      </fieldset>
      {customerRequired && <div className="credit-fields"><h3>Customer and release details</h3><p>Required when any amount is still owed.</p><label className="form-field"><span>Customer name</span><input required value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Name of the customer"/></label><label className="form-field"><span>Who approved the release, and when will they pay?</span><input required value={note} onChange={e => setNote(e.target.value)} placeholder="For example, owner approved; pay Friday"/></label></div>}
      <div className="form-field receipt-phone"><label htmlFor="receipt-phone">Phone for a digital receipt <span>Optional</span></label><input id="receipt-phone" type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="024 000 0000"/><small>{phone.trim() ? 'A receipt link request will be saved. SMS sends after internet returns.' : 'Leave blank for a printed receipt only.'}</small></div>
      <section className="sale-total" aria-live="polite"><div><span>Sale total</span><b>{currency(total)}</b></div><div><span>Paid now</span><b>{currency(payment)}</b></div><div className="total-due"><span>Still owed</span><b>{currency(Math.max(0, total - payment))}</b></div></section>
      {insufficient && <div className="stock-error" role="alert">Not enough stock. Available: {product.stock} {product.unit}{product.stock === 1 ? '' : 's'}.</div>}
      <button className="button submit-button" type="submit" disabled={!product || !priceReady || !validPayment || insufficient || customerRequired && (!customer.trim() || !note.trim())}>{`Save Sale · ${currency(total)}`}</button>
    </>}
  </form></ModalShell>;
}

function PurchaseModal({ products, onClose, onSave, onNewProduct }) {
  const [productId, setProductId] = useState(products[0]?.id || ''); const product = products.find(p => p.id === productId);
  const [quantity, setQuantity] = useState(''); const [total, setTotal] = useState(''); const [paid, setPaid] = useState(''); const [supplier, setSupplier] = useState(''); const [due, setDue] = useState(''); const [note, setNote] = useState('');
  return <ModalShell title="Record received stock" subtitle="Only record deliveries that have arrived." onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); if (product) onSave({ id: newId('P'), productId, supplier, product: product.name, quantity: Number(quantity), total: Number(total), paid: Number(paid || 0), balance: Math.max(0, Number(total) - Number(paid || 0)), date: dateKey(), due, note }); }}><label className="form-field"><span>Product received</span><select required value={productId} onChange={e => setProductId(e.target.value)}>{products.map(p => <option key={p.id} value={p.id}>{p.name} · {p.variant}</option>)}</select></label>{onNewProduct && <button type="button" className="text-link" onClick={onNewProduct}>Product not listed? Add it first.</button>}<div className="sale-input-grid"><label className="form-field"><span>Quantity received</span><input type="number" min="1" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)}/></label><label className="form-field"><span>Total cost (GH₵)</span><input type="number" min="0.01" step="0.01" required value={total} onChange={e => setTotal(e.target.value)}/></label></div><label className="form-field"><span>Supplier name</span><input required value={supplier} onChange={e => setSupplier(e.target.value)}/></label><div className="sale-input-grid"><label className="form-field"><span>Paid now</span><input type="number" min="0" max={Number(total || 0)} step="0.01" value={paid} onChange={e => setPaid(e.target.value)}/></label><div className="standard-price">Supplier balance <b>{currency(Math.max(0, Number(total || 0) - Number(paid || 0)))}</b></div></div><label className="form-field"><span>Payment due date <small>Optional</small></span><input type="date" value={due} onChange={e => setDue(e.target.value)}/></label><label className="form-field"><span>Note <small>Optional</small></span><input value={note} onChange={e => setNote(e.target.value)}/></label><button className="button submit-button" disabled={!product}>Save received stock</button></form></ModalShell>;
}

function ProductModal({ onClose, onSave }) {
  const [name, setName] = useState(''), [variant, setVariant] = useState(''), [category, setCategory] = useState('Rice'), [unit, setUnit] = useState('bag'), [stock, setStock] = useState('0'), [low, setLow] = useState('0'), [price, setPrice] = useState(''), [unitPrice, setUnitPrice] = useState('');
  return <ModalShell title="Add product" subtitle="Set its exact stock unit, count and selling price." onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); onSave({ name: name.trim(), variant: variant.trim(), category, unit, stock: Number(stock), low: Number(low), price: Number(price), unitPrice: Number(unitPrice || price) }); }}><label className="form-field"><span>Product name</span><input required value={name} onChange={e => setName(e.target.value)}/></label><div className="sale-input-grid"><label className="form-field"><span>Category</span><select value={category} onChange={e => setCategory(e.target.value)}><option>Rice</option><option>Groceries</option><option>Other</option></select></label><label className="form-field"><span>Stock counted as</span><select value={unit} onChange={e => setUnit(e.target.value)}><option>bag</option><option>carton</option><option>bottle</option><option>packet</option><option>item</option></select></label></div><label className="form-field"><span>Pack or description</span><input required value={variant} onChange={e => setVariant(e.target.value)} placeholder="Use the pack size printed on the product"/></label><div className="sale-input-grid"><label className="form-field"><span>Opening stock</span><input type="number" min="0" step="0.01" required value={stock} onChange={e => setStock(e.target.value)}/></label><label className="form-field"><span>Low stock alert at</span><input type="number" min="0" step="0.01" value={low} onChange={e => setLow(e.target.value)}/></label></div><div className="sale-input-grid"><label className="form-field"><span>Price per {unit} (GH₵)</span><input type="number" min="0.01" step="0.01" required value={price} onChange={e => setPrice(e.target.value)}/></label><label className="form-field"><span>Loose price (if configured)</span><input type="number" min="0" step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)}/></label></div><button className="button submit-button">Add product</button></form></ModalShell>;
}

function EditProductModal({ product, onClose, onSave }) {
  const [stock, setStock] = useState(String(product?.stock ?? 0)), [price, setPrice] = useState(String(product?.price ?? 0)), [low, setLow] = useState(String(product?.low ?? 0)), [unitPrice, setUnitPrice] = useState(String(product?.unitPrice ?? 0)), [active, setActive] = useState(product?.active !== false);
  if (!product) return null;
  return <ModalShell title={`Edit ${product.name}`} subtitle="Confirm the physical count before changing stock." onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); onSave({ stock: Number(stock), price: Number(price), low: Number(low), unitPrice: Number(unitPrice), active }); }}><p className="notice"><Info/><span>Changing the stock count replaces this device’s count with the number entered.</span></p><label className="form-field"><span>Stock on hand ({product.unit})</span><input type="number" min="0" step="0.01" value={stock} onChange={e => setStock(e.target.value)}/></label><div className="sale-input-grid"><label className="form-field"><span>Standard price (GH₵)</span><input type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)}/></label><label className="form-field"><span>Loose unit price (GH₵)</span><input type="number" min="0" step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)}/></label></div><label className="form-field"><span>Low-stock alert at</span><input type="number" min="0" step="0.01" value={low} onChange={e => setLow(e.target.value)}/></label><label className="toggle-row"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}/><span>Available to sell</span></label><button className="button submit-button">Save changes</button></form></ModalShell>;
}

function PaymentModal({ onClose, onSave, item, target = 'sale' }) {
  const [amount, setAmount] = useState('');
  return <ModalShell title="Record payment" subtitle={target === 'sale' ? `Payment from ${item?.customer || 'customer'}.` : `Payment to ${item?.supplier || 'supplier'}.`} onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); onSave(Number(amount)); }}><div className="payment-summary"><span>Still owed</span><b>{currency(item?.balance)}</b></div><label className="form-field"><span>{target === 'sale' ? 'Amount received' : 'Amount paid'} (GH₵)</span><input autoFocus type="number" inputMode="decimal" required min="0.01" max={item?.balance} step="0.01" value={amount} onChange={e => setAmount(e.target.value)}/></label><button className="button submit-button" disabled={!Number(amount) || Number(amount) > item?.balance}>Save payment</button></form></ModalShell>;
}

function ReceiptModal({ sale, settings = {}, onClose, onSend, online = false }) {
  const [phone, setPhone] = useState(sale.phone || '');
  return <ModalShell title="Sale saved" subtitle={sale.syncStatus === 'synced' ? 'This sale is synced.' : 'This receipt is saved on this device.'} onClose={onClose}><div className="receipt-card"><div className="receipt-brand"><b>{settings.shop_name || 'Shop'}</b><span>{settings.location || ''}</span></div><div className="receipt-divider"/><div className="receipt-line"><span>Receipt</span><b>{sale.id}</b></div><div className="receipt-line"><span>Date</span><b>{displayDate(sale.date)} · {sale.time}</b></div><div className="receipt-line"><span>Customer</span><b>{sale.customer || 'Walk-in'}</b></div><div className="receipt-divider dotted"/><div className="receipt-product"><div><b>{sale.product}</b><span>{sale.variant} × {sale.quantity}</span></div><b>{currency(sale.amount)}</b></div><div className="receipt-divider"/><div className="receipt-line"><span>Total</span><b>{currency(sale.amount)}</b></div><div className="receipt-line"><span>Paid</span><b>{currency(sale.paid)}</b></div><div className="receipt-line receipt-due"><span>Still owed</span><b>{currency(sale.balance)}</b></div>{sale.note && <p className="receipt-note">Note: {sale.note}</p>}<p className="receipt-thanks">Thank you for shopping with us.</p></div><div className="receipt-send"><button className="button button-secondary print-button" onClick={() => window.print()}><Download/>Print / Save receipt</button>{sale.phone ? <p className="notice"><Send/><span><b>Receipt SMS request saved</b><small>{online ? 'Check Settings for delivery status.' : 'Waiting on this device until internet returns.'}</small></span></p> : <><label className="form-field"><span>Send receipt link by SMS <small>Optional</small></span><input type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="024 000 0000"/></label><button className="button" disabled={!phone.trim()} onClick={() => onSend(phone)}><Send/>Save receipt SMS request</button><p className="muted-copy">{online ? 'The request is saved. Check Settings for delivery status.' : 'Offline: the SMS request will wait on this device until internet returns.'}</p></>}</div></ModalShell>;
}

function PublicReceiptPage({ client }) {
  const token = new URLSearchParams(window.location.search).get('receipt');
  const [receipt, setReceipt] = useState(null); const [loading, setLoading] = useState(true);
  useEffect(() => { let alive = true; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000); (async () => { const local = await cachedReceipt(token).catch(() => null); if (alive) { setReceipt(local); setLoading(false); } if (!client || !token || !navigator.onLine) return; try { const { data, error } = await client.rpc('shop_public_receipt', { receipt_token: token }).abortSignal(controller.signal); if (!error && data) { if (alive) setReceipt(data); void cachedReceipt(token, data).catch(() => {}); } } catch {} })(); return () => { alive = false; clearTimeout(timer); controller.abort(); }; }, [client, token]);
  if (loading) return <main className="public-receipt-page"><div className="public-receipt-state" role="status">Loading receipt…</div></main>;
  if (!receipt) return <main className="public-receipt-page"><div className="public-receipt-state"><h1>Receipt not available yet</h1><p>The sale may still be waiting to sync. Try this link again after the shop reconnects.</p></div></main>;
  return <main className="public-receipt-page"><article className="public-receipt-card"><h1>{receipt.shop?.name || 'Shop'}</h1><p>{receipt.shop?.location || ''}</p><hr/><p>Receipt <b>{receipt.receipt_code}</b></p><p>Customer <b>{receipt.customer_name || 'Walk-in'}</b></p>{(receipt.items || []).map((item, i) => <p key={i}>{item.product} · {item.variant} × {item.quantity}<b>{currency(item.line_total)}</b></p>)}<hr/><p>Total <b>{currency(receipt.sale_total)}</b></p><p>Paid <b>{currency(receipt.amount_paid)}</b></p><p>Balance <b>{currency(receipt.balance)}</b></p><button className="button" onClick={() => window.print()}><Download/>Save / print receipt</button></article></main>;
}

export { AuthGate, ShopSettings, MorePage, InventoryPage, SalesPage, Overview, PurchasesPage, ReceivablesPage, ReportsPage, SaleModal, PurchaseModal, ReceiptModal, ProductModal, EditProductModal, PaymentModal, PublicReceiptPage };
if (typeof document !== 'undefined') createRoot(document.getElementById('root')).render(<PageBoundary><RootApp/></PageBoundary>);
