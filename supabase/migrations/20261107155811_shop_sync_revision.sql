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
 if v_total is null or v_paid is null or v_total<=0 or v_paid<0 or v_paid>v_total then raise exception 'Invalid sale totals';end if;
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
  if qty is null or price is null or line is null or qty<=0 or qty<>trunc(qty) or price<=0 or line<>round(qty*price,2) then raise exception 'Invalid sale item';end if;
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
 if v_total is null or v_paid is null or v_total<=0 or v_paid<0 or v_paid>v_total then raise exception 'Invalid purchase totals';end if;
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


-- Lightweight change detection avoids downloading the full ledger every poll.
create or replace function public.shop_revision() returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
declare revision text;
begin
 if not public.shop_has_access() then raise exception 'Shop access required';end if;
 select md5(concat_ws('|',
 (select max(updated_at)::text from public.shop_products),
 (select count(*)::text from public.shop_sales),
 (select count(*)::text from public.shop_purchases),
 (select count(*)::text from public.shop_payments),
 (select max(updated_at)::text from public.shop_settings),
 (select string_agg(dispatch_state||':'||n::text,',' order by dispatch_state) from (select dispatch_state,count(*) n from public.shop_sms_queue group by dispatch_state) s)
 )) into revision;
 return revision;
end $$;
revoke all on function public.shop_revision() from public,anon;
grant execute on function public.shop_revision() to authenticated;
