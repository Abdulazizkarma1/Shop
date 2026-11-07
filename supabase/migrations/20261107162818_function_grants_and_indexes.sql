-- Restrict RPCs that read membership or mutate the shop ledger to signed-in roles.
revoke execute on function public.shop_has_access() from anon, public;
revoke execute on function public.shop_is_owner() from anon, public;
revoke execute on function public.shop_record_sale(jsonb) from anon, public;
revoke execute on function public.shop_record_purchase(jsonb) from anon, public;
revoke execute on function public.shop_record_payment(jsonb) from anon, public;
grant execute on function public.shop_has_access() to authenticated;
grant execute on function public.shop_is_owner() to authenticated;
grant execute on function public.shop_record_sale(jsonb) to authenticated;
grant execute on function public.shop_record_purchase(jsonb) to authenticated;
grant execute on function public.shop_record_payment(jsonb) to authenticated;
-- The public receipt lookup is intentionally callable without sign-in: its only key is a random UUID token.
revoke execute on function public.shop_public_receipt(uuid) from public;
grant execute on function public.shop_public_receipt(uuid) to anon, authenticated;

-- Cover the foreign keys used by the ledger screens and payment history.
create index if not exists shop_sales_sold_by_idx on public.shop_sales(sold_by);
create index if not exists shop_sale_items_sale_idx on public.shop_sale_items(sale_id);
create index if not exists shop_sale_items_product_idx on public.shop_sale_items(product_id);
create index if not exists shop_purchases_recorded_by_idx on public.shop_purchases(recorded_by);
create index if not exists shop_purchase_items_purchase_idx on public.shop_purchase_items(purchase_id);
create index if not exists shop_purchase_items_product_idx on public.shop_purchase_items(product_id);
create index if not exists shop_payments_sale_idx on public.shop_payments(sale_id);
create index if not exists shop_payments_purchase_idx on public.shop_payments(purchase_id);
create index if not exists shop_payments_recorded_by_idx on public.shop_payments(recorded_by);

-- Evaluate the request uid once per policy statement.
drop policy if exists shop_members_read on public.shop_members;
create policy shop_members_read on public.shop_members for select to authenticated using ((select auth.uid()) = user_id or public.shop_is_owner());
