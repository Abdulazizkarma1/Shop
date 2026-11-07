-- Transactional contract test. Every fixture and ledger change is rolled back.
begin;
select set_config('shop_test.collected_before',(public.shop_daily_summary((now() at time zone 'Africa/Accra')::date)->>'collected'),true);
select set_config('shop_test.owner',(select user_id::text from public.shop_members where role='owner' and active limit 1),true);
do $$ declare uid uuid:=gen_random_uuid();begin
 insert into auth.users(id,email,raw_user_meta_data) values(uid,'contract-'||uid::text||'@example.invalid','{"name":"Contract test"}');
 insert into public.shop_members(user_id,display_name,role) values(uid,'Contract test','attendant');
 perform set_config('shop_test.seller',uid::text,true);
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('shop_test.owner'),true);
do $$ declare pid uuid:=gen_random_uuid();cid text:=gen_random_uuid()::text;rid uuid:=gen_random_uuid();v numeric;data jsonb;payload jsonb;begin
 perform public.shop_save_product(jsonb_build_object('id',pid,'name','Contract rice','unit','bag','category','Rice','stock',2,'low',1,'price',1200,'unitPrice',320,'fraction',0.25));
 payload:=jsonb_build_object('sold_at',now()-interval '1 day','client_id',cid,'receipt_token',rid,'receipt_code','CONTRACT-'||cid,'sale_total',300,'amount_paid',100,'customer_name','Contract customer','note','Owner release; balance tomorrow','items',jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1,'pack_mode','loose','unit_price',300,'line_total',300)));
 data:=public.shop_record_sale(payload);perform public.shop_record_sale(payload);
 select stock into v from public.shop_products where id=pid;if v<>1.75 then raise exception 'Stock deduction or replay failed: %',v;end if;
 if (select count(*) from public.shop_sales where client_id=cid)<>1 then raise exception 'Sale replay duplicated';end if;
 perform public.shop_record_payment(jsonb_build_object('client_id','pay-'||cid,'target','sale','target_client_id',cid,'amount',150));
 select balance into v from public.shop_sales where client_id=cid;if v<>50 then raise exception 'Payment balance failed';end if;
 begin perform public.shop_record_payment(jsonb_build_object('client_id','over-'||cid,'target','sale','target_client_id',cid,'amount',100));raise exception 'Overpayment accepted';exception when others then if sqlerrm='Overpayment accepted' then raise;end if;end;
 perform set_config('shop_test.receipt',rid::text,true);
 perform set_config('request.jwt.claim.sub',current_setting('shop_test.seller'),true);
 begin perform public.shop_save_product(jsonb_build_object('id',gen_random_uuid()));raise exception 'Seller changed product';exception when others then if sqlerrm='Seller changed product' then raise;end if;end;
 begin perform public.shop_record_purchase('{}');raise exception 'Seller recorded purchase';exception when others then if sqlerrm='Seller recorded purchase' then raise;end if;end;
 begin update public.shop_products set stock=99 where id=pid;raise exception 'Direct stock edit allowed';exception when insufficient_privilege then null;end;
 if (select count(*) from public.shop_members)<>1 then raise exception 'Seller can list other team accounts';end if;
 data:=public.shop_get_settings();if data?'owner_phone' then raise exception 'Seller can read owner settings';end if;
end $$;
set local role service_role;
do $$ begin if (public.shop_daily_summary((now() at time zone 'Africa/Accra')::date)->>'collected')::numeric <> current_setting('shop_test.collected_before')::numeric+150 then raise exception 'Collection on older credit sale not counted today';end if;end $$;
set local role anon;
do $$ declare receipt jsonb;begin
 receipt:=public.shop_public_receipt(current_setting('shop_test.receipt')::uuid);
 if receipt is null or receipt?'customer_phone' or receipt?'note' then raise exception 'Public receipt contract failed';end if;
 begin perform public.shop_save_product('{}');raise exception 'Anonymous write allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
