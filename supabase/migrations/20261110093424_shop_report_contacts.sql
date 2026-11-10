alter table public.shop_settings
  add column report_phone_2 text check (report_phone_2 ~ '^[1-9][0-9]{9,14}$'),
  add column report_phone_3 text check (report_phone_3 ~ '^[1-9][0-9]{9,14}$');
