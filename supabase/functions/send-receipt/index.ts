import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
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
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return Response.json({ error: "Sign in to send a receipt" }, { status: 401, headers: corsHeaders });
    const token = auth.slice(7);
    const db = createClient(Deno.env.get("SUPABASE_URL")!, clientKey(), { global: { headers: { Authorization: auth } } });
    const { data: userData, error: userError } = await db.auth.getUser(token);
    if (userError || !userData.user) return Response.json({ error: "A valid shop account is required" }, { status: 401, headers: corsHeaders });
    const { data: allowed, error: accessError } = await db.rpc("shop_has_access");
    if (accessError || !allowed) return Response.json({ error: "Shop access is required" }, { status: 403, headers: corsHeaders });
    const { receipt_token, phone } = await req.json();
    const normalized = String(phone ?? "").replace(/[\s()-]/g, "");
    if (!receipt_token || !/^\+?[0-9]{10,15}$/.test(normalized)) return Response.json({ error: "Enter a valid customer phone number and receipt" }, { status: 400, headers: corsHeaders });
    const apiKey = Deno.env.get("MNOTIFY_API_KEY");
    const sender = Deno.env.get("MNOTIFY_SENDER_ID");
    const appUrl = Deno.env.get("PUBLIC_APP_URL");
    if (!apiKey || !sender || !appUrl) return Response.json({ error: "Receipt SMS is not configured yet" }, { status: 503, headers: corsHeaders });
    const { data: receipt, error: receiptError } = await db.rpc("shop_public_receipt", { receipt_token });
    if (receiptError || !receipt) return Response.json({ error: "Receipt not found" }, { status: 404, headers: corsHeaders });
    const link = `${appUrl.replace(/\/$/, "")}/?receipt=${encodeURIComponent(receipt_token)}`;
    const message = `${receipt.shop?.name ?? "Shop"}: Your receipt ${receipt.receipt_code} is ready. Total ${Number(receipt.sale_total).toFixed(2)} GHS. View: ${link}`;
    const response = await fetch(`https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: [normalized], sender, message, is_schedule: false, schedule_date: "" }),
    });
    const result = await response.json();
    if (!response.ok || result.status !== "success") return Response.json({ error: "Mnotify could not send the receipt", provider: result.message ?? "Request failed" }, { status: 502, headers: corsHeaders });
    return Response.json({ sent: true, receipt_code: receipt.receipt_code }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500, headers: corsHeaders });
  }
});
