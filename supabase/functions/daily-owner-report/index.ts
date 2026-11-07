import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function clientKey() {
  const names = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
  const name = names.default;
  const key = name ? Deno.env.get(name) : Deno.env.get("SUPABASE_ANON_KEY");
  if (!key) throw new Error("Supabase publishable key is not configured");
  return key;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405, headers: corsHeaders });
  try {
    const jobSecret = Deno.env.get("DAILY_REPORT_JOB_SECRET");
    const suppliedJobSecret = req.headers.get("x-job-secret");
    const isScheduled = Boolean(jobSecret && suppliedJobSecret && suppliedJobSecret === jobSecret);
    let db;
    if (isScheduled) {
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!serviceKey) throw new Error("Service role key is unavailable to the scheduled task");
      db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
    } else {
      const auth = req.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) return Response.json({ error: "Owner sign-in or a scheduled job key is required" }, { status: 401, headers: corsHeaders });
      db = createClient(Deno.env.get("SUPABASE_URL")!, clientKey(), { global: { headers: { Authorization: auth } } });
      const { data: userData, error: userError } = await db.auth.getUser(auth.slice(7));
      if (userError || !userData.user) return Response.json({ error: "A valid owner account is required" }, { status: 401, headers: corsHeaders });
      const { data: owner, error: ownerError } = await db.rpc("shop_is_owner");
      if (ownerError || !owner) return Response.json({ error: "Owner access is required" }, { status: 403, headers: corsHeaders });
    }
    const { data: settings, error: settingsError } = await db.from("shop_settings").select("shop_name,owner_phone,daily_sms_enabled,timezone").eq("id", true).single();
    if (settingsError) throw settingsError;
    if (settings.daily_sms_enabled !== true) return Response.json({ error: "Daily owner SMS is not enabled" }, { status: 409, headers: corsHeaders });
    if (!settings.owner_phone) return Response.json({ error: "Add the owner's phone number first" }, { status: 409, headers: corsHeaders });
    const apiKey = Deno.env.get("MNOTIFY_API_KEY");
    const sender = Deno.env.get("MNOTIFY_SENDER_ID");
    if (!apiKey || !sender) return Response.json({ error: "Mnotify credentials are not configured yet" }, { status: 503, headers: corsHeaders });
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0); // Africa/Accra is UTC year-round.
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const [{ data: sales, error: salesError }, { data: products, error: productsError }, { data: purchases, error: purchasesError }] = await Promise.all([
      db.from("shop_sales").select("sale_total,amount_paid,balance,note").gte("sold_at", start.toISOString()).lt("sold_at", end.toISOString()).is("voided_at", null),
      db.from("shop_products").select("name,stock,stock_unit,low_stock_at").eq("active", true),
      db.from("shop_purchases").select("balance").gt("balance", 0),
    ]);
    if (salesError || productsError || purchasesError) throw salesError ?? productsError ?? purchasesError;
    const sum = (rows: any[], key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
    const low = (products ?? []).filter((p: any) => Number(p.low_stock_at) > 0 && Number(p.stock) <= Number(p.low_stock_at));
    const message = [
      `${settings.shop_name} - daily close`,
      `Sales: ${sales?.length ?? 0} | Value: GHS ${sum(sales ?? [], "sale_total").toFixed(2)} | Collected: GHS ${sum(sales ?? [], "amount_paid").toFixed(2)}`,
      `Customer balances: GHS ${sum(sales ?? [], "balance").toFixed(2)} | Supplier balances: GHS ${sum(purchases ?? [], "balance").toFixed(2)}`,
      `Stock: ${(products ?? []).length} products | ${low.length} low | ${low.slice(0, 3).map((p: any) => p.name).join(", ") || "No low-stock alerts"}`,
      `Notes: ${(sales ?? []).map((s: any) => s.note).filter(Boolean).slice(0, 2).join("; ") || "None"}`,
    ].join("\n");
    const response = await fetch(`https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: [settings.owner_phone], sender, message, is_schedule: false, schedule_date: "" }),
    });
    const result = await response.json();
    if (!response.ok || result.status !== "success") return Response.json({ error: "Mnotify could not send the daily report", provider: result.message ?? "Request failed" }, { status: 502, headers: corsHeaders });
    return Response.json({ sent: true, sales: sales?.length ?? 0, low_stock_products: low.length }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500, headers: corsHeaders });
  }
});
