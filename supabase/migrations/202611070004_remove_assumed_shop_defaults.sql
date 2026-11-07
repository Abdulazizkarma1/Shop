-- Leave shop identity fields blank until the owner configures them.
update public.shop_settings set shop_name = '', location = '' where id = true;
alter table public.shop_settings alter column shop_name set default '';
alter table public.shop_settings alter column location set default '';
