-- Grainkeeper: isolated shop ledger tables for the existing Supabase project.
-- All exposed records are protected by shop membership policies.
create table if not exists public.shop_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null check (role in ('owner','attendant')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.shop_has_access()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.shop_members m where m.user_id = auth.uid() and m.active); $$;
create or replace function public.shop_is_owner()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.shop_members m where m.user_id = auth.uid() and m.active and m.role = 'owner'); $$;
revoke all on function public.shop_has_access() from public;
revoke all on function public.shop_is_owner() from public;
grant execute on function public.shop_has_access() to authenticated;
grant execute on function public.shop_is_owner() to authenticated;

create table if not exists public.shop_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  category text not null default 'Other',
  variant text not null default '',
  stock_unit text not null default 'item',
  stock numeric(12,2) not null default 0 check (stock >= 0),
  low_stock_at numeric(12,2) not null default 0 check (low_stock_at >= 0),
  price numeric(12,2) not null default 0 check (price >= 0),
  loose_price numeric(12,2) check (loose_price is null or loose_price >= 0),
  loose_stock_fraction numeric(6,4) not null default 0 check (loose_stock_fraction >= 0 and loose_stock_fraction <= 1),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shop_sales (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  receipt_code text not null unique,
  receipt_token uuid not null default gen_random_uuid() unique,
  customer_name text not null default 'Walk-in',
  customer_phone text,
  sale_total numeric(12,2) not null check (sale_total >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  balance numeric(12,2) generated always as (sale_total - amount_paid) stored,
  payment_method text not null default 'Cash',
  note text not null default '',
  sold_by uuid not null references auth.users(id),
  sold_at timestamptz not null default now(),
  voided_at timestamptz,
  check (amount_paid <= sale_total)
);
create index if not exists shop_sales_sold_at_idx on public.shop_sales (sold_at desc) where voided_at is null;
create index if not exists shop_sales_balance_idx on public.shop_sales (balance desc) where balance > 0 and voided_at is null;

create table if not exists public.shop_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.shop_sales(id) on delete cascade,
  product_id uuid references public.shop_products(id) on delete set null,
  product_name text not null,
  variant text not null default '',
  quantity numeric(12,2) not null check (quantity > 0),
  stock_deducted numeric(12,2) not null check (stock_deducted >= 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0)
);

create table if not exists public.shop_purchases (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  reference_code text not null unique,
  supplier_name text not null default 'Supplier not named',
  supplier_phone text,
  purchase_total numeric(12,2) not null check (purchase_total >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  balance numeric(12,2) generated always as (purchase_total - amount_paid) stored,
  note text not null default '',
  due_date date,
  recorded_by uuid not null references auth.users(id),
  received_at timestamptz not null default now(),
  check (amount_paid <= purchase_total)
);
create index if not exists shop_purchases_received_idx on public.shop_purchases (received_at desc);
create index if not exists shop_purchases_balance_idx on public.shop_purchases (balance desc) where balance > 0;

create table if not exists public.shop_purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.shop_purchases(id) on delete cascade,
  product_id uuid references public.shop_products(id) on delete set null,
  product_name text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  line_total numeric(12,2) not null check (line_total >= 0)
);

create table if not exists public.shop_payments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  sale_id uuid references public.shop_sales(id),
  purchase_id uuid references public.shop_purchases(id),
  amount numeric(12,2) not null check (amount > 0),
  method text not null default 'Cash',
  note text not null default '',
  recorded_by uuid not null references auth.users(id),
  paid_at timestamptz not null default now(),
  check ((sale_id is not null)::int + (purchase_id is not null)::int = 1)
);

create table if not exists public.shop_settings (
  id boolean primary key default true check (id),
  shop_name text not null default '',
  location text not null default '',
  owner_name text not null default '',
  owner_phone text,
  daily_sms_enabled boolean not null default false,
  daily_sms_time time not null default '19:00',
  timezone text not null default 'Africa/Accra',
  updated_at timestamptz not null default now()
);
create table if not exists public.shop_sms_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('receipt','daily_report')),
  recipient text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.shop_members enable row level security;
alter table public.shop_products enable row level security;
alter table public.shop_sales enable row level security;
alter table public.shop_sale_items enable row level security;
alter table public.shop_purchases enable row level security;
alter table public.shop_purchase_items enable row level security;
alter table public.shop_payments enable row level security;
alter table public.shop_settings enable row level security;
alter table public.shop_sms_queue enable row level security;

drop policy if exists shop_members_read on public.shop_members;
create policy shop_members_read on public.shop_members for select to authenticated using (user_id = auth.uid() or public.shop_is_owner());
drop policy if exists shop_members_owner_write on public.shop_members;
create policy shop_members_owner_write on public.shop_members for all to authenticated using (public.shop_is_owner()) with check (public.shop_is_owner());

drop policy if exists shop_products_read on public.shop_products;
create policy shop_products_read on public.shop_products for select to authenticated using (public.shop_has_access());
drop policy if exists shop_products_owner_insert on public.shop_products;
create policy shop_products_owner_insert on public.shop_products for insert to authenticated with check (public.shop_is_owner());
drop policy if exists shop_products_owner_update on public.shop_products;
create policy shop_products_owner_update on public.shop_products for update to authenticated using (public.shop_is_owner()) with check (public.shop_is_owner());

drop policy if exists shop_sales_read on public.shop_sales;
create policy shop_sales_read on public.shop_sales for select to authenticated using (public.shop_has_access());
drop policy if exists shop_sales_insert on public.shop_sales;
create policy shop_sales_insert on public.shop_sales for insert to authenticated with check (public.shop_has_access() and sold_by = auth.uid());
drop policy if exists shop_sales_owner_update on public.shop_sales;
create policy shop_sales_owner_update on public.shop_sales for update to authenticated using (public.shop_is_owner()) with check (public.shop_is_owner());

