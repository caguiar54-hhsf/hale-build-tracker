import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  document.body.innerHTML = `<div style="font-family:system-ui;padding:24px;max-width:560px;margin:auto">
    <h2>Missing Supabase settings</h2>
    <p>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in a <code>.env</code> file (or in Vercel's Environment Variables), then rebuild.</p></div>`;
  throw new Error("Missing Supabase env vars");
}

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
