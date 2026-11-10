import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyOperation, blankState, Ledger, cachedReceipt, collectedToday, previousProjectData } from '../src/offline.js';
import { normalizePhone, today, projectScope } from '../src/client.js';
import * as UI from '../.checks/ui.mjs';
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
const product = { id: 'rice', name: 'Rice', category: 'Rice', variant: '4 × 10 kg packs', unit: 'bag', stock: 3, low: 1, price: 1200, unitPrice: 320, fraction: .25, active: true, color: 'gold', icon: 'R' };
const fixture = () => ({ ...blankState(), products: [{ ...product }] });
const sale = (extra = {}) => ({ id: 'S-TEST', clientId: crypto.randomUUID(), receiptToken: crypto.randomUUID(), productId: 'rice', product: 'Rice', variant: 'Loose unit', quantity: 1, packMode: 'loose', unitPrice: 300, stockDeduct: .25, amount: 300, paid: 100, balance: 200, customer: 'Customer', phone: '', note: 'Owner release; balance tomorrow', date: today(), time: '10:00', createdAt: new Date().toISOString(), method: 'Cash', ...extra });
const noop = () => {};
test('quarter-bag sale keeps negotiated value, credit and input immutable', () => {
  const state = fixture(), d = sale(), next = applyOperation(state, { kind: 'sale', data: d });
  assert.equal(state.products[0].stock, 3); assert.equal(next.products[0].stock, 2.75); assert.equal(next.sales[0].amount, 300); assert.equal(next.sales[0].initialPaid, 100);
  assert.equal(applyOperation(next, { kind: 'sale', data: d }).sales.length, 1);
});
test('invalid stock, credit identity and overpayments are rejected', () => {
  assert.throws(() => applyOperation(fixture(), { kind: 'sale', data: sale({ quantity: 13 }) }), /stock/i);
  assert.throws(() => applyOperation(fixture(), { kind: 'sale', data: sale({ customer: 'Walk-in' }) }), /customer/i);
  assert.throws(() => applyOperation(fixture(), { kind: 'sale', data: sale({ paid: 400 }) }), /exceed/i);
});
test('customer payment received today on an older sale counts today once', () => {
  const d = sale({ date: '2026-01-01' });
  const next = applyOperation(applyOperation(fixture(), { kind: 'sale', data: d }), { kind: 'payment', data: { clientId: 'pay1', target: 'sale', targetClientId: d.clientId, amount: 150, date: today() } });
  assert.equal(next.sales[0].balance, 50); assert.equal(collectedToday(next), 150);
  assert.throws(() => applyOperation(next, { kind: 'payment', data: { clientId: 'pay2', target: 'sale', targetClientId: d.clientId, amount: 100 } }), /balance/i);
});
test('IndexedDB commits sale plus SMS outbox and survives reopening', async () => {
  const id = crypto.randomUUID(), ledger = new Ledger(id); await ledger.start(); await ledger.change(() => fixture());
  const d = sale({ phone: '0241234567' }); await ledger.add('sale', d);
  const reopened = new Ledger(id); await reopened.start();
  assert.equal(reopened.current.products[0].stock, 2.75); assert.equal(reopened.current.outbox.length, 2); assert.equal(reopened.current.outbox[1].data.phone, '233241234567');
  const receipt = await cachedReceipt(d.receiptToken); assert.equal(receipt.receipt_code, d.id);
});
test('two tabs cannot overwrite each other’s saved sales', async () => {
  const id = crypto.randomUUID(), a = new Ledger(id), b = new Ledger(id);
  await a.start(); await a.change(() => fixture()); await b.start();
  await Promise.all([a.add('sale', sale()), b.add('sale', sale({ id: 'S-SECOND' }))]);
  const final = new Ledger(id); await final.start(); assert.equal(final.current.sales.length, 2); assert.equal(final.current.outbox.length, 2); assert.equal(final.current.products[0].stock, 2.5);
});
test('a failed local write does not issue a sale or leave an outbox item', async () => {
  const ledger = new Ledger(crypto.randomUUID()); await ledger.start(); await ledger.change(() => fixture());
  await assert.rejects(() => ledger.add('sale', sale({ quantity: 50 })), /stock/i); assert.equal(ledger.current.sales.length, 0); assert.equal(ledger.current.outbox.length, 0);
});
test('Ghana phone normalization accepts local and international forms', () => {
  assert.equal(normalizePhone('024 123 4567'), '233241234567'); assert.equal(normalizePhone('+233241234567'), '233241234567'); assert.equal(normalizePhone(''), ''); assert.throws(() => normalizePhone('abc'), /valid/);
});
for (const filled of [false, true]) for (const adminMode of [false, true]) {
  test(`every dashboard page renders with ${filled ? 'saved' : 'empty'} data as ${adminMode ? 'Admin' : 'Seller'}`, () => {
    const sales = filled ? [sale()] : [], purchases = filled ? [{ id: 'P-TEST', clientId: 'p1', supplier: 'Supplier', product: 'Rice', quantity: 1, total: 1000, paid: 500, balance: 500, date: today(), due: '', note: '' }] : [];
    const props = { products: filled ? [product] : [], sales, purchases, search: '', setSearch: noop, saleFilter: 'All sales', setSaleFilter: noop, adminMode, modal: '', selectedProduct: product, selected: product, state: { ...blankState(), outbox: [] }, status: 'Synced', setModal: noop, setSelected: noop, setSelectedProduct: noop, updateProduct: noop, setActive: noop, setReceipt: noop, onReceipt: noop, payBalance: noop, paySupplierBalance: noop, totalGoods: filled ? 3 : 0, todaySales: sales, todayRevenue: 300, todayCollected: 100, outstanding: 200, pendingPurchases: 500, lowStock: [], online: true, notify: noop, smartOpen: false, setSmartOpen: noop };
    for (const name of ['Overview', 'SalesPage', 'InventoryPage', 'PurchasesPage', 'ReceivablesPage', 'ReportsPage']) assert.ok(renderToStaticMarkup(React.createElement(UI[name], props)).length > 20, name);
    assert.ok(renderToStaticMarkup(React.createElement(UI.InventoryPage, { ...props, products: [product] })).includes('Rice'));
    if (adminMode) assert.ok(renderToStaticMarkup(React.createElement(UI.EditProductModal, { product, onClose: noop, onSave: noop })).includes('Save changes'));
  });
}
test('sale, purchase and receipt dialogs render without a database connection', () => {
  for (const [name, props] of [['SaleModal',{products:[product]}],['SaleModal',{products:[]}],['PurchaseModal',{products:[product]}],['ProductModal',{}],['EditProductModal',{product}],['ReceiptModal',{sale:sale(),settings:{}}]]) assert.ok(renderToStaticMarkup(React.createElement(UI[name],{...props,onClose:noop,onSave:noop,onSend:noop,onArchive:noop,onNewProduct:noop})).length>30);
});

