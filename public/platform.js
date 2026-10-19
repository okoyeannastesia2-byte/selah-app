/* Selah platform layer for the standalone app.
   The app was first built inside Claude, where it asks for abilities with
   window.claude.use("db" | "user" | "sample" | "downloads").
   This file provides the same abilities outside Claude:
     db        -> Supabase tables (private per person, protected by row-level security)
     user      -> the signed-in Supabase account
     sample    -> AI answers through /api/ai (Vercel) -> your n8n -> OpenAI
     downloads -> save or share a file on the device
   With no Supabase settings in config.js, Selah runs in "this device only" mode. */
(function () {
  "use strict";
  var CFG = window.SELAH_CONFIG || {};
  var cloud = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient);
  var sb = cloud ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "selah-auth" }
  }) : null;

  var session = null, recovering = false, resolveReady, adminCache = null;
  var ready = new Promise(function (r) { resolveReady = r; });

  /* ---------------- helpers ---------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function uid() { return session && session.user ? session.user.id : null; }
  function appState() { try { return typeof S !== "undefined" ? S : null; } catch (e) { return null; } }
  function fail(error) { var e = new Error((error && error.message) || "Request failed"); e.code = (error && error.code) || "unavailable"; throw e; }

  /* ---------------- sign-in screen ---------------- */
  var CSS = "#authGate{position:fixed;inset:0;z-index:200;background:var(--bg,#F3F4EF);color:var(--ink,#1D2A28);overflow-y:auto;display:flex;justify-content:center;padding:max(28px,env(safe-area-inset-top)) 16px 40px}" +
    "#authGate .ag{width:100%;max-width:420px;display:flex;flex-direction:column;gap:16px;margin:auto 0}" +
    "#authGate .ag-word{font-family:var(--display,Georgia,serif);font-size:64px;line-height:1;margin:0}" +
    "#authGate .ag-def{font-family:var(--display,Georgia,serif);font-style:italic;font-size:20px;color:var(--ink-2,#4D5C59);margin:0 0 6px}" +
    "#authGate h2{font-size:24px;margin:8px 0 0}" +
    "#authGate label{font-size:14px;font-weight:600;display:block;margin-bottom:6px}" +
    "#authGate input{width:100%;border:1.5px solid var(--line,#D8DDD6);background:var(--surface,#fff);color:inherit;border-radius:14px;padding:13px 14px;font-size:16px;-webkit-appearance:none}" +
    "#authGate input:focus{outline:none;border-color:var(--river,#2E6C67)}" +
    "#authGate .ag-btn{border:0;border-radius:999px;padding:14px 18px;font-size:16px;font-weight:600;background:var(--river,#2E6C67);color:var(--river-ink,#fff);width:100%}" +
    "#authGate .ag-btn[disabled]{opacity:.6}" +
    "#authGate .ag-link{border:0;background:none;color:var(--river,#2E6C67);font-weight:600;font-size:15px;padding:6px 0}" +
    "#authGate .ag-msg{border-radius:14px;padding:12px 14px;font-size:14.5px;line-height:1.5;background:var(--surface,#fff)}" +
    "#authGate .ag-msg.err{background:#FBE7E4;color:#7A2418}" +
    "#authGate .ag-row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}" +
    "#authGate .ag-small{font-size:13px;color:var(--ink-3,#7C8A86);line-height:1.5}";

  var mode = "signin", msg = "", msgErr = false, busy = false, lastEmail = "";

  function friendly(e) {
    var m = (e && e.message) || "";
    if (/invalid login credentials/i.test(m)) return "That email and password don't match. Try again, or reset your password.";
    if (/email not confirmed/i.test(m)) return "Please confirm your email first. Open the email we sent you and tap the link, then sign in here.";
    if (/already registered|already exists/i.test(m)) return "There's already an account with this email. Sign in instead.";
    if (/password should be at least|weak/i.test(m)) return "Please choose a stronger password (at least 8 characters).";
    if (/rate limit|too many/i.test(m)) return "Too many tries. Please wait a few minutes and try again.";
    if (/fetch|network/i.test(m)) return "No internet connection. Check your connection and try again.";
    return m || "Something went wrong. Please try again.";
  }

  function gateHTML() {
    var top = '<div><p class="ag-word">Selah</p><p class="ag-def">Pause. Breathe. Come closer.</p></div>';
    var note = msg ? '<div class="ag-msg' + (msgErr ? " err" : "") + '" role="status">' + esc(msg) + "</div>" : "";
    var email = '<div><label for="agEmail">Email</label><input id="agEmail" type="email" autocomplete="email" inputmode="email" value="' + esc(lastEmail) + '"></div>';
    if (mode === "recovery") return top + "<h2>Choose a new password</h2>" + note +
      '<div><label for="agPass">New password</label><input id="agPass" type="password" autocomplete="new-password" minlength="8"></div>' +
      '<button class="ag-btn" data-ag="setpass"' + (busy ? " disabled" : "") + ">Save new password</button>";
    if (mode === "forgot") return top + "<h2>Reset your password</h2>" + note + email +
      '<button class="ag-btn" data-ag="sendreset"' + (busy ? " disabled" : "") + ">Send reset link</button>" +
      '<button class="ag-link" data-ag="to:signin">Back to sign in</button>';
    if (mode === "check") return top + "<h2>Check your email</h2>" + note +
      '<p class="ag-small">Open the email from Selah and tap the link. Then come back here and sign in. If you don\'t see it, look in Spam or Promotions.</p>' +
      '<button class="ag-btn" data-ag="to:signin">I\'ve confirmed, sign me in</button>';
    var isUp = mode === "signup";
    return top + "<h2>" + (isUp ? "Create your account" : "Welcome back") + "</h2>" + note + email +
      '<div><label for="agPass">Password</label><input id="agPass" type="password" autocomplete="' + (isUp ? "new-password" : "current-password") + '" minlength="8"></div>' +
      '<button class="ag-btn" data-ag="' + (isUp ? "signup" : "signin") + '"' + (busy ? " disabled" : "") + ">" + (isUp ? "Create account" : "Sign in") + "</button>" +
      '<div class="ag-row">' + (isUp ? '<button class="ag-link" data-ag="to:signin">I already have an account</button>'
        : '<button class="ag-link" data-ag="to:signup">New here? Create an account</button><button class="ag-link" data-ag="to:forgot">Forgot password?</button>') + "</div>" +
      '<p class="ag-small">Your account keeps your journeys, prayers and progress in sync on your phone and laptop. Your prayers and journal are private to you.</p>';
  }

  function renderGate() {
    var g = document.getElementById("authGate");
    if (!g) {
      var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
      g = document.createElement("div"); g.id = "authGate"; g.setAttribute("role", "dialog"); g.setAttribute("aria-label", "Sign in to Selah");
      document.body.appendChild(g);
      g.addEventListener("click", onGateClick);
      g.addEventListener("keydown", function (e) { if (e.key === "Enter") { var b = g.querySelector(".ag-btn"); if (b) b.click(); } });
    }
    g.innerHTML = '<div class="ag">' + gateHTML() + "</div>";
    g.hidden = false;
  }
  function closeGate() { var g = document.getElementById("authGate"); if (g) g.remove(); }
  function setMsg(t, err) { msg = t || ""; msgErr = !!err; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }

  async function onGateClick(e) {
    var b = e.target.closest("[data-ag]"); if (!b || busy) return;
    var a = b.getAttribute("data-ag");
    if (a.indexOf("to:") === 0) { lastEmail = val("agEmail") || lastEmail; mode = a.slice(3); setMsg(""); renderGate(); return; }
    var email = val("agEmail"), pass = (document.getElementById("agPass") || {}).value || "";
    if (email) lastEmail = email;
    if ((a === "signin" || a === "signup" || a === "sendreset") && !/^\S+@\S+\.\S+$/.test(email)) { setMsg("Please enter a valid email address.", true); renderGate(); return; }
    if ((a === "signup" || a === "setpass") && pass.length < 8) { setMsg("Please use at least 8 characters for your password.", true); renderGate(); return; }
    if (a === "signin" && !pass) { setMsg("Please enter your password.", true); renderGate(); return; }
    busy = true; renderGate();
    try {
      if (a === "signin") {
        var r1 = await sb.auth.signInWithPassword({ email: email, password: pass }); if (r1.error) throw r1.error;
      } else if (a === "signup") {
        var r2 = await sb.auth.signUp({ email: email, password: pass, options: { emailRedirectTo: location.origin } }); if (r2.error) throw r2.error;
        if (!r2.data.session) { mode = "check"; setMsg("We sent a confirmation link to " + email + "."); }
      } else if (a === "sendreset") {
        var r3 = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin }); if (r3.error) throw r3.error;
        mode = "signin"; setMsg("If there's an account for " + email + ", a reset link is on its way. Open it on this device.");
      } else if (a === "setpass") {
        var r4 = await sb.auth.updateUser({ password: pass }); if (r4.error) throw r4.error;
        recovering = false; setMsg(""); mode = "signin";
        var s4 = await sb.auth.getSession(); if (s4.data.session) { onSession(s4.data.session); busy = false; return; }
      }
    } catch (err) { setMsg(friendly(err), true); }
    busy = false; if (document.getElementById("authGate")) renderGate();
  }

  function onSession(s) {
    session = s;
    if (s && !recovering) { closeGate(); resolveReady(true); }
  }

  /* ---------------- start-up ---------------- */
  if (!cloud) { resolveReady(false); }
  else {
    sb.auth.onAuthStateChange(function (event, s) {
      if (event === "PASSWORD_RECOVERY") { recovering = true; session = s; mode = "recovery"; setMsg(""); whenBody(renderGate); return; }
      if (event === "SIGNED_OUT") { session = null; return; }
      if (s) onSession(s);
    });
    sb.auth.getSession().then(function (r) {
      var s = r.data && r.data.session;
      if (s && !recovering) onSession(s); else if (!recovering) whenBody(renderGate);
    }).catch(function () { whenBody(renderGate); });
  }
  function whenBody(fn) { if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn); }

  window.SelahSignOut = async function () {
    if (!sb) return;
    try { await sb.auth.signOut(); } catch (e) {}
    try { Object.keys(localStorage).filter(function (k) { return k.indexOf("selah:") === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
    location.reload();
  };
  window.SelahCloud = { enabled: cloud };

  /* ---------------- db: same calls the app already makes ---------------- */
  function rowsToDocs(rows, idKey, mapData) {
    return { docs: (rows || []).map(function (r) { return { id: r[idKey], data: function () { return mapData ? mapData(r) : r.data; } }; }) };
  }
  var db = {
    doc: function (path) {
      var seg = path.split("/");
      return {
        get: async function () {
          if (seg[0] === "data" && seg[1] === "users") {
            var q = await sb.from("user_docs").select("data").eq("user_id", seg[2]).eq("name", seg[3]).maybeSingle();
            if (q.error) fail(q.error);
            return { exists: !!q.data, data: function () { return q.data ? q.data.data : undefined; } };
          }
          var table = seg[0] === "testers" ? "testers" : seg[0] === "circle" ? "circle" : null;
          if (!table) fail({ message: "Unknown document " + path, code: "not_found" });
          var q2 = await sb.from(table).select("data").eq("user_id", seg[1]).maybeSingle();
          if (q2.error) fail(q2.error);
          return { exists: !!q2.data, data: function () { return q2.data ? q2.data.data : undefined; } };
        },
        set: async function (obj) {
          var now = new Date().toISOString(), r;
          if (seg[0] === "data" && seg[1] === "users") r = await sb.from("user_docs").upsert({ user_id: seg[2], name: seg[3], data: obj, updated_at: now });
          else if (seg[0] === "testers") r = await sb.from("testers").upsert({ user_id: seg[1], data: obj, updated_at: now });
          else if (seg[0] === "circle") {
            var st = appState(), code = st && st.profile && st.profile.circleCode ? String(st.profile.circleCode).trim().toUpperCase() : null;
            r = await sb.from("circle").upsert({ user_id: seg[1], code: code || null, data: obj, updated_at: now });
          } else fail({ message: "Unknown document " + path, code: "not_found" });
          if (r.error) fail(r.error);
        }
      };
    },
    collection: function (name) {
      var filters = [];
      var api = {
        where: function (field, op, value) { filters.push([field, op, value]); return api; },
        get: async function () {
          if (name === "circle") {
            var c = await sb.from("circle").select("user_id,data"); if (c.error) fail(c.error);
            return rowsToDocs(c.data, "user_id");
          }
          if (name === "testers") {
            var t = await sb.from("testers").select("user_id,data,updated_at").order("updated_at", { ascending: false }); if (t.error) fail(t.error);
            return rowsToDocs(t.data, "user_id");
          }
          if (name === "notes") {
            var q = sb.from("notes").select("id,to_user,from_user,data,created_at");
            filters.forEach(function (f) { if (f[0] === "to" && f[1] === "==") q = q.eq("to_user", f[2]); });
            var n = await q.order("created_at", { ascending: false }).limit(50); if (n.error) fail(n.error);
            return rowsToDocs(n.data, "id", function (r) { var d = r.data || {}; d.to = r.to_user; d.from = r.from_user; return d; });
          }
          fail({ message: "Unknown collection " + name, code: "not_found" });
        },
        add: async function (obj) {
          if (name !== "notes") fail({ message: "Unknown collection " + name, code: "not_found" });
          var ins = await sb.from("notes").insert({ to_user: obj.to, from_user: uid(), data: obj }).select("id").single();
          if (ins.error) fail(ins.error);
          return { id: ins.data.id };
        },
        doc: function (k) { return db.doc(name + "/" + k); }
      };
      return api;
    }
  };

  /* ---------------- user ---------------- */
  var user = {
    id: async function () { return uid(); },
    isOwner: async function () {
      if (adminCache !== null) return adminCache;
      try { var r = await sb.rpc("is_admin"); adminCache = !r.error && r.data === true; } catch (e) { adminCache = false; }
      return adminCache;
    },
    canEdit: async function () { return true; },
    name: async function () { return ""; },
    email: async function () { return session && session.user ? session.user.email || "" : ""; }
  };

  /* ---------------- AI (sample) ---------------- */
  function parseJSON(text) {
    var t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(t); } catch (e) {}
    var a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    var err = new Error("The answer wasn't valid JSON"); err.code = "invalid_json"; err.text = text; throw err;
  }
  async function callAI(messages, opts) {
    var s = await sb.auth.getSession(); var tok = s.data.session && s.data.session.access_token;
    if (!tok) { var e0 = new Error("Signed out"); e0.code = "not_granted"; throw e0; }
    var res;
    try {
      res = await fetch(CFG.aiEndpoint || "/api/ai", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok },
        body: JSON.stringify({ messages: messages, tier: (opts && opts.modelTier) || "default", json: !!(opts && opts.json) }),
        signal: opts && opts.signal
      });
    } catch (e) { var e1 = new Error("Network error"); e1.code = "unavailable"; throw e1; }
    var body = null; try { body = await res.json(); } catch (e) {}
    if (res.status === 429) { var e2 = new Error((body && body.error) || "Daily limit reached"); e2.code = "rate_limited"; e2.daily = !!(body && body.daily); throw e2; }
    if (res.status === 401) { var e3 = new Error("Signed out"); e3.code = "not_granted"; throw e3; }
    if (!res.ok || !body || typeof body.text !== "string") { var e4 = new Error((body && body.error) || "AI unavailable"); e4.code = "unavailable"; throw e4; }
    return body.text;
  }
  var sample = async function (input, opts) {
    opts = opts || {};
    var messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    var text = await callAI(messages, opts);
    if (typeof opts.onText === "function") { try { opts.onText({ text: text, delta: text }); } catch (e) {} }
    return { text: text, truncated: false };
  };
  sample.json = async function (input, opts) { var r = await sample(input, Object.assign({}, opts || {}, { json: true, onText: null })); return parseJSON(r.text); };
  sample.limits = async function () { return { images: false }; };

  /* ---------------- downloads ---------------- */
  var downloads = {
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var file = null; try { file = new File([blob], o.filename, { type: blob.type || "application/octet-stream" }); } catch (e) {}
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "Selah" }); return; }
        catch (e) { if (e && e.name === "AbortError") { var d = new Error("declined"); d.code = "declined"; throw d; } }
      }
      var url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = o.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
  };

  /* ---------------- the same entry point the app already uses ---------------- */
  window.claude = {
    use: async function (name) {
      var signedIn = await ready;
      if (!signedIn) return null;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "sample") return CFG.aiEndpoint === "" ? null : sample;
      if (name === "downloads") return downloads;
      return null;
    }
  };

  /* ---------------- install as an app ---------------- */
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
})();
