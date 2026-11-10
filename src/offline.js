import { supabase, normalizePhone, today, invoke, storageScope } from './client.js';

export const blankState = () => ({ products: [], sales: [], purchases: [], payments: [], sms: [], outbox: [], settings: {}, lastSync: null, error: '', accessDenied: false });
const collectionFields = ['products', 'sales', 'purchases', 'payments', 'sms', 'outbox'];

// Older app versions stored a smaller snapshot. Supply fields added later while
// keeping every original field and preserving malformed values for device export.
export function normalizeLedgerState(stored) {
  const defaults = blankState();
  if (stored == null) return defaults;
  if (typeof stored !== 'object' || Array.isArray(stored)) return { ...defaults, recovery: { legacyRecord: stored } };
  const state = { ...defaults, ...stored };
  const recovery = { ...(stored.recovery && typeof stored.recovery === 'object' ? stored.recovery : {}) };
  for (const key of collectionFields) {
    if (Array.isArray(stored[key])) continue;
    if (Object.hasOwn(stored, key)) recovery[key] = stored[key];
    state[key] = defaults[key];
  }
  if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    if (Object.hasOwn(stored, 'settings')) recovery.settings = stored.settings;
    state.settings = {};
  }
  if (Object.keys(recovery).length) state.recovery = recovery;
  return state;
}
const money = n => Math.round(Number(n) * 100) / 100;
const instances = new Map();
let database;
function openDB() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(`grainkeeper-ledger-v2:${storageScope}`, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('workspaces'); request.result.createObjectStore('receipts'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Offline storage is unavailable. Allow browser storage before recording sales.'));
  });
  return database;
}
async function read(userId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('workspaces').objectStore('workspaces').get(userId);
    req.onsuccess = () => resolve(normalizeLedgerState(req.result));
    req.onerror = () => reject(req.error);
  });
}
async function mutate(userId, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaces', 'readwrite');
    const store = tx.objectStore('workspaces');
    const request = store.get(userId);
    let next, failure;
    request.onsuccess = () => {
      try { next = fn(normalizeLedgerState(request.result)); store.put(next, userId); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(failure || new Error('Saving was interrupted. Please retry.'));
    tx.onerror = () => reject(new Error('Could not save on this device. Free storage and retry.'));
  });
}

// The snapshot and outbox are committed together: a receipt never outruns its saved sale.
export function applyOperation(state, op, validate = true) {
  const next = structuredClone(state);
  const d = op.data;
  if (op.kind === 'sale' && next.sales.some(s => s.clientId === d.clientId) || op.kind === 'purchase' && next.purchases.some(p => p.clientId === d.clientId) || op.kind === 'payment' && next.payments.some(p => p.clientId === d.clientId)) return next;
  if (op.kind === 'sale' || op.kind === 'purchase') {
    const p = next.products.find(p => p.id === d.productId);
    if (!p || p.active === false) {
      if(validate) throw new Error('This product is unavailable. Refresh inventory first.');
      next[op.kind === 'sale' ? 'sales' : 'purchases'].unshift({...d,initialPaid:d.paid,syncStatus:'pending'});
      return next;
    }
    if (!Number.isInteger(d.quantity) || d.quantity <= 0 || !Number.isFinite(d.paid) || d.paid < 0) throw new Error('Enter a valid quantity and payment.');
    if (op.kind === 'sale') {
      if (!Number.isFinite(d.amount) || d.amount <= 0 || d.paid > d.amount) throw new Error('Payment cannot exceed the sale total.');
      const deduction = d.quantity * (d.packMode === 'loose' ? Number(p.fraction || 0) : 1);
      if (d.packMode === 'loose' && !p.fraction) throw new Error('Loose units are not configured for this product.');
      if (validate && p.stock < deduction) throw new Error('Not enough stock. Check the count before saving.');
      if (d.paid < d.amount && (d.customer === 'Walk-in' || !d.customer?.trim() || !d.note?.trim())) throw new Error('Credit sales need a customer name and a payment or release note.');
      p.stock = money(p.stock - deduction);
      next.sales.unshift({ ...d, initialPaid: d.paid, stockDeduct: deduction, syncStatus: 'pending' });
    } else {
      if (!Number.isFinite(d.total) || d.total <= 0 || d.paid > d.total) throw new Error('Payment cannot exceed the purchase total.');
      p.stock = money(p.stock + d.quantity);
      next.purchases.unshift({ ...d, initialPaid: d.paid, syncStatus: 'pending' });
    }
  } else if (op.kind === 'payment') {
    const rows = d.target === 'sale' ? next.sales : next.purchases;
    const item = rows.find(x => x.clientId === d.targetClientId);
    if (!item || !Number.isFinite(d.amount) || d.amount <= 0 || validate && d.amount > item.balance) throw new Error('Enter a payment within the outstanding balance.');
    item.paid = money(item.paid + d.amount);
    item.balance = money(item.balance - d.amount);
    next.payments.push(d);
  }
  return next;
}

