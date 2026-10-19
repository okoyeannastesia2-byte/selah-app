/* =====================================================================
   Selah platform layer (standalone version)
   Gives the app the same abilities it has inside Claude:
     db        → Supabase (your data, synced across devices)
     user      → Supabase sign-in
     sample    → the AI helper (your n8n workflow)
     downloads → save verse cards to the device
   If config.js is empty, Selah runs on this device only (no sign-in, no AI).
   ===================================================================== */
(function () {
  "use strict";
  var CFG = window.SELAH_CONFIG || {};
  var SB = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  var ANON = String(CFG.supabaseAnonKey || "");
  var AI_URL = String(CFG.aiWebhookUrl || "");
  var CLOUD = !!(SB && ANON);
  var K_SESSION = "selah:session", K_MODE = "selah:mode";
  var session = null, me = null, mode = null, readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var LOCAL_DOCS = ["profile", "progress", "journal", "chat", "marks"];

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  /* ---------------- auth (Supabase GoTrue over plain fetch) ---------------- */
  function keep(s) {
    if (!s || !s.access_token) return null;
    var exp = s.expires_at || (Math.floor(Date.now() / 1000) + (s.expires_in || 3600));
    session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: exp, user: { id: s.user && s.user.id, email: s.user && s.user.email } };
    lsSet(K_SESSION, session);
    return session;
  }
  async function gotrue(path, body, bearer) {
    var h = { apikey: ANON, "Content-Type": "application/json" };
    if (bearer) h.Authorization = "Bearer " + bearer;
    var r = await fetch(SB + "/auth/v1/" + path, { method: "POST", headers: h, body: JSON.stringify(body || {}) });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw err("auth", (j && (j.msg || j.error_description || j.message || j.error)) || ("Error " + r.status));
    return j;
  }
  var refreshing = null;
  async function refresh() {
    if (!session || !session.refresh_token) throw err("signed_out");
    if (!refreshing) refreshing = gotrue("token?grant_type=refresh_token", { refresh_token: session.refresh_token })
      .then(keep)
      .catch(function (e) { if (navigator.onLine !== false) { lsSet(K_SESSION, null); session = null; } throw e; })
      .finally(function () { refreshing = null; });
    return refreshing;
  }
  async function token() {
    if (!session) throw err("signed_out");
    if (Date.now() / 1000 > session.expires_at - 90) await refresh();
    return session.access_token;
  }

  /* ---------------- REST (PostgREST) ---------------- */
  async function rest(path, opt, retried) {
    opt = opt || {};
    var t = await token();
    var h = { apikey: ANON, Authorization: "Bearer " + t, "Content-Type": "application/json" };
    if (opt.prefer) h.Prefer = opt.prefer;
    var r = await fetch(SB + "/rest/v1/" + path, { method: opt.method || "GET", headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined });
    if (r.status === 401 && !retried) { await refresh(); return rest(path, opt, true); }
    var txt = await r.text();
    if (!r.ok) {
      var m = txt; try { m = JSON.parse(txt).message || txt; } catch (e) {}
      throw err(r.status === 403 || /row-level security/i.test(m) ? "permission_denied" : r.status === 413 ? "quota_exceeded" : "error", m);
    }
    return txt ? JSON.parse(txt) : null;
  }
  function snap(id, data) { return { id: id, exists: data != null, data: function () { return data; } }; }
  var TABLE = { testers: "selah_testers", circle: "selah_circle", notes: "selah_notes" };
  var db = {
    doc: function (path) {
      var seg = String(path).split("/");
      if (seg[0] === "data" && seg[1] === "users" && seg.length === 4) {
        var name = seg[3];
        return {
          get: async function () { var rows = await rest("selah_docs?select=data&name=eq." + encodeURIComponent(name)); return snap(name, rows && rows[0] ? rows[0].data : null); },
          set: async function (v) { await rest("selah_docs?on_conflict=user_id,name", { method: "POST", body: { name: name, data: v, updated_at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" }); }
        };
      }
      if ((seg[0] === "testers" || seg[0] === "circle") && seg.length === 2) {
        var t = TABLE[seg[0]], id = seg[1];
        return {
          get: async function () { var rows = await rest(t + "?select=data&user_id=eq." + encodeURIComponent(id)); return snap(id, rows && rows[0] ? rows[0].data : null); },
          set: async function (v) { await rest(t + "?on_conflict=user_id", { method: "POST", body: { data: v, updated_at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" }); }
        };
      }
      throw err("unsupported", "Unsupported path " + path);
    },
    collection: function (name) {
      var t = TABLE[name]; if (!t) throw err("unsupported", "Unsupported collection " + name);
      var filters = [];
      var q = {
        where: function (f, op, v) {
          if (name === "notes" && f === "to" && op === "==") filters.push("to_user=eq." + encodeURIComponent(v));
          else throw err("unsupported", "Unsupported filter");
          return q;
        },
        get: async function () {
          var notes = name === "notes";
          var rows = await rest(t + "?select=" + (notes ? "id,data" : "user_id,data") + filters.map(function (f) { return "&" + f; }).join("") + (notes ? "&order=created_at.desc&limit=50" : ""));
          return { docs: (rows || []).map(function (r) { return { id: String(notes ? r.id : r.user_id), data: function () { return r.data; } }; }) };
        },
        add: async function (v) {
          if (name !== "notes") throw err("unsupported");
          await rest("selah_notes", { method: "POST", body: { to_user: v.to, data: v }, prefer: "return=minimal" });
        }
      };
      return q;
    }
  };

  /* ---------------- user ---------------- */
  var user = {
    id: async function () { return session && session.user.id; },
    isOwner: async function () { return !!(me && me.is_admin); },
    canEdit: async function () { return true; },
    name: async function () { return ""; },
    email: function () { return session && session.user.email; }
  };

  /* ---------------- AI helper (n8n webhook) ---------------- */
  function parseJSON(t) {
    t = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(t); } catch (e) {}
    var a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw err("invalid_json", "The helper's reply wasn't readable.");
  }
  async function callAI(payload) {
    var t = await token();
    var r, j = null;
    try {
      r = await fetch(AI_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify(payload) });
    } catch (e) { throw err("network", "Can't reach the helper. Check your internet."); }
    try { j = await r.json(); } catch (e) {}
    if (!r.ok || !j || j.ok === false) {
      var reason = j && j.reason;
      throw err(reason === "daily_limit" || r.status === 429 ? "rate_limited" : (reason === "not_member" || reason === "signed_out" || r.status === 401 || r.status === 403) ? "not_granted" : "error", (j && j.message) || ("Helper error " + (r && r.status)));
    }
    return j;
  }
  function norm(input) { return typeof input === "string" ? [{ role: "user", content: input }] : (input || []).map(function (m) { return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }; }); }
  function tier(o) { return (o && o.modelTier) === "complex" ? "deep" : (o && o.modelTier) === "quick" ? "quick" : "default"; }
  var sample = async function (input, opts) {
    opts = opts || {};
    var j = await callAI({ mode: "text", tier: tier(opts), messages: norm(input) });
    var text = String(j.text || "");
    if (opts.onText) { try { opts.onText({ text: text, delta: text }); } catch (e) {} }
    return { text: text, truncated: false };
  };
  sample.json = async function (input, opts) {
    var j = await callAI({ mode: "json", tier: tier(opts), messages: norm(input) });
    return j.json && typeof j.json === "object" ? j.json : parseJSON(j.text);
  };
  sample.limits = async function () { return { images: false }; };

  /* ---------------- downloads ---------------- */
  var downloads = {
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var name = o.filename || "selah.png";
      try {
        var file = new File([blob], name, { type: blob.type || "image/png" });
        if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
          await navigator.share({ files: [file], title: "Selah" });
          return { saved: true };
        }
      } catch (e) { if (e && e.name === "AbortError") throw err("declined"); }
      var url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return { saved: true };
    }
  };

  /* ---------------- the window.claude.use() bridge ---------------- */
  window.claude = {
    use: async function (name) {
      await ready;
      if (name === "downloads") return downloads;
      if (mode !== "cloud") return null;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "sample") return AI_URL ? sample : null;
      return null;
    }
  };

  /* ---------------- sign-in screen ---------------- */
  var css = "#sp-login{position:fixed;inset:0;z-index:1000;background:var(--bg,#F2F4EF);overflow:auto;display:flex;align-items:flex-start;justify-content:center}" +
    "#sp-login .sp-card{width:100%;max-width:440px;padding:calc(48px + env(safe-area-inset-top,0px)) 20px 40px;display:flex;flex-direction:column;gap:14px}" +
    "#sp-login .sp-word{font-family:var(--display,Georgia,serif);font-size:64px;line-height:1;color:var(--ink,#1D2A28)}" +
    "#sp-login .sp-def{font-family:var(--display,Georgia,serif);font-style:italic;font-size:20px;color:var(--ink-2,#4D5C59);margin-bottom:12px}" +
    "#sp-login label{font-weight:600;font-size:14px;color:var(--ink,#1D2A28)}" +
    "#sp-login input{width:100%;-webkit-appearance:none;appearance:none;border:1.5px solid var(--line,#D8DED9);background:var(--surface,#fff);color:var(--ink,#1D2A28);border-radius:14px;padding:13px 14px;font-size:16px}" +
    "#sp-login input:focus{outline:none;border-color:var(--river,#2E6C67)}" +
    "#sp-login .sp-msg{font-size:14px;color:var(--ink-2,#4D5C59);min-height:1em}#sp-login .sp-msg.bad{color:#B4434E}" +
    "#sp-login .sp-link{background:none;border:0;color:var(--river,#2E6C67);font-weight:600;font-size:15px;padding:8px 0;text-align:center}" +
    "#sp-login .sp-seg{display:flex;background:var(--surface-2,#E8ECE7);border-radius:999px;padding:4px;gap:4px}" +
    "#sp-login .sp-seg button{flex:1;border:0;background:transparent;border-radius:999px;padding:9px;font-weight:600;color:var(--ink-2,#4D5C59)}" +
    "#sp-login .sp-seg button[aria-pressed=true]{background:var(--surface,#fff);color:var(--ink,#1D2A28);box-shadow:0 1px 3px rgba(0,0,0,.08)}" +
    "#sp-login .sp-small{font-size:13px;color:var(--ink-3,#7C8A86);text-align:center;line-height:1.5}";
  var view = "signin", pendingEmail = "";
  function shell(inner) {
    var el = document.getElementById("sp-login");
    if (!el) { var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st); el = document.createElement("div"); el.id = "sp-login"; document.body.appendChild(el); }
    el.innerHTML = '<div class="sp-card"><div class="sp-word">Selah</div><div class="sp-def">Pause. Breathe. Come closer.</div>' + inner + "</div>";
    return el;
  }
  function msg(t, bad) { var m = document.querySelector("#sp-login .sp-msg"); if (m) { m.textContent = t || ""; m.classList.toggle("bad", !!bad); } }
  function busy(on) { document.querySelectorAll("#sp-login button").forEach(function (b) { b.disabled = on; }); }
  function render() {
    if (view === "code") {
      shell('<p class="muted">We sent a code to <b>' + esc(pendingEmail) + '</b>. Type it below. Check spam if it isn\'t there.</p>' +
        '<label for="sp-code">Code</label><input id="sp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456">' +
        '<div class="sp-msg"></div><button class="btn block" data-sp="verify">Sign in</button>' +
        '<button class="sp-link" data-sp="back">Use a different email</button>');
      setTimeout(function () { var c = document.getElementById("sp-code"); if (c) c.focus(); }, 60);
      return;
    }
    var up = view === "signup";
    shell('<div class="sp-seg" role="group"><button aria-pressed="' + (!up) + '" data-sp="v-signin">Sign in</button><button aria-pressed="' + up + '" data-sp="v-signup">Create account</button></div>' +
      '<label for="sp-email">Email</label><input id="sp-email" type="email" autocomplete="email" placeholder="you@example.com" value="' + esc(pendingEmail) + '">' +
      '<label for="sp-pass">Password</label><input id="sp-pass" type="password" autocomplete="' + (up ? "new-password" : "current-password") + '" placeholder="' + (up ? "At least 8 characters" : "Your password") + '">' +
      '<div class="sp-msg"></div><button class="btn block" data-sp="' + (up ? "signup" : "signin") + '">' + (up ? "Create my account" : "Sign in") + "</button>" +
      (up ? "" : '<button class="sp-link" data-sp="code">Forgot password? Email me a sign-in code</button>') +
      '<p class="sp-small">Your account keeps your journeys, prayers and progress in sync on your phone and laptop.</p>' +
      '<button class="sp-link" data-sp="local">Use without an account (this device only)</button>');
  }
  async function afterSignIn() {
    try { me = await rest("rpc/selah_me", { method: "POST", body: {} }); } catch (e) { me = null; }
    if (lsGet(K_MODE) === "local") {
      // bring this device's local progress into the new account, if the account is empty
      for (var i = 0; i < LOCAL_DOCS.length; i++) {
        var n = LOCAL_DOCS[i], local = lsGet("selah:" + n);
        if (!local) continue;
        try { var s = await db.doc("data/users/" + session.user.id + "/" + n).get(); if (!s.exists) await db.doc("data/users/" + session.user.id + "/" + n).set(local); } catch (e) {}
      }
    }
    lsSet(K_MODE, "cloud");
    mode = "cloud";
    var el = document.getElementById("sp-login"); if (el) el.remove();
    readyResolve();
  }
  function goLocal() { lsSet(K_MODE, "local"); mode = "local"; var el = document.getElementById("sp-login"); if (el) el.remove(); readyResolve(); }
  document.addEventListener("click", async function (e) {
    var b = e.target.closest("[data-sp]"); if (!b) return;
    var a = b.dataset.sp;
    var email = (document.getElementById("sp-email") || {}).value; if (email != null) pendingEmail = email.trim().toLowerCase();
    var pass = (document.getElementById("sp-pass") || {}).value || "";
    try {
      if (a === "v-signin") { view = "signin"; render(); return; }
      if (a === "v-signup") { view = "signup"; render(); return; }
      if (a === "back") { view = "signin"; render(); return; }
      if (a === "local") { goLocal(); return; }
      if ((a === "signin" || a === "signup" || a === "code") && !/^\S+@\S+\.\S+$/.test(pendingEmail)) { msg("Type your email address first.", true); return; }
      busy(true);
      if (a === "signin") {
        if (!pass) { msg("Type your password.", true); return; }
        msg("Signing in…"); keep(await gotrue("token?grant_type=password", { email: pendingEmail, password: pass })); await afterSignIn();
      } else if (a === "signup") {
        if (pass.length < 8) { msg("Use at least 8 characters for your password.", true); return; }
        msg("Creating your account…");
        var j = await gotrue("signup", { email: pendingEmail, password: pass });
        if (j && j.access_token) { keep(j); await afterSignIn(); }
        else { view = "signin"; render(); msg("Check your email to confirm your account, then sign in."); }
      } else if (a === "code") {
        msg("Sending your code…"); await gotrue("otp", { email: pendingEmail, create_user: true }); view = "code"; render();
      } else if (a === "verify") {
        var code = ((document.getElementById("sp-code") || {}).value || "").replace(/\D/g, "");
        if (code.length < 6) { msg("Type the code from your email.", true); return; }
        msg("Checking…"); keep(await gotrue("verify", { type: "email", email: pendingEmail, token: code })); await afterSignIn();
      }
    } catch (ex) {
      var m = String(ex && ex.message || "");
      msg(/invalid login/i.test(m) ? "That email and password don't match. Try again, or use a sign-in code." :
          /already registered|already exists/i.test(m) ? "You already have an account. Choose Sign in." :
          /expired|invalid/i.test(m) && a === "verify" ? "That code didn't work or has expired. Ask for a new one." :
          /rate|too many/i.test(m) ? "Too many tries. Wait a minute and try again." :
          /fetch|network/i.test(m) ? "No internet connection. Check it and try again." : (m || "Something went wrong. Try again."), true);
    } finally { busy(false); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !e.target.closest || !e.target.closest("#sp-login")) return;
    var btn = document.querySelector('#sp-login [data-sp="signin"],#sp-login [data-sp="signup"],#sp-login [data-sp="verify"]');
    if (btn) { e.preventDefault(); btn.click(); }
  });

  /* ---------------- public helpers for the app ---------------- */
  window.SelahPlatform = {
    mode: function () { return mode; },
    email: function () { return session && session.user.email; },
    profileHTML: function () {
      if (!CLOUD) return "";
      if (mode === "cloud") return '<div class="card stack"><b>Your account</b><p class="small muted">Signed in as ' + esc(session && session.user.email) + '. Open Selah on any device and sign in with this email to carry on where you left off.</p><button class="btn ghost" data-act="sp-signout">Sign out</button></div>';
      return '<div class="card stack"><b>Sync across devices</b><p class="small muted">Right now Selah is saved on this device only. Sign in to keep it on your phone and laptop together.</p><button class="btn soft" data-act="sp-signin">Sign in or create an account</button></div>';
    },
    signOut: async function () {
      try { if (session) await gotrue("logout", {}, session.access_token); } catch (e) {}
      lsSet(K_SESSION, null); lsSet(K_MODE, null);
      try { LOCAL_DOCS.forEach(function (n) { localStorage.removeItem("selah:" + n); }); } catch (e) {}
      location.reload();
    },
    signIn: function () { lsSet(K_MODE, null); location.reload(); }
  };

  /* ---------------- start ---------------- */
  function start() {
    if (!CLOUD) { mode = "local"; readyResolve(); return; }
    var saved = lsGet(K_SESSION);
    if (saved && saved.access_token && saved.user && saved.user.id) {
      session = saved;
      (async function () {
        try { await token(); await afterSignIn(); }
        catch (e) {
          if (session) { mode = "cloud"; readyResolve(); }   // offline: keep going with the saved session
          else { view = "signin"; render(); }
        }
      })();
      return;
    }
    if (lsGet(K_MODE) === "local") { mode = "local"; readyResolve(); return; }
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
