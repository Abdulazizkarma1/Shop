-- Role checks, durable replay, stable receipts and server-owned SMS dispatch.
alter table public.shop_members add column if not exists email text;
update public.shop_members m set email=u.email from auth.users u where u.id=m.user_id and m.email is null;
alter table public.shop_sales add column if not exists initial_amount_paid numeric(12,2) not null default 0;
alter table public.shop_purchases add column if not exists initial_amount_paid numeric(12,2) not null default 0;
update public.shop_sales s set initial_amount_paid = amount_paid - coalesce((select sum(p.amount) from public.shop_payments p where p.sale_id=s.id),0);
update public.shop_purchases s set initial_amount_paid = amount_paid - coalesce((select sum(p.amount) from public.shop_payments p where p.purchase_id=s.id),0);
alter table public.shop_sms_queue add column if not exists dispatch_state text not null default 'queued' check(dispatch_state in ('queued','sending','sent','failed','unknown'));
update public.shop_sms_queue set dispatch_state=status;
alter table public.shop_sms_queue add column if not exists requested_by uuid references auth.users(id) on delete set null;
alter table public.shop_sms_queue add column if not exists provider_id text;
alter table public.shop_sms_queue add column if not exists claimed_at timestamptz;
create index if not exists shop_sms_requested_by_idx on public.shop_sms_queue(requested_by);
create index if not exists shop_sms_queued_idx on public.shop_sms_queue(created_at) where dispatch_state='queued';
create table if not exists public.shop_audit (
 id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id) on delete set null,
 action text not null, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
alter table public.shop_audit enable row level security;
create index if not exists shop_audit_actor_idx on public.shop_audit(actor_id);
create policy shop_audit_owner_read on public.shop_audit for select to authenticated using(public.shop_is_owner());
grant select on public.shop_audit to authenticated;
revoke insert,update,delete on public.shop_audit from authenticated,anon;

alter policy shop_purchases_read on public.shop_purchases using(public.shop_is_owner());
alter policy shop_purchase_items_read on public.shop_purchase_items using(public.shop_is_owner());
alter policy shop_payments_read on public.shop_payments using(public.shop_is_owner() or (public.shop_has_access() and sale_id is not null));
alter policy shop_settings_access on public.shop_settings using(public.shop_is_owner()) with check(public.shop_is_owner());
alter policy shop_sms_queue_read on public.shop_sms_queue using(public.shop_is_owner() or (public.shop_has_access() and requested_by=(select auth.uid())));

create or replace function public.shop_get_settings() returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not public.shop_has_access() then raise exception 'Shop access required'; end if;
 if public.shop_is_owner() then select to_jsonb(s) into result from public.shop_settings s where id=true;
 else select jsonb_build_object('shop_name',shop_name,'location',location) into result from public.shop_settings where id=true; end if;
 return result;
end $$;
revoke all on function public.shop_get_settings() from public,anon;
grant execute on function public.shop_get_settings() to authenticated;

