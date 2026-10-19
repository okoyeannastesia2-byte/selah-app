// Selah AI bridge (Vercel serverless function).
// The app calls POST /api/ai with the person's sign-in token.
// This function: 1) checks the token with Supabase, 2) applies the daily limit,
// 3) forwards the request to your n8n webhook with a secret header,
// 4) returns { text } to the app. The OpenAI key stays inside n8n.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL               https://xxxx.supabase.co
//   SUPABASE_ANON_KEY          the Publishable key (or legacy anon key)
//   SUPABASE_SERVICE_ROLE_KEY  the Secret key (or legacy service_role key) - never in the app
//   N8N_WEBHOOK_URL            the Production URL of the Selah AI webhook in n8n
//   N8N_SECRET                 the same secret you put in n8n's Header Auth credential
//   AI_DAILY_LIMIT             optional, AI requests per person per day (default 30)

export const config = { maxDuration: 60 };

const env = (k, d = "") => (process.env[k] || d).trim();

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return null; }
}

function cleanMessages(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 40) return null;
  let total = 0;
  const out = [];
  for (const m of list) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    total += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  if (total > 60000 || out[out.length - 1].role !== "user") return null;
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

  const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
  const ANON = env("SUPABASE_ANON_KEY");
  const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");
  const N8N = env("N8N_WEBHOOK_URL");
  const SECRET = env("N8N_SECRET");
  const LIMIT = Math.max(1, parseInt(env("AI_DAILY_LIMIT", "30"), 10) || 30);
  if (!SUPABASE_URL || !ANON || !SERVICE || !N8N || !SECRET) return send(res, 503, { error: "Selah's AI isn't set up yet" });

  // 1. Who is asking?
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return send(res, 401, { error: "Please sign in" });
  let userId = null;
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } });
    if (u.ok) userId = (await u.json()).id || null;
  } catch { return send(res, 502, { error: "Couldn't reach Supabase" }); }
  if (!userId) return send(res, 401, { error: "Please sign in again" });

  // 2. Is the request sensible?
  const body = await readBody(req);
  const messages = cleanMessages(body && body.messages);
  if (!messages) return send(res, 400, { error: "Bad request" });
  const tier = body.tier === "quick" ? "quick" : "default";
  const json = body.json === true;

  // 3. Daily limit
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_ai_usage`, {
      method: "POST",
      // New Supabase "sb_secret_" keys go only in the apikey header; older JWT keys also go in Authorization.
      headers: Object.assign({ apikey: SERVICE, "content-type": "application/json" }, SERVICE.startsWith("eyJ") ? { authorization: `Bearer ${SERVICE}` } : {}),
      body: JSON.stringify({ p_user: userId, p_limit: LIMIT })
    });
    if (!r.ok) return send(res, 502, { error: "Couldn't check today's limit" });
    const n = await r.json();
    if (n === -1) return send(res, 429, { error: "Daily AI limit reached", daily: true, limit: LIMIT });
  } catch { return send(res, 502, { error: "Couldn't check today's limit" }); }

  // 4. Ask n8n (which calls OpenAI)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const r = await fetch(N8N, {
      method: "POST",
      headers: { "content-type": "application/json", "x-selah-secret": SECRET },
      body: JSON.stringify({ messages, tier, json, user: userId.slice(0, 8) }),
      signal: ctrl.signal
    });
    const raw = await r.text();
    let data = null; try { data = JSON.parse(raw); } catch {}
    if (Array.isArray(data)) data = data[0];
    const text = data && (typeof data.text === "string" ? data.text : typeof data.output === "string" ? data.output : null);
    if (!r.ok || text === null) return send(res, r.status === 429 ? 429 : 502, { error: "The AI didn't answer" });
    return send(res, 200, { text });
  } catch (e) {
    return send(res, 504, { error: e && e.name === "AbortError" ? "The AI took too long" : "Couldn't reach n8n" });
  } finally { clearTimeout(timer); }
}