drop policy if exists shop_sale_items_access on public.shop_sale_items;
create policy shop_sale_items_access on public.shop_sale_items for all to authenticated using (public.shop_has_access()) with check (public.shop_has_access());

drop policy if exists shop_purchases_access on public.shop_purchases;
create policy shop_purchases_access on public.shop_purchases for all to authenticated using (public.shop_has_access()) with check (public.shop_has_access() and recorded_by = auth.uid());
drop policy if exists shop_purchase_items_access on public.shop_purchase_items;
create policy shop_purchase_items_access on public.shop_purchase_items for all to authenticated using (public.shop_has_access()) with check (public.shop_has_access());
drop policy if exists shop_payments_access on public.shop_payments;
create policy shop_payments_access on public.shop_payments for all to authenticated using (public.shop_has_access()) with check (public.shop_has_access() and recorded_by = auth.uid());
drop policy if exists shop_settings_access on public.shop_settings;
create policy shop_settings_access on public.shop_settings for all to authenticated using (public.shop_has_access()) with check (public.shop_is_owner());
drop policy if exists shop_sms_queue_read on public.shop_sms_queue;
create policy shop_sms_queue_read on public.shop_sms_queue for select to authenticated using (public.shop_is_owner());

-- Atomic sale writer: idempotent for offline replay; inventory and ledger commit together.
create or replace function public.shop_record_sale(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_sale_id uuid; v_code text; v_item jsonb; v_product public.shop_products%rowtype;
  v_total numeric(12,2); v_paid numeric(12,2); v_amount numeric(12,2); v_stock numeric(12,2);
  v_client text; v_receipt_token uuid;
begin
  if not public.shop_has_access() then raise exception 'Shop access required'; end if;
  v_client := payload->>'client_id';
  if v_client is null or length(v_client) > 120 then raise exception 'A unique client_id is required'; end if;
  select id, receipt_code, receipt_token into v_sale_id, v_code, v_receipt_token from public.shop_sales where client_id = v_client;
  if v_sale_id is not null then return jsonb_build_object('id',v_sale_id,'receipt_code',v_code,'receipt_token',v_receipt_token,'duplicate',true); end if;
  v_total := (payload->>'sale_total')::numeric; v_paid := coalesce((payload->>'amount_paid')::numeric,0);
  if v_total < 0 or v_paid < 0 or v_paid > v_total then raise exception 'Invalid sale totals'; end if;
  v_code := 'S-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.shop_sales(client_id,receipt_code,customer_name,customer_phone,sale_total,amount_paid,payment_method,note,sold_by)
  values(v_client,v_code,coalesce(nullif(payload->>'customer_name',''),'Walk-in'),nullif(payload->>'customer_phone',''),v_total,v_paid,coalesce(payload->>'payment_method','Cash'),coalesce(payload->>'note',''),auth.uid())
  returning id, receipt_token into v_sale_id, v_receipt_token;
  for v_item in select value from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) loop
    select * into v_product from public.shop_products where id=(v_item->>'product_id')::uuid and active for update;
    if not found then raise exception 'Product is unavailable'; end if;
    v_amount := (v_item->>'quantity')::numeric;
    v_stock := (v_item->>'stock_deducted')::numeric;
    if v_amount <= 0 or v_stock < 0 or v_product.stock < v_stock then raise exception 'Not enough stock for %',v_product.name; end if;
    insert into public.shop_sale_items(sale_id,product_id,product_name,variant,quantity,stock_deducted,unit_price,line_total)
    values(v_sale_id,v_product.id,v_product.name,coalesce(v_item->>'variant',''),v_amount,v_stock,(v_item->>'unit_price')::numeric,(v_item->>'line_total')::numeric);
    update public.shop_products set stock=stock-v_stock,updated_at=now() where id=v_product.id;
  end loop;
  return jsonb_build_object('id',v_sale_id,'receipt_code',v_code,'receipt_token',v_receipt_token,'duplicate',false);
end $$;
revoke all on function public.shop_record_sale(jsonb) from public;
grant execute on function public.shop_record_sale(jsonb) to authenticated;

-- Receipt links can resolve only a random receipt token; no customer list endpoint is public.
create or replace function public.shop_public_receipt(receipt_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'shop',coalesce((select jsonb_build_object('name',shop_name,'location',location) from public.shop_settings where id=true),'{}'::jsonb),
    'receipt_code',s.receipt_code,'customer_name',s.customer_name,'sale_total',s.sale_total,'amount_paid',s.amount_paid,'balance',s.balance,'sold_at',s.sold_at,
    'items',coalesce((select jsonb_agg(jsonb_build_object('product',i.product_name,'variant',i.variant,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total)) from public.shop_sale_items i where i.sale_id=s.id),'[]'::jsonb)
  ) from public.shop_sales s where s.receipt_token=shop_public_receipt.receipt_token and s.voided_at is null;
$$;
revoke all on function public.shop_public_receipt(uuid) from public;
grant execute on function public.shop_public_receipt(uuid) to anon, authenticated;

insert into public.shop_settings(id) values(true) on conflict(id) do nothing;
grant select, insert, update on public.shop_products, public.shop_sales, public.shop_sale_items, public.shop_purchases, public.shop_purchase_items, public.shop_payments, public.shop_settings, public.shop_members, public.shop_sms_queue to authenticated;
