/* =====================================================================
   SELAH settings. Fill these in after you create your accounts
   (see the setup guide). Leave them empty to run Selah on one device
   only, without sign-in or AI.
   These values are safe to be public: Supabase's "anon" key only works
   together with the security rules in setup.sql.
   ===================================================================== */
window.SELAH_CONFIG = {
  supabaseUrl: "",       // e.g. "https://abcdefghijklmnop.supabase.co"
  supabaseAnonKey: "",   // Supabase → Project Settings → API → "anon public" key
  aiWebhookUrl: ""       // n8n → Selah AI helper → Webhook → Production URL
};
