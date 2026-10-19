"""Builds selah-ai-workflow.json (the n8n workflow Annie imports)."""
import json, uuid, os

def nid(): return str(uuid.uuid4())

READ_REQUEST = r"""// Reads what Selah sent: the person's sign-in token and the AI request.
const j = $input.first().json;
let b = j.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
if (!b || typeof b !== 'object') b = {};
const h = j.headers || {};
const auth = String(h.authorization || h.Authorization || '');
const token = String(b.token || auth.replace(/^Bearer\s+/i, '') || '');
return [{ json: { token, mode: b.mode === 'json' ? 'json' : 'text', tier: b.tier || 'default', messages: Array.isArray(b.messages) ? b.messages : [] } }];
"""

PREPARE = r"""// Decides: allowed? which AI? and builds the request.
const hit = $input.first().json;                 // full response from Supabase
const cfg = $('Settings').first().json;
const req = $('Read request').first().json;
const body = (hit && hit.body) || {};
const err = (code, reason, message) => [{ json: { route: 'error', code, reply: { ok: false, reason, message } } }];

if (!hit || hit.statusCode !== 200) return err(401, 'signed_out', 'Please sign in to Selah again.');
if (!body.allowed) {
  if (body.reason === 'daily_limit') return err(429, 'daily_limit', "You've used today's AI help. It refreshes tomorrow.");
  if (body.reason === 'signed_out') return err(401, 'signed_out', 'Please sign in to Selah again.');
  return err(403, 'not_member', 'Ask Annie to add your email so you can use the AI helper.');
}

let msgs = req.messages
  .filter(m => m && typeof m.content === 'string' && m.content.trim())
  .slice(-30)
  .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 12000) }));
while (msgs.length && msgs[0].role !== 'user') msgs.shift();
if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return err(400, 'bad_request', 'Nothing to send.');

const asJson = req.mode === 'json';
const tier = ['quick', 'default', 'deep'].includes(req.tier) ? req.tier : 'default';
const system = 'You are the writing helper inside Selah, a gentle Christian Bible app for young people. ' +
  "Follow the instructions in the user's message exactly. Be warm, honest and faithful to Scripture. Never invent Bible verses." +
  (asJson ? ' Reply with one valid JSON object only, with no markdown around it.' : '');
const provider = String(cfg.PROVIDER || 'openai').trim().toLowerCase();

if (provider === 'anthropic' || provider === 'claude') {
  const model = tier === 'quick' ? cfg.CLAUDE_MODEL_QUICK : cfg.CLAUDE_MODEL;
  return [{ json: { route: 'anthropic', asJson, body: { model, max_tokens: asJson ? 2000 : 1500, system, messages: msgs } } }];
}
const model = tier === 'quick' ? cfg.OPENAI_MODEL_QUICK : cfg.OPENAI_MODEL;
const out = { model, messages: [{ role: 'system', content: system }, ...msgs] };
if (asJson) out.response_format = { type: 'json_object' };
return [{ json: { route: 'openai', asJson, body: out } }];
"""

FORMAT = r"""// Turns the AI's answer into what Selah expects.
const r = $input.first().json;
const prep = $('Prepare').first().json;
const b = (r && r.body) || {};
let text = '';
if (prep.route === 'openai') text = (b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content) || '';
else text = (Array.isArray(b.content) ? b.content : []).filter(c => c.type === 'text').map(c => c.text).join('');
const ok = r && r.statusCode >= 200 && r.statusCode < 300 && text;
if (!ok) {
  const m = (b.error && (b.error.message || b.error.type)) || 'The AI provider did not answer.';
  return [{ json: { code: 502, reply: { ok: false, reason: 'provider_error', message: String(m).slice(0, 300) } } }];
}
const reply = { ok: true, text };
if (prep.asJson) {
  try {
    const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    reply.json = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch (e) { /* Selah will try to read it itself */ }
}
return [{ json: { code: 200, reply } }];
"""

def setv(name, value, typ="string"):
    return {"id": nid(), "name": name, "value": value, "type": typ}

