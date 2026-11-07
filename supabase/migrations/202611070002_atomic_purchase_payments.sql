-- Keep sales, purchases, payments, and inventory changes transaction-safe.
-- User-facing clients should write through these RPCs rather than editing ledger rows directly.
drop policy if exists shop_sales_insert on public.shop_sales;
drop policy if exists shop_sales_owner_update on public.shop_sales;
drop policy if exists shop_sale_items_access on public.shop_sale_items;
create policy shop_sale_items_read on public.shop_sale_items for select to authenticated using (public.shop_has_access());
drop policy if exists shop_purchases_access on public.shop_purchases;
create policy shop_purchases_read on public.shop_purchases for select to authenticated using (public.shop_has_access());
drop policy if exists shop_purchase_items_access on public.shop_purchase_items;
create policy shop_purchase_items_read on public.shop_purchase_items for select to authenticated using (public.shop_has_access());
drop policy if exists shop_payments_access on public.shop_payments;
create policy shop_payments_read on public.shop_payments for select to authenticated using (public.shop_has_access());
revoke insert, update, delete on public.shop_sales, public.shop_sale_items,
  public.shop_purchases, public.shop_purchase_items, public.shop_payments from authenticated;
grant select on public.shop_sales, public.shop_sale_items, public.shop_purchases,
  public.shop_purchase_items, public.shop_payments to authenticated;

create or replace function public.shop_record_sale(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_sale_id uuid; v_code text; v_item jsonb; v_product public.shop_products%rowtype;
  v_total numeric(12,2); v_paid numeric(12,2); v_amount numeric(12,2); v_stock numeric(12,2);
  v_client text; v_receipt_token uuid; v_calculated_total numeric(12,2) := 0; v_count integer := 0;
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
    v_calculated_total := v_calculated_total + (v_item->>'line_total')::numeric;
    v_count := v_count + 1;
    update public.shop_products set stock=stock-v_stock,updated_at=now() where id=v_product.id;
  end loop;
  if v_count = 0 or v_calculated_total <> v_total then raise exception 'Sale total must equal the sum of its items'; end if;
  return jsonb_build_object('id',v_sale_id,'receipt_code',v_code,'receipt_token',v_receipt_token,'duplicate',false);
end $$;

create or replace function public.shop_record_purchase(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid; v_code text; v_item jsonb; v_product public.shop_products%rowtype;
  v_total numeric(12,2); v_paid numeric(12,2); v_qty numeric(12,2); v_client text;
  v_calculated_total numeric(12,2) := 0; v_count integer := 0;
begin
  if not public.shop_has_access() then raise exception 'Shop access required'; end if;
  v_client := payload->>'client_id';
  if v_client is null or length(v_client) > 120 then raise exception 'A unique client_id is required'; end if;
  select id,reference_code into v_id,v_code from public.shop_purchases where client_id=v_client;
  if v_id is not null then return jsonb_build_object('id',v_id,'reference_code',v_code,'duplicate',true); end if;
  v_total := (payload->>'purchase_total')::numeric; v_paid := coalesce((payload->>'amount_paid')::numeric,0);
  if v_total < 0 or v_paid < 0 or v_paid > v_total then raise exception 'Invalid purchase totals'; end if;
  v_code := 'P-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.shop_purchases(client_id,reference_code,supplier_name,supplier_phone,purchase_total,amount_paid,note,due_date,recorded_by)
  values(v_client,v_code,coalesce(nullif(payload->>'supplier_name',''),'Supplier not named'),nullif(payload->>'supplier_phone',''),v_total,v_paid,coalesce(payload->>'note',''),nullif(payload->>'due_date','')::date,auth.uid()) returning id into v_id;
  for v_item in select value from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) loop
    select * into v_product from public.shop_products where id=(v_item->>'product_id')::uuid and active for update;
    if not found then raise exception 'Product is unavailable'; end if;
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty <= 0 then raise exception 'Purchase quantity must be positive'; end if;
    insert into public.shop_purchase_items(purchase_id,product_id,product_name,quantity,unit_cost,line_total)
    values(v_id,v_product.id,v_product.name,v_qty,(v_item->>'unit_cost')::numeric,(v_item->>'line_total')::numeric);
    v_calculated_total := v_calculated_total + (v_item->>'line_total')::numeric;
    v_count := v_count + 1;
    update public.shop_products set stock=stock+v_qty,updated_at=now() where id=v_product.id;
  end loop;
  if v_count = 0 or v_calculated_total <> v_total then raise exception 'Purchase total must equal the sum of its items'; end if;
  return jsonb_build_object('id',v_id,'reference_code',v_code,'duplicate',false);
end $$;

create or replace function public.shop_record_payment(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_client text; v_sale uuid; v_purchase uuid; v_amount numeric(12,2); v_balance numeric(12,2); v_payment uuid;
begin
  if not public.shop_has_access() then raise exception 'Shop access required'; end if;
  v_client := payload->>'client_id';
  if v_client is null or length(v_client) > 120 then raise exception 'A unique client_id is required'; end if;
  select id into v_payment from public.shop_payments where client_id=v_client;
  if v_payment is not null then return jsonb_build_object('id',v_payment,'duplicate',true); end if;
  v_amount := (payload->>'amount')::numeric;
  if v_amount <= 0 then raise exception 'Payment must be positive'; end if;
  if nullif(payload->>'sale_id','') is not null and nullif(payload->>'purchase_id','') is null then
    v_sale := (payload->>'sale_id')::uuid;
    select balance into v_balance from public.shop_sales where id=v_sale and voided_at is null for update;
    if not found or v_amount > v_balance then raise exception 'Payment exceeds the outstanding customer balance'; end if;
    update public.shop_sales set amount_paid=amount_paid+v_amount where id=v_sale;
  elsif nullif(payload->>'purchase_id','') is not null and nullif(payload->>'sale_id','') is null then
    v_purchase := (payload->>'purchase_id')::uuid;
    select balance into v_balance from public.shop_purchases where id=v_purchase for update;
    if not found or v_amount > v_balance then raise exception 'Payment exceeds the outstanding supplier balance'; end if;
    update public.shop_purchases set amount_paid=amount_paid+v_amount where id=v_purchase;
  else
    raise exception 'Exactly one sale_id or purchase_id is required';
  end if;
  insert into public.shop_payments(client_id,sale_id,purchase_id,amount,method,note,recorded_by)
  values(v_client,v_sale,v_purchase,v_amount,coalesce(payload->>'method','Cash'),coalesce(payload->>'note',''),auth.uid()) returning id into v_payment;
  return jsonb_build_object('id',v_payment,'duplicate',false);
end $$;

revoke all on function public.shop_record_purchase(jsonb) from public;
revoke all on function public.shop_record_payment(jsonb) from public;
grant execute on function public.shop_record_purchase(jsonb), public.shop_record_payment(jsonb) to authenticated;