test('counter sale screen uses product buttons, keeps standard price explicit, and requires credit details', () => {
  const html=renderToStaticMarkup(React.createElement(UI.SaleModal,{products:[product],onClose:noop,onSave:noop}));
  assert.match(html,/Choose a product/); assert.match(html,/Standard price/); assert.match(html,/Use a different price for this sale/);
  assert.match(html,/Paid in full/); assert.match(html,/Part paid/); assert.match(html,/Pay later/); assert.match(html,/Phone for a digital receipt/);
  assert.doesNotMatch(html,/barcode|scanner|camera scan/i);
});

test('compact More destination keeps seller and admin tools separated', () => {
  const seller=renderToStaticMarkup(React.createElement(UI.MorePage,{adminMode:false,go:noop,signOut:noop,state:blankState()}));
  const admin=renderToStaticMarkup(React.createElement(UI.MorePage,{adminMode:true,go:noop,signOut:noop,state:blankState()}));
  assert.match(seller,/Sales/); assert.match(seller,/Balances/); assert.doesNotMatch(seller,/Purchases|Daily report/);
  assert.match(admin,/Purchases/); assert.match(admin,/Reports/); assert.match(admin,/Settings/);
});

test('login and both role settings screens render', () => {
  assert.ok(renderToStaticMarkup(React.createElement(UI.AuthGate, {}, () => null)).includes('Sign in to your shop'));
  for(const role of ['owner','attendant']) {
    const html=renderToStaticMarkup(React.createElement(UI.ShopSettings,{member:{userId:'test',role,email:'test@example.invalid'},ledger:{},state:blankState(),notify:noop,online:false}));
    assert.ok(html.includes('Offline records')); assert.equal(html.includes('Create a user'),role==='owner');
  }
});
test('a cloud-rejected product does not hide its saved offline receipt during rebase', () => {
  const d=sale(); const result=applyOperation(blankState(),{kind:'sale',data:d},false); assert.equal(result.sales[0].receiptToken,d.receiptToken);
});

test('project changes use separate cache and offline sign-in namespaces', () => {
  assert.notEqual(projectScope('https://project-one.supabase.co'), projectScope('https://project-two.supabase.co'));
  assert.equal(projectScope('not-a-url'), 'unconfigured');
});
test('previous-project records can be exported without entering the new ledger', async () => {
  const oldUser='previous-user';
  const oldDB=await new Promise((resolve,reject)=>{const r=indexedDB.open('grainkeeper-ledger-v2',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspaces');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise((resolve,reject)=>{const t=oldDB.transaction('workspaces','readwrite');t.objectStore('workspaces').put({...blankState(),outbox:[{kind:'sale',clientId:'previous-record',data:{}}]},oldUser);t.oncomplete=resolve;t.onerror=()=>reject(t.error);});
  oldDB.close();
  const records=await previousProjectData();assert.equal(records[0].workspaceId,oldUser);assert.equal(records[0].state.outbox[0].clientId,'previous-record');
  const current=new Ledger(oldUser);await current.start();assert.equal(current.current.outbox.length,0);
});