nodes = [
  {"id": nid(), "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [0, 300],
   "webhookId": nid(),
   "parameters": {"httpMethod": "POST", "path": "selah-ai", "responseMode": "responseNode",
                  "options": {"allowedOrigins": "*"}}},
  {"id": nid(), "name": "Read request", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [220, 300],
   "parameters": {"jsCode": READ_REQUEST}},
  {"id": nid(), "name": "Settings", "type": "n8n-nodes-base.set", "typeVersion": 3.4, "position": [440, 300],
   "parameters": {"assignments": {"assignments": [
       setv("SUPABASE_URL", "https://YOUR-PROJECT-ID.supabase.co"),
       setv("SUPABASE_ANON_KEY", "PASTE-YOUR-SUPABASE-ANON-KEY"),
       setv("PROVIDER", "openai"),
       setv("OPENAI_MODEL", "gpt-4.1-mini"),
       setv("OPENAI_MODEL_QUICK", "gpt-4.1-mini"),
       setv("CLAUDE_MODEL", "claude-sonnet-5-5"),
       setv("CLAUDE_MODEL_QUICK", "claude-haiku-5-5"),
       setv("DAILY_LIMIT", 40, "number"),
   ]}, "options": {}}},
  {"id": nid(), "name": "Check user and daily limit", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [660, 300],
   "parameters": {"method": "POST", "url": "={{ $json.SUPABASE_URL }}/rest/v1/rpc/selah_ai_hit",
                  "sendHeaders": True, "headerParameters": {"parameters": [
                      {"name": "apikey", "value": "={{ $json.SUPABASE_ANON_KEY }}"},
                      {"name": "Authorization", "value": "=Bearer {{ $('Read request').item.json.token || 'none' }}"}]},
                  "sendBody": True, "specifyBody": "json",
                  "jsonBody": "={{ JSON.stringify({ daily_limit: $json.DAILY_LIMIT }) }}",
                  "options": {"response": {"response": {"fullResponse": True, "neverError": True}}, "timeout": 15000}}},
  {"id": nid(), "name": "Prepare", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [880, 300],
   "parameters": {"jsCode": PREPARE}},
  {"id": nid(), "name": "Allowed?", "type": "n8n-nodes-base.if", "typeVersion": 2, "position": [1100, 300],
   "parameters": {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict"},
                                 "conditions": [{"id": nid(), "leftValue": "={{ $json.route }}", "rightValue": "error",
                                                 "operator": {"type": "string", "operation": "notEquals"}}],
                                 "combinator": "and"}, "options": {}}},
  {"id": nid(), "name": "OpenAI or Claude?", "type": "n8n-nodes-base.if", "typeVersion": 2, "position": [1320, 200],
   "parameters": {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict"},
                                 "conditions": [{"id": nid(), "leftValue": "={{ $json.route }}", "rightValue": "openai",
                                                 "operator": {"type": "string", "operation": "equals"}}],
                                 "combinator": "and"}, "options": {}}},
  {"id": nid(), "name": "OpenAI", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [1540, 100],
   "parameters": {"method": "POST", "url": "https://api.openai.com/v1/chat/completions",
                  "authentication": "predefinedCredentialType", "nodeCredentialType": "openAiApi",
                  "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.body) }}",
                  "options": {"response": {"response": {"fullResponse": True, "neverError": True}}, "timeout": 90000}}},
  {"id": nid(), "name": "Claude", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [1540, 300],
   "parameters": {"method": "POST", "url": "https://api.anthropic.com/v1/messages",
                  "authentication": "predefinedCredentialType", "nodeCredentialType": "anthropicApi",
                  "sendHeaders": True, "headerParameters": {"parameters": [{"name": "anthropic-version", "value": "2023-06-01"}]},
                  "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json.body) }}",
                  "options": {"response": {"response": {"fullResponse": True, "neverError": True}}, "timeout": 90000}}},
  {"id": nid(), "name": "Format reply", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [1760, 200],
   "parameters": {"jsCode": FORMAT}},
  {"id": nid(), "name": "Reply to Selah", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1, "position": [1980, 300],
   "parameters": {"respondWith": "json", "responseBody": "={{ JSON.stringify($json.reply) }}",
                  "options": {"responseCode": "={{ $json.code }}",
                              "responseHeaders": {"entries": [{"name": "Access-Control-Allow-Origin", "value": "*"},
                                                              {"name": "Cache-Control", "value": "no-store"}]}}}},
]
conn = {
  "Webhook": {"main": [[{"node": "Read request", "type": "main", "index": 0}]]},
  "Read request": {"main": [[{"node": "Settings", "type": "main", "index": 0}]]},
  "Settings": {"main": [[{"node": "Check user and daily limit", "type": "main", "index": 0}]]},
  "Check user and daily limit": {"main": [[{"node": "Prepare", "type": "main", "index": 0}]]},
  "Prepare": {"main": [[{"node": "Allowed?", "type": "main", "index": 0}]]},
  "Allowed?": {"main": [[{"node": "OpenAI or Claude?", "type": "main", "index": 0}],
                        [{"node": "Reply to Selah", "type": "main", "index": 0}]]},
  "OpenAI or Claude?": {"main": [[{"node": "OpenAI", "type": "main", "index": 0}],
                                 [{"node": "Claude", "type": "main", "index": 0}]]},
  "OpenAI": {"main": [[{"node": "Format reply", "type": "main", "index": 0}]]},
  "Claude": {"main": [[{"node": "Format reply", "type": "main", "index": 0}]]},
  "Format reply": {"main": [[{"node": "Reply to Selah", "type": "main", "index": 0}]]},
}
wf = {"name": "Selah AI helper", "nodes": nodes, "connections": conn, "active": False,
      "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "none", "saveDataErrorExecution": "none"},
      "pinData": {}, "meta": {"templateCredsSetupCompleted": False}}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "n8n", "selah-ai-workflow.json")
json.dump(wf, open(out, "w"), indent=2)
print("wrote", out)
