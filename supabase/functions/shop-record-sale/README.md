The shop sales transaction is implemented as the `shop_record_sale(jsonb)` database RPC in the migration. Calling the RPC is atomic and stock-safe; it does not need a separate Edge Function.
