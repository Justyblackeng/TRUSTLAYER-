const cfg = require("./config");

// Shared Supabase client (null when Supabase isn't configured, e.g. local development).
let sb = null;
if (cfg.supabaseUrl && cfg.supabaseKey) {
  const { createClient } = require("@supabase/supabase-js");
  sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });
}
module.exports = sb;