function productRow(p) {
  return { id: p.id, name: p.name, variant: p.variant, category: p.category, unit: p.stock_unit, stock: Number(p.stock), low: Number(p.low_stock_at), price: Number(p.price), unitPrice: Number(p.loose_price ?? p.price), fraction: Number(p.loose_stock_fraction), active: p.active, updatedAt: p.updated_at, color: p.category === 'Rice' ? 'gold' : 'sage', icon: p.name.slice(0, 1) };
}
async function serverSnapshot() {
  const tables = ['shop_products', 'shop_sales', 'shop_purchases', 'shop_payments', 'shop_settings', 'shop_sms_queue'];
  const pages = await Promise.all(tables.map(async table => {
    if (table === 'shop_settings') { const { data, error } = await supabase.rpc('shop_get_settings'); if(error) throw error; return data ? [data] : []; }
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      let query = supabase.from(table).select(table === 'shop_sales' ? '*,shop_sale_items(*)' : table === 'shop_purchases' ? '*,shop_purchase_items(*)' : '*').order('id').range(offset, offset + 499);
      const { data, error } = await query;
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }));
  const [products, sales, purchases, payments, settings, sms] = pages;
  const date = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra' }).format(new Date(value));
  return {
    ...blankState(), products: products.map(productRow), settings: settings[0] || {}, sms: sms.map(s=>({...s,status:s.dispatch_state||s.status})),
    sales: sales.filter(s => !s.voided_at).map(s => {
      const item = s.shop_sale_items[0] || {};
      return { id: s.receipt_code, dbId: s.id, clientId: s.client_id, receiptToken: s.receipt_token, productId: item.product_id, product: item.product_name || 'Sale', variant: item.variant, quantity: Number(item.quantity), amount: Number(s.sale_total), paid: Number(s.amount_paid), initialPaid: Number(s.initial_amount_paid), balance: Number(s.balance), customer: s.customer_name, phone: s.customer_phone || '', note: s.note, method: s.payment_method, date: date(s.sold_at), time: new Date(s.sold_at).toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra' }), createdAt: s.sold_at, syncStatus: 'synced' };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    purchases: purchases.map(p => {
      const item = p.shop_purchase_items[0] || {};
      return { id: p.reference_code, dbId: p.id, clientId: p.client_id, productId: item.product_id, product: item.product_name || 'Purchase', quantity: Number(item.quantity), supplier: p.supplier_name, total: Number(p.purchase_total), paid: Number(p.amount_paid), initialPaid: Number(p.initial_amount_paid), balance: Number(p.balance), date: date(p.received_at), createdAt: p.received_at, due: p.due_date || '', note: p.note, syncStatus: 'synced' };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    payments: payments.map(p => ({ clientId: p.client_id, target: p.sale_id ? 'sale' : 'purchase', amount: Number(p.amount), date: date(p.paid_at), createdAt: p.paid_at })),
    lastSync: new Date().toISOString(),
  };
}

export function getLedger(userId) {
  if (!instances.has(userId)) instances.set(userId, new Ledger(userId));
  return instances.get(userId);
}
export class Ledger {
  constructor(userId) { this.userId = userId; this.listeners = new Set(); this.serial = Promise.resolve(); this.current = blankState(); }
  async start() { this.current = await read(this.userId); this.emit(); return this.current; }
  emit() { this.listeners.forEach(fn => fn(this.current)); }
  change(fn) {
    const task = this.serial.then(async () => {
      const next = await mutate(this.userId, fn);
      this.current = next; this.emit(); return next;
    });
    this.serial = task.catch(() => {});
    return task;
  }
  async add(kind, data) {
    await this.change(state => {
      if (state.accessDenied) throw new Error('Shop access is disabled. Sign in again.');
      const op = { kind, data, clientId: crypto.randomUUID() };
      let next = applyOperation(state, op);
      next.outbox.push(op);
      if (kind === 'sale' && data.phone) next.outbox.push({ kind: 'sms', clientId: crypto.randomUUID(), data: { receipt_token: data.receiptToken, phone: normalizePhone(data.phone) } });
      return next;
    });
    void this.sync();
  }
  async queueSMS(sale, phone) {
    phone = normalizePhone(phone);
    if (!phone) throw new Error('Enter the customer phone number.');
    await this.change(state => {
      if (!state.outbox.some(x => x.kind === 'sms' && x.data.receipt_token === sale.receiptToken && x.data.phone === phone)) state.outbox.push({ kind: 'sms', clientId: crypto.randomUUID(), data: { receipt_token: sale.receiptToken, phone } });
      return state;
    });
    void this.sync();
  }
  async push(op) {
    const d = op.data;
    if (op.kind === 'sms') return invoke('send-receipt', d);
    let name, payload;
    if (op.kind === 'sale') {
      name = 'shop_record_sale';
      payload = { client_id: d.clientId, receipt_code: d.id, receipt_token: d.receiptToken, sold_at: d.createdAt, customer_name: d.customer, customer_phone: d.phone, sale_total: d.amount, amount_paid: d.paid, payment_method: d.method, note: d.note, items: [{ product_id: d.productId, variant: d.variant, quantity: d.quantity, pack_mode: d.packMode, unit_price: d.unitPrice, line_total: d.amount }] };
    } else if (op.kind === 'purchase') {
      name = 'shop_record_purchase';
      payload = { client_id: d.clientId, reference_code: d.id, received_at: d.createdAt, supplier_name: d.supplier, purchase_total: d.total, amount_paid: d.paid, due_date: d.due, note: d.note, items: [{ product_id: d.productId, quantity: d.quantity, unit_cost: money(d.total / d.quantity), line_total: d.total }] };
    } else {
      name = 'shop_record_payment';
      payload = { client_id: d.clientId, target_client_id: d.targetClientId, target: d.target, amount: d.amount, paid_at: d.createdAt, method: d.method || 'Cash', note: d.note || '' };
    }
    const { error } = await supabase.rpc(name, { payload });
    if (error) throw error;
  }
  async sync(retry = false) {
    if (this.running || !supabase || !navigator.onLine) return this.running;
    const synchronize = async () => {
      try {
        const { data: auth, error: authError } = await supabase.auth.getUser();
        if (authError || auth.user?.id !== this.userId) throw new Error('Sign in again to sync pending records.');
        const { data: member, error: memberError } = await supabase.from('shop_members').select('active').eq('user_id', this.userId).single();
        if (memberError || !member?.active) {
          await this.change(s => ({ ...s, accessDenied: true, error: 'Your shop access has been disabled.' })); return;
        }
        await this.change(s => ({ ...s, accessDenied: false, error: '' }));
        let pushed = false;
        while (this.current.outbox.length) {
          const op = this.current.outbox[0];
          if (op.error && !retry && !op.retryable) break;
          try { await this.push(op); }
          catch (error) {
            await this.change(s => {
              const queued = s.outbox.find(x => x.clientId === op.clientId);
              if (queued) { queued.error = error.message || 'Sync failed. Retry when connected.'; queued.retryable = /fetch|network|connection|timeout|aborted/i.test(queued.error); }
              s.error = queued?.error || 'Sync failed'; return s;
            });
            break;
          }
          await this.change(s => ({ ...s, outbox: s.outbox.filter(x => x.clientId !== op.clientId) })); pushed = true;
        }
        const {data:revision,error:revisionError} = await supabase.rpc('shop_revision');
        if(!revisionError && !pushed && this.current.cloudRevision === revision) return;
        const remote = await serverSnapshot(); remote.cloudRevision = revisionError ? null : revision;
        await this.change(s => {
          let next = { ...remote, outbox: s.outbox, error: s.outbox.find(x => x.error)?.error || '' };
          for (const op of s.outbox) if (op.kind !== 'sms') {
            try { next = applyOperation(next, op, false); }
            catch { next.error = 'A queued record references unavailable inventory. Contact the admin; it remains saved on this device.'; }
          }
          return next;
        });
      } catch (error) { await this.change(s => ({ ...s, error: error.message || 'Could not reach the server. Your records remain saved.' })); }
    };
    this.running = (navigator.locks ? navigator.locks.request(`grainkeeper-sync-${storageScope}-${this.userId}`, synchronize) : synchronize()).finally(() => { this.running = null; });
    return this.running;
  }
  async saveProduct(product) {
    await this.change(s=>s);
    if (!navigator.onLine || this.current.outbox.length) throw new Error('Connect and sync pending records before changing product details.');
    const { error } = await supabase.rpc('shop_save_product', { payload: { ...product, expected_updated_at: product.updatedAt } });
    if (error) throw error;
    if(this.running) await this.running;
    await this.sync();
  }
}

export const collectedToday = state => money(state.sales.filter(s => s.date === today()).reduce((sum, s) => sum + Number(s.initialPaid ?? s.paid), 0) + state.payments.filter(p => p.target === 'sale' && p.date === today()).reduce((sum, p) => sum + p.amount, 0));

export async function cachedReceipt(token, value) {
  const db = await openDB();
  if (value) await new Promise((resolve, reject) => { const tx = db.transaction('receipts', 'readwrite'); tx.objectStore('receipts').put(value, token); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  return new Promise((resolve, reject) => {
    const req = db.transaction('receipts').objectStore('receipts').get(token);
    req.onsuccess = () => {
      if (req.result) return resolve(req.result);
      const all = db.transaction('workspaces').objectStore('workspaces').getAll();
      all.onsuccess = () => {
        for (const state of all.result) {
          const sale = state.sales.find(s => s.receiptToken === token);
          if (sale) return resolve({ shop: { name: state.settings.shop_name, location: state.settings.location }, receipt_code: sale.id, customer_name: sale.customer, sold_at: sale.createdAt, sale_total: sale.amount, amount_paid: sale.paid, balance: sale.balance, items: [{ product: sale.product, variant: sale.variant, quantity: sale.quantity, line_total: sale.amount }] });
        }
        resolve(null);
      };
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// Read-only export of the former, unscoped workspace. Never replay it into another project.
export async function previousProjectData() {
  return new Promise(resolve => {
    const request = indexedDB.open('grainkeeper-ledger-v2');
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('workspaces')) { db.close(); resolve([]); return; }
      const tx = db.transaction('workspaces'), store = tx.objectStore('workspaces');
      const values = store.getAll(), keys = store.getAllKeys();
      tx.oncomplete = () => {
        const records = values.result.map((state, i) => ({ workspaceId: keys.result[i], state })).filter(({ state }) => state.sales?.length || state.purchases?.length || state.payments?.length || state.outbox?.length || state.products?.some(p => Number(p.stock) !== 0));
        db.close(); resolve(records);
      };
      tx.onerror = () => { db.close(); resolve([]); };
    };
  });
}