create or replace function public.shop_save_product(payload jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.shop_products%rowtype; v_id uuid := (payload->>'id')::uuid;
begin
 if not public.shop_is_owner() then raise exception 'Admin access required'; end if;
 if v_id is null then raise exception 'Product ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_id::text,0));
 select * into p from public.shop_products where id=v_id for update;
 if found and (payload->>'expected_updated_at')::timestamptz is distinct from p.updated_at then raise exception 'Product changed on another device. Sync and reopen the product before editing.'; end if;
 insert into public.shop_products(id,name,category,variant,stock_unit,stock,low_stock_at,price,loose_price,loose_stock_fraction,active)
 values(v_id,trim(payload->>'name'),coalesce(payload->>'category','Other'),coalesce(payload->>'variant',''),coalesce(payload->>'unit','item'),(payload->>'stock')::numeric,(payload->>'low')::numeric,(payload->>'price')::numeric,(payload->>'unitPrice')::numeric,coalesce((payload->>'fraction')::numeric,0),coalesce((payload->>'active')::boolean,true))
 on conflict(id) do update set name=excluded.name,category=excluded.category,variant=excluded.variant,stock_unit=excluded.stock_unit,stock=excluded.stock,low_stock_at=excluded.low_stock_at,price=excluded.price,loose_price=excluded.loose_price,loose_stock_fraction=excluded.loose_stock_fraction,active=excluded.active,updated_at=clock_timestamp();
 insert into public.shop_audit(actor_id,action,details) values(auth.uid(),'product_saved',jsonb_build_object('product_id',v_id,'before',to_jsonb(p),'after',payload-'expected_updated_at'));
 return v_id;
end $$;
revoke all on function public.shop_save_product(jsonb) from public,anon;
grant execute on function public.shop_save_product(jsonb) to authenticated;
-- Product changes must use the checked/audited function.
revoke insert,update,delete on public.shop_products from authenticated;

create or replace function public.shop_record_sale(payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_sale public.shop_sales%rowtype; v_p public.shop_products%rowtype; i jsonb; v_id uuid; v_token uuid;
 v_client text:=payload->>'client_id'; v_code text; v_total numeric; v_paid numeric; qty numeric; price numeric; line numeric; deduct numeric; calculated numeric:=0; n integer:=0; ts timestamptz;
begin
 if not public.shop_has_access() then raise exception 'Shop access required'; end if;
 if v_client is null or length(v_client) not between 1 and 120 then raise exception 'Unique client ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_client,0));
 select * into v_sale from public.shop_sales where client_id=v_client;
 if found then return jsonb_build_object('id',v_sale.id,'receipt_code',v_sale.receipt_code,'receipt_token',v_sale.receipt_token,'duplicate',true); end if;
 v_total:=(payload->>'sale_total')::numeric;v_paid:=(payload->>'amount_paid')::numeric;
 if v_total is null or v_paid is null or v_total<0 or v_paid<0 or v_paid>v_total then raise exception 'Invalid sale totals';end if;
 if v_paid<v_total and (trim(coalesce(payload->>'customer_name','')) in ('','Walk-in') or trim(coalesce(payload->>'note',''))='') then raise exception 'Credit sales require a customer and release/payment note';end if;
 v_code:=coalesce(nullif(payload->>'receipt_code',''),'S-'||upper(replace(gen_random_uuid()::text,'-','')));
 if length(v_code)>60 then raise exception 'Receipt code is too long';end if;
 v_token:=coalesce((payload->>'receipt_token')::uuid,gen_random_uuid());ts:=coalesce((payload->>'sold_at')::timestamptz,now());
 if ts>now()+interval '5 minutes' or ts<'2000-01-01'::timestamptz then raise exception 'Check the device date and time';end if;
 insert into public.shop_sales(client_id,receipt_code,receipt_token,customer_name,customer_phone,sale_total,amount_paid,initial_amount_paid,payment_method,note,sold_by,sold_at)
 values(v_client,v_code,v_token,coalesce(nullif(trim(payload->>'customer_name'),''),'Walk-in'),nullif(payload->>'customer_phone',''),v_total,v_paid,v_paid,coalesce(payload->>'payment_method','Cash'),coalesce(payload->>'note',''),auth.uid(),ts) returning id into v_id;
 for i in select value from jsonb_array_elements(coalesce(payload->'items','[]')) loop
  select * into v_p from public.shop_products where id=(i->>'product_id')::uuid and active for update;
  if not found then raise exception 'Product unavailable';end if;
  qty:=(i->>'quantity')::numeric;price:=(i->>'unit_price')::numeric;line:=(i->>'line_total')::numeric;
  if qty is null or price is null or line is null or qty<=0 or qty<>trunc(qty) or price<0 or line<>round(qty*price,2) then raise exception 'Invalid sale item';end if;
  if coalesce(i->>'pack_mode','pack')='loose' then
   if v_p.loose_stock_fraction<=0 then raise exception 'Loose units not configured';end if;
   deduct:=round(qty*v_p.loose_stock_fraction,2);
  elsif coalesce(i->>'pack_mode','pack')='pack' then deduct:=qty;
  else raise exception 'Invalid pack mode';end if;
  if deduct<=0 or deduct>v_p.stock then raise exception 'Not enough stock for %. Admin: check stock, then retry the saved sale.',v_p.name;end if;
  insert into public.shop_sale_items(sale_id,product_id,product_name,variant,quantity,stock_deducted,unit_price,line_total) values(v_id,v_p.id,v_p.name,coalesce(i->>'variant',''),qty,deduct,price,line);
  update public.shop_products set stock=stock-deduct,updated_at=clock_timestamp() where id=v_p.id;
  calculated:=calculated+line;n:=n+1;
 end loop;
 if n=0 or calculated<>v_total then raise exception 'Sale total does not match items';end if;
 return jsonb_build_object('id',v_id,'receipt_code',v_code,'receipt_token',v_token,'duplicate',false);
end $$;

create or replace function public.shop_record_purchase(payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_client text:=payload->>'client_id';v_id uuid;v_code text;v_p public.shop_products%rowtype;i jsonb;v_total numeric;v_paid numeric;qty numeric;line numeric;calculated numeric:=0;n integer:=0;ts timestamptz;
begin
 if not public.shop_is_owner() then raise exception 'Admin access required for purchases';end if;
 if v_client is null or length(v_client) not between 1 and 120 then raise exception 'Unique client ID required';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_client,0));
 select id,reference_code into v_id,v_code from public.shop_purchases where client_id=v_client;
 if found then return jsonb_build_object('id',v_id,'reference_code',v_code,'duplicate',true);end if;
 v_total:=(payload->>'purchase_total')::numeric;v_paid:=(payload->>'amount_paid')::numeric;
 if v_total is null or v_paid is null or v_total<0 or v_paid<0 or v_paid>v_total then raise exception 'Invalid purchase totals';end if;
 v_code:=coalesce(nullif(payload->>'reference_code',''),'P-'||upper(replace(gen_random_uuid()::text,'-','')));ts:=coalesce((payload->>'received_at')::timestamptz,now());
 if length(v_code)>60 or ts>now()+interval '5 minutes' or ts<'2000-01-01'::timestamptz then raise exception 'Invalid reference or device date';end if;
 insert into public.shop_purchases(client_id,reference_code,supplier_name,purchase_total,amount_paid,initial_amount_paid,note,due_date,recorded_by,received_at)
 values(v_client,v_code,coalesce(nullif(trim(payload->>'supplier_name'),''),'Supplier not named'),v_total,v_paid,v_paid,coalesce(payload->>'note',''),nullif(payload->>'due_date','')::date,auth.uid(),ts) returning id into v_id;
 for i in select value from jsonb_array_elements(coalesce(payload->'items','[]')) loop
  select * into v_p from public.shop_products where id=(i->>'product_id')::uuid and active for update;
  if not found then raise exception 'Product unavailable';end if;
  qty:=(i->>'quantity')::numeric;line:=(i->>'line_total')::numeric;
  if qty is null or line is null or qty<=0 or qty<>trunc(qty) or line<0 then raise exception 'Invalid purchase item';end if;
  insert into public.shop_purchase_items(purchase_id,product_id,product_name,quantity,unit_cost,line_total) values(v_id,v_p.id,v_p.name,qty,round(line/qty,2),line);
  update public.shop_products set stock=stock+qty,updated_at=clock_timestamp() where id=v_p.id;
  calculated:=calculated+line;n:=n+1;
 end loop;
 if n=0 or calculated<>v_total then raise exception 'Purchase total does not match items';end if;
 return jsonb_build_object('id',v_id,'reference_code',v_code,'duplicate',false);
end $$;

create or replace function public.shop_record_payment(payload jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_client text:=payload->>'client_id';v_id uuid;v_sale uuid;v_purchase uuid;v_amount numeric;v_balance numeric;ts timestamptz;
begin
 if not public.shop_has_access() then raise exception 'Shop access required';end if;
 if v_client is null or length(v_client) not between 1 and 120 then raise exception 'Unique client ID required';end if;
 perform pg_advisory_xact_lock(hashtextextended(v_client,0));
 select id into v_id from public.shop_payments where client_id=v_client;
 if found then return jsonb_build_object('id',v_id,'duplicate',true);end if;
 v_amount:=(payload->>'amount')::numeric;ts:=coalesce((payload->>'paid_at')::timestamptz,now());
 if v_amount is null or v_amount<=0 or ts>now()+interval '5 minutes' or ts<'2000-01-01'::timestamptz then raise exception 'Invalid payment or device date';end if;
 if payload->>'target'='sale' then
  select id,balance into v_sale,v_balance from public.shop_sales where client_id=payload->>'target_client_id' and voided_at is null for update;
  if not found or v_amount>v_balance then raise exception 'Payment exceeds the customer balance';end if;
  update public.shop_sales set amount_paid=amount_paid+v_amount where id=v_sale;
 elsif payload->>'target'='purchase' then
  if not public.shop_is_owner() then raise exception 'Admin access required for supplier payments';end if;
  select id,balance into v_purchase,v_balance from public.shop_purchases where client_id=payload->>'target_client_id' for update;
  if not found or v_amount>v_balance then raise exception 'Payment exceeds the supplier balance';end if;
  update public.shop_purchases set amount_paid=amount_paid+v_amount where id=v_purchase;
 else raise exception 'Invalid payment target';end if;
 insert into public.shop_payments(client_id,sale_id,purchase_id,amount,method,note,recorded_by,paid_at) values(v_client,v_sale,v_purchase,v_amount,coalesce(payload->>'method','Cash'),coalesce(payload->>'note',''),auth.uid(),ts) returning id into v_id;
 return jsonb_build_object('id',v_id,'duplicate',false);
end $$;

create or replace function public.shop_public_receipt(receipt_token uuid) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('receipt_code',s.receipt_code,'sold_at',s.sold_at,'customer_name',s.customer_name,'sale_total',s.sale_total,'amount_paid',s.amount_paid,'balance',s.balance,
 'shop',coalesce((select jsonb_build_object('name',shop_name,'location',location) from public.shop_settings where id=true),'{}'::jsonb),
 'items',coalesce((select jsonb_agg(jsonb_build_object('product',i.product_name,'variant',i.variant,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total)) from public.shop_sale_items i where i.sale_id=s.id),'[]'::jsonb))
 from public.shop_sales s where s.receipt_token=shop_public_receipt.receipt_token and s.voided_at is null;
$$;

-- Service-only worker helpers. Never grant these to browser roles.
create or replace function public.shop_claim_sms() returns setof public.shop_sms_queue language sql security definer set search_path=public,pg_temp as $$
 update public.shop_sms_queue set dispatch_state='sending',attempts=attempts+1,claimed_at=now()
 where id=(select id from public.shop_sms_queue where dispatch_state='queued' order by created_at for update skip locked limit 1) returning *;
$$;
revoke all on function public.shop_claim_sms() from public,anon,authenticated;
grant execute on function public.shop_claim_sms() to service_role;
create or replace function public.shop_retry_sms(sms_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.shop_is_owner() then raise exception 'Admin access required';end if;
 update public.shop_sms_queue set status='queued',dispatch_state='queued',last_error=null where id=sms_id and dispatch_state='failed';
 if not found then raise exception 'Only a failed request can be retried. Check uncertain requests in Mnotify first.';end if;
end $$;
revoke all on function public.shop_retry_sms(uuid) from public,anon;
grant execute on function public.shop_retry_sms(uuid) to authenticated;

insert into public.shop_products(name,category,variant,stock_unit,price,loose_price,loose_stock_fraction)
select v.name,v.category,v.variant,v.unit,v.price,v.loose,v.fraction from (values
 ('Genie Basmati','Rice','10 kg bag · 4 × 2.5 kg units','bag',1200,320,0.25),
 ('Yellow Basmati','Rice','10 kg bag · 4 × 2.5 kg units','bag',1200,320,0.25),
 ('Red Basmati','Rice','10 kg bag · 4 × 2.5 kg units','bag',1200,320,0.25),
 ('Green Basmati','Rice','10 kg bag · 4 × 2.5 kg units','bag',1200,320,0.25),
 ('Tomato Ketchup','Groceries','Bottle','bottle',0,0,0),('Instant Noodles','Groceries','Carton','carton',0,0,0)
) as v(name,category,variant,unit,price,loose,fraction) where not exists(select 1 from public.shop_products p where p.name=v.name);
