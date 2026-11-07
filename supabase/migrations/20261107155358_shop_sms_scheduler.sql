-- Aggregate in SQL rather than relying on the REST API's page limit.
create or replace function public.shop_daily_summary(day_key date) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 with bounds as (select day_key::timestamp at time zone 'Africa/Accra' as a,(day_key+1)::timestamp at time zone 'Africa/Accra' as b),
 daily as (select s.* from public.shop_sales s,bounds where s.sold_at>=a and s.sold_at<b and s.voided_at is null)
 select jsonb_build_object(
 'sale_count',(select count(*) from daily),
 'sales_value',coalesce((select sum(sale_total) from daily),0),
 'collected',coalesce((select sum(initial_amount_paid) from daily),0)+coalesce((select sum(p.amount) from public.shop_payments p join public.shop_sales s on s.id=p.sale_id cross join bounds where p.paid_at>=a and p.paid_at<b and s.voided_at is null),0),
 'customer_due',coalesce((select sum(balance) from public.shop_sales where voided_at is null),0),
 'supplier_due',coalesce((select sum(balance) from public.shop_purchases),0),
 'products',coalesce((select jsonb_agg(jsonb_build_object('name',name,'stock',stock,'stock_unit',stock_unit) order by name) from public.shop_products where active),'[]'::jsonb),
 'notes',coalesce((select jsonb_agg(note) from (select note,sold_at as ts from daily where note<>'' union all select note,received_at from public.shop_purchases,bounds where received_at>=a and received_at<b and note<>'' order by ts desc limit 5) n),'[]'::jsonb));
$$;
revoke all on function public.shop_daily_summary(date) from public,anon,authenticated;
grant execute on function public.shop_daily_summary(date) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- The scheduler credential is generated in the database and remains in Vault.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'shop_sms_job_secret')
where not exists(select 1 from vault.secrets where name='shop_sms_job_secret');
create or replace function public.shop_job_authorized(job_secret text) returns boolean language sql stable security definer set search_path='' as $$
 select job_secret is not null and job_secret=(select decrypted_secret from vault.decrypted_secrets where name='shop_sms_job_secret' limit 1);
$$;
revoke all on function public.shop_job_authorized(text) from public,anon,authenticated;
grant execute on function public.shop_job_authorized(text) to service_role;
-- Replace this URL when installing the schema in a different Supabase project.
select cron.schedule('shop-sms-worker','*/5 * * * *',$job$
 select net.http_post(
  url:='https://fyssbtadzjqvmxglowdf.supabase.co/functions/v1/shop-process-sms',
  headers:=jsonb_build_object('Content-Type','application/json','x-job-secret',(select decrypted_secret from vault.decrypted_secrets where name='shop_sms_job_secret')),
  body:='{}'::jsonb,timeout_milliseconds:=90000);
$job$);
