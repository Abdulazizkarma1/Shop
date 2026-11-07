-- Correct only the generated starter labels. Counts/prices remain outer-bag based.
update public.shop_products set variant='4 × 10 kg packs', updated_at=clock_timestamp()
where category='Rice' and variant='10 kg bag · 4 × 2.5 kg units'
and name in ('Genie Basmati','Yellow Basmati','Red Basmati','Green Basmati');
