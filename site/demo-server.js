/* =============================================================
   Sésame — mode démo
   Actif seulement quand l'adresse contient ?demo.
   Remplace la base Supabase par une base simulée, rangée dans le navigateur
   (localStorage), avec des étudiant·es fictifs. Les règles sont les mêmes que
   dans supabase.sql : usage unique, QR qui change toutes les 10 s, quota par
   semaine, code personnel, PIN agent, espace sécurité.
   Aucune donnée n'est envoyée nulle part.
   ============================================================= */
(function () {
  "use strict";
  if (!/(^|[?&])demo(=|&|$)/.test(location.search.slice(1))) return;

  var DBK = "sesame-demo.db", AUTHK = "sesame-demo.auth", VERSION = 3;
  var DEMO = {
    mailCode: "123456", studentPin: "246810", agentPin: "2580", adminPw: "demo-sesame",
    email: "camille.martin@essec.edu"
  };
  var STEP_MS = 10000, ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  /* ---------- outils ---------- */
  function now() { return Date.now(); }
  function iso(t) { return new Date(t).toISOString(); }
  function dayStart(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfDay(t) { return dayStart(t) + 86400000 - 1; }
  function weekStart(t) { var d = new Date(dayStart(t)); var w = (d.getDay() + 6) % 7; return d.getTime() - w * 86400000; }
  function ymd(t) { var d = new Date(t); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function step() { return Math.floor(now() / STEP_MS); }
  function rndHex(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function rndId(db) {
    var id;
    do { var a = new Uint8Array(8); crypto.getRandomValues(a); id = Array.prototype.map.call(a, function (b) { return ALPHA[b % ALPHA.length]; }).join(""); }
    while (db.tokens[id]);
    return id;
  }
  function prng(seed) { return function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
  var enc = new TextEncoder();
  function hmacHex(secret, msg) {
    return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then(function (k) { return crypto.subtle.sign("HMAC", k, enc.encode(msg)); })
      .then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); });
  }
  function otp(hex) { return ("000" + (parseInt(hex.slice(8, 16), 16) % 10000)).slice(-4); }

  /* ---------- photos fictives (illustrations, pas de vrais visages) ---------- */
  function avatar(bg, skin, hair, style, shirt) {
    var hairShape = style === "long"
      ? '<path d="M38 70c-6-30 10-46 32-46s38 16 32 46l-4 34H42z" fill="' + hair + '"/>'
      : style === "curly"
        ? '<g fill="' + hair + '"><circle cx="50" cy="48" r="14"/><circle cx="70" cy="40" r="16"/><circle cx="90" cy="48" r="14"/><circle cx="44" cy="62" r="10"/><circle cx="96" cy="62" r="10"/></g>'
        : '<path d="M44 62c-2-24 10-36 26-36s30 10 26 34c-6-12-18-16-26-16s-20 6-26 18z" fill="' + hair + '"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140">'
      + '<rect width="140" height="140" fill="' + bg + '"/>'
      + (style === "long" ? hairShape : "")
      + '<path d="M22 140c4-26 24-38 48-38s44 12 48 38z" fill="' + shirt + '"/>'
      + '<rect x="61" y="86" width="18" height="20" rx="8" fill="' + skin + '"/>'
      + '<ellipse cx="70" cy="66" rx="24" ry="27" fill="' + skin + '"/>'
      + (style !== "long" ? hairShape : '<path d="M46 60c2-18 12-26 24-26s22 8 24 26c-8-8-16-12-24-12s-16 4-24 12z" fill="' + hair + '"/>')
      + '<circle cx="61" cy="68" r="2.6" fill="#1E1E24"/><circle cx="79" cy="68" r="2.6" fill="#1E1E24"/>'
      + '<path d="M63 80q7 5 14 0" stroke="#1E1E24" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
      + "</svg>";
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  var PEOPLE = [
    ["Camille", "Martin", "B00123456", avatar("#CFE8F7", "#F1C7A5", "#5B3A29", "long", "#0A2B4E")],
    ["Hugo", "Bernard", "B00234567", avatar("#E3EED8", "#E8B48F", "#2B2118", "short", "#1DA1E0")],
    ["Inès", "Moreau", "B00345678", avatar("#F6E3D6", "#C68A62", "#1B120D", "curly", "#7A3E9D")],
    ["Lucas", "Petit", "B00456789", avatar("#E6E2F3", "#F3D0B5", "#C99A4E", "short", "#2E7D5B")],
    ["Chloé", "Laurent", "B00567890", avatar("#FBE7EC", "#EBC0A0", "#8A4B2A", "long", "#B42C2C")],
    ["Yanis", "Haddad", "B00678901", avatar("#DDEFEA", "#B9825C", "#120C08", "short", "#3F4C5E")],
    ["Emma", "Rousseau", "B00789012", avatar("#FFF1CC", "#F5D3BC", "#D7A15B", "long", "#1B7A45")],
    ["Nathan", "Leroy", "B00890123", avatar("#E1ECF7", "#8D5B3E", "#0F0A07", "curly", "#0B6FA4")],
    ["Sarah", "Benali", "B00901234", avatar("#F2E4F4", "#C99372", "#24150E", "long", "#A35F08")]
  ];

  /* ---------- base de départ ---------- */
  function seed() {
    var t = now(), R = prng(20261126), db = {
      v: VERSION,
      settings: { agent_pin: DEMO.agentPin, week_limit: 6, admin_password: DEMO.adminPw, email_domain: "essec.edu" },
      students: {}, tokens: {}, scans: [], seq: 1
    };
    PEOPLE.forEach(function (p, i) {
      var email = (p[0] + "." + p[1]).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") + "@essec.edu";
      db.students[p[2]] = {
        b00: p[2], email: email, prenom: p[0], nom: p[1], photo: p[3],
        created_at: iso(t - (20 + i * 2) * 86400000), consent_at: iso(t - (20 + i * 2) * 86400000),
        blocked: p[2] === "B00567890", photo_reset: false,
        pin: i === 0 ? DEMO.studentPin : "8" + p[2].slice(-5), pin_failures: 0, pin_locked_until: null
      };
    });
    // Historique des 14 derniers jours (jours de semaine surtout)
    var others = PEOPLE.slice(1).map(function (p) { return p[2]; });
    for (var d = 13; d >= 0; d--) {
      var base = dayStart(t) - d * 86400000, wd = new Date(base).getDay();
      if (wd === 0) continue;
      var n = wd === 6 ? 1 + Math.floor(R() * 2) : 3 + Math.floor(R() * 6);
      for (var k = 0; k < n; k++) {
        var at = base + (7.5 * 3600000) + Math.floor(R() * 10 * 3600000);
        if (at > t - 5 * 60000) continue;
        var b00 = others[Math.floor(R() * others.length)];
        addPastScan(db, b00, at, R() < 0.16 ? (R() < 0.5 ? "stale" : "used") : "ok");
      }
    }
    // Camille : deux passages plus tôt dans la semaine (si la semaine a déjà commencé)
    var ws = weekStart(t);
    [1, 2].forEach(function (k) {
      var at = ws + (k - 1) * 86400000 + 8.7 * 3600000;
      if (at < dayStart(t)) addPastScan(db, "B00123456", at, "ok");
    });
    db.scans.sort(function (a, b) { return a.scanned_at < b.scanned_at ? -1 : 1; });
    db.scans.forEach(function (s, i) { s.id = i + 1; });
    db.seq = db.scans.length + 1;
    return db;
  }
  function addPastScan(db, b00, at, verdict) {
    var id = rndId(db), st = db.students[b00];
    if (st.blocked) verdict = "blocked";
    db.tokens[id] = { id: id, b00: b00, created_at: iso(at - 120000), expires_at: iso(endOfDay(at)),
      week: ymd(weekStart(at)), used_at: verdict === "ok" ? iso(at) : null, counted: true, secret: rndHex(16) };
    if (verdict === "used") db.tokens[id].used_at = iso(at - 3600000);
    db.scans.push({ id: 0, token_id: id, b00: b00, verdict: verdict, scanned_at: iso(at) });
  }

  function load() {
    var db = null;
    try { db = JSON.parse(localStorage.getItem(DBK) || "null"); } catch (e) { db = null; }
    if (!db || db.v !== VERSION) {
      db = seed(); save(db);
      // Camille est déjà connectée : la démo commence directement sur sa carte.
      try {
        localStorage.setItem(AUTHK, JSON.stringify({ access_token: "demo|" + DEMO.email, refresh_token: "demo|" + DEMO.email,
          expires_at: Math.floor(now() / 1000) + 30 * 86400, email: DEMO.email }));
        localStorage.setItem("sesame-demo.install.dismissed", "1");   // pas de bandeau « installer » en démo
      } catch (e) {}
    }
    return db;
  }
  function save(db) { try { localStorage.setItem(DBK, JSON.stringify(db)); } catch (e) {} }
  load();   // crée la base (et la session de Camille) avant que l'appli ne démarre

  function reset() {
    try {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf("sesame-demo.") === 0) localStorage.removeItem(k); });
      Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf("sesame-demo.") === 0) sessionStorage.removeItem(k); });
    } catch (e) {}
  }

  /* ---------- règles (copie de supabase.sql) ---------- */
  function fail(code) { return Promise.reject({ status: 400, body: { message: code }, code: code }); }
  function emailOf(bearer) { return bearer && bearer.indexOf("demo|") === 0 ? bearer.slice(5) : null; }
  function byEmail(db, email) { for (var k in db.students) if (db.students[k].email === email) return db.students[k]; return null; }
  function allowed(db, email) { var d = db.settings.email_domain; return !d || new RegExp("@" + d.replace(/\./g, "\\.") + "$").test(email); }
  function weekCount(db, b00) {
    var wk = ymd(weekStart(now()));
    return Object.keys(db.tokens).filter(function (k) { var x = db.tokens[k]; return x.b00 === b00 && x.week === wk && x.counted; }).length;
  }
  function activeToken(db, b00) {
    var best = null;
    Object.keys(db.tokens).forEach(function (k) {
      var x = db.tokens[k];
      if (x.b00 === b00 && !x.used_at && new Date(x.expires_at) > now() && (!best || x.created_at > best.created_at)) best = x;
    });
    return best;
  }
  function pinValid(p) {
    if (!/^\d{6}$/.test(p || "")) return "PIN_FORMAT";
    if (/^(\d)\1{5}$/.test(p) || ["123456", "654321", "012345", "543210", "121212", "123123"].indexOf(p) >= 0) return "PIN_WEAK";
    return null;
  }
  function photoOk(p) { return p && p.slice(0, 11) === "data:image/" && p.length <= 300000; }

  function myState(db, email, withPhoto) {
    var s = byEmail(db, email);
    if (!s) return { registered: false, email: email, email_allowed: allowed(db, email) };
    var act = activeToken(db, s.b00), today = dayStart(now()), last = null;
    Object.keys(db.tokens).forEach(function (k) {
      var x = db.tokens[k];
      if (x.b00 === s.b00 && x.used_at && new Date(x.used_at).getTime() >= today && (!last || x.used_at > last)) last = x.used_at;
    });
    return {
      registered: true, email: email, b00: s.b00, prenom: s.prenom, nom: s.nom,
      photo: withPhoto ? s.photo : null, blocked: s.blocked, needs_consent: !s.consent_at,
      needs_photo: s.photo_reset, needs_pin: !s.pin,
      pin_locked_until: s.pin_locked_until && new Date(s.pin_locked_until) > now() ? s.pin_locked_until : null,
      used_this_week: weekCount(db, s.b00), week_limit: db.settings.week_limit,
      has_active: !!act, used_today_at: last
    };
  }

  function weekInfo(db, b00) {
    var wk = ymd(weekStart(now())), ws = weekStart(now()), passages = [], refused = 0;
    Object.keys(db.tokens).forEach(function (k) { var x = db.tokens[k]; if (x.b00 === b00 && x.week === wk && x.used_at) passages.push(x.used_at); });
    db.scans.forEach(function (c) { if (c.b00 === b00 && c.verdict !== "ok" && new Date(c.scanned_at).getTime() >= ws) refused++; });
    passages.sort().reverse();
    return { limit: db.settings.week_limit, generated: weekCount(db, b00), refused: refused, passages: passages };
  }
  function addScan(db, tokenId, b00, verdict) {
    db.scans.push({ id: db.seq++, token_id: tokenId, b00: b00, verdict: verdict, scanned_at: iso(now()) });
  }
  function withNames(db, c) {
    var s = c.b00 && db.students[c.b00];
    return { id: c.id, scanned_at: c.scanned_at, verdict: c.verdict, b00: c.b00, token_id: c.token_id,
             prenom: s ? s.prenom : null, nom: s ? s.nom : null };
  }

  function checkToken(db, raw) {
    raw = String(raw || "").trim();
    var m = /^([A-Z0-9]{8})\.(\d{1,15})\.([0-9a-f]{8})$/i.exec(raw), mode, code, stp, sig, code12;
    if (m) { mode = "qr"; code = m[1].toUpperCase(); stp = Number(m[2]); sig = m[3].toLowerCase(); }
    else {
      code12 = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (/^[A-Z0-9]{8}\d{4}$/.test(code12)) { mode = "manual"; code = code12.slice(0, 8); }
      else { mode = "static"; code = code12; }
    }
    var t = db.tokens[code], nowStep = step();
    var unknown = function () { addScan(db, code.slice(0, 32), null, "unknown"); save(db); return { verdict: "unknown" }; };
    if (!t || !t.secret) return Promise.resolve(t ? null : unknown()).then(function (r) { return r || finish(false); });

    var freshP;
    if (mode === "qr") {
      freshP = hmacHex(t.secret, t.id + "." + stp).then(function (hex) {
        if (hex.slice(0, 8) !== sig) return "forged";
        return stp >= nowStep - 1 && stp <= nowStep + 1;
      });
    } else if (mode === "manual") {
      var want = code12.slice(8), ks = [];
      for (var k = nowStep - 3; k <= nowStep + 1; k++) ks.push(k);
      freshP = Promise.all(ks.map(function (k) { return hmacHex(t.secret, t.id + "." + k); }))
        .then(function (hs) { return hs.some(function (h) { return otp(h) === want; }); });
    } else freshP = Promise.resolve(false);

    return freshP.then(function (fresh) { return fresh === "forged" ? unknown() : finish(fresh); });

    function finish(fresh) {
      var s = db.students[t.b00], v;
      if (s.blocked) v = "blocked";
      else if (t.used_at) v = "used";
      else if (new Date(t.expires_at) <= now()) v = "expired";
      else if (!fresh) v = "stale";
      else { t.used_at = iso(now()); v = "ok"; }
      addScan(db, t.id, t.b00, v);
      save(db);
      return { verdict: v, used_at: t.used_at, created_at: t.created_at,
               student: { b00: s.b00, prenom: s.prenom, nom: s.nom, photo: s.photo }, week: weekInfo(db, t.b00) };
    }
  }

  var RPC = {
    public_config: function (db) { return { email_domain: db.settings.email_domain, week_limit: db.settings.week_limit }; },

    my_state: function (db, a, email) { return myState(db, email, a.p_with_photo); },
    register_me: function (db, a, email) {
      var b00 = String(a.p_b00 || "").trim().toUpperCase(), pv = pinValid(a.p_pin);
      if (!allowed(db, email)) return fail("EMAIL_DOMAIN");
      if (!/^B00\d{6}$/.test(b00)) return fail("B00_FORMAT");
      if (!String(a.p_prenom || "").trim() || !String(a.p_nom || "").trim()) return fail("NAME_MISSING");
      if (!photoOk(a.p_photo)) return fail("PHOTO_INVALID");
      if (a.p_consent !== true) return fail("CONSENT_REQUIRED");
      if (pv) return fail(pv);
      var mine = byEmail(db, email);
      if (mine && mine.b00 !== b00) return fail("ALREADY_REGISTERED");
      if (db.students[b00]) { if (db.students[b00].email !== email) return fail("B00_TAKEN"); return myState(db, email, true); }
      db.students[b00] = { b00: b00, email: email, prenom: a.p_prenom.trim(), nom: a.p_nom.trim(), photo: a.p_photo,
        created_at: iso(now()), consent_at: iso(now()), blocked: false, photo_reset: false, pin: a.p_pin, pin_failures: 0, pin_locked_until: null };
      save(db);
      return myState(db, email, true);
    },
    give_consent: function (db, a, email) { var s = byEmail(db, email); if (s && !s.consent_at) { s.consent_at = iso(now()); save(db); } return myState(db, email, false); },
    update_my_photo: function (db, a, email) {
      var s = byEmail(db, email);
      if (!s) return fail("NOT_REGISTERED");
      if (!s.photo_reset) return fail("PHOTO_LOCKED");
      if (!photoOk(a.p_photo)) return fail("PHOTO_INVALID");
      s.photo = a.p_photo; s.photo_reset = false; save(db);
      return myState(db, email, true);
    },
    set_my_pin: function (db, a, email) {
      var s = byEmail(db, email), pv = pinValid(a.p_pin);
      if (!s) return fail("NOT_REGISTERED");
      if (s.pin) return fail("PIN_ALREADY_SET");
      if (pv) return fail(pv);
      s.pin = a.p_pin; s.pin_failures = 0; s.pin_locked_until = null; save(db);
      return myState(db, email, false);
    },
    generate_my_token: function (db, a, email) {
      var s = byEmail(db, email);
      if (!s) return fail("NOT_REGISTERED");
      if (s.blocked) return fail("BLOCKED");
      if (!s.consent_at) return fail("CONSENT_REQUIRED");
      if (s.photo_reset) return fail("PHOTO_REQUIRED");
      if (!s.pin) return fail("PIN_REQUIRED");
      if (s.pin_locked_until && new Date(s.pin_locked_until) > now()) return { error: "PIN_LOCKED", until: s.pin_locked_until };
      if (a.p_pin !== s.pin) {
        if (s.pin_failures + 1 >= 5) { s.pin_failures = 0; s.pin_locked_until = iso(now() + 15 * 60000); save(db); return { error: "PIN_LOCKED", until: s.pin_locked_until }; }
        s.pin_failures++; save(db);
        return { error: "PIN_BAD", remaining: 5 - s.pin_failures };
      }
      s.pin_failures = 0; s.pin_locked_until = null;
      var t = activeToken(db, s.b00);
      if (!t) {
        if (weekCount(db, s.b00) >= db.settings.week_limit) { save(db); return fail("WEEK_LIMIT"); }
        var id = rndId(db);
        t = db.tokens[id] = { id: id, b00: s.b00, created_at: iso(now()), expires_at: iso(endOfDay(now())),
          week: ymd(weekStart(now())), used_at: null, counted: true, secret: rndHex(16) };
      }
      save(db);
      return { state: myState(db, email, false), qr: { id: t.id, expires_at: t.expires_at, secret: t.secret, server_time: now() } };
    },
    delete_my_account: function (db, a, email) {
      var s = byEmail(db, email);
      if (s) { Object.keys(db.tokens).forEach(function (k) { if (db.tokens[k].b00 === s.b00) delete db.tokens[k]; }); delete db.students[s.b00]; save(db); }
      return { deleted: true };
    },

    verify_pin: function (db, a) { return a.p_pin === db.settings.agent_pin ? { ok: true } : { error: "bad" }; },
    check_token: function (db, a) { if (a.p_pin !== db.settings.agent_pin) return { error: "bad" }; return checkToken(db, a.p_code); },
    agent_history: function (db, a) {
      if (a.p_pin !== db.settings.agent_pin) return { error: "bad" };
      var start = dayStart(now()), items = db.scans.filter(function (c) { return new Date(c.scanned_at).getTime() >= start; })
        .slice().reverse().slice(0, 200).map(function (c) { return withNames(db, c); });
      return { ok: items.filter(function (c) { return c.verdict === "ok"; }).length,
               refused: items.filter(function (c) { return c.verdict !== "ok"; }).length, items: items };
    },

    admin_login: function () { return { ok: true, default_password: false }; },
    admin_overview: function (db) {
      var t = now(), today = dayStart(t), ws = weekStart(t), wk = ymd(ws), days = [];
      var cnt = function (from, to, ok) { return db.scans.filter(function (c) { var x = new Date(c.scanned_at).getTime(); return x >= from && x < to && (ok ? c.verdict === "ok" : c.verdict !== "ok"); }).length; };
      for (var d = 13; d >= 0; d--) { var b = today - d * 86400000; days.push({ day: ymd(b), ok: cnt(b, b + 86400000, true), refused: cnt(b, b + 86400000, false) }); }
      var studs = Object.keys(db.students).map(function (k) { return db.students[k]; });
      return {
        today_ok: cnt(today, Infinity, true), today_refused: cnt(today, Infinity, false),
        week_ok: cnt(ws, Infinity, true), week_refused: cnt(ws, Infinity, false),
        week_generated: Object.keys(db.tokens).filter(function (k) { return db.tokens[k].week === wk; }).length,
        students: studs.length, students_week: studs.filter(function (s) { return new Date(s.created_at).getTime() >= ws; }).length,
        blocked: studs.filter(function (s) { return s.blocked; }).length, days: days,
        settings: { week_limit: db.settings.week_limit, agent_pin: db.settings.agent_pin, email_domain: db.settings.email_domain },
        default_password: false
      };
    },
    admin_history: function (db, a) {
      var q = String(a.p_search || "").trim().toLowerCase();
      var f = db.scans.map(function (c) { return withNames(db, c); }).filter(function (c) {
        var d = ymd(c.scanned_at);
        if (a.p_from && d < a.p_from) return false;
        if (a.p_to && d > a.p_to) return false;
        if (!q) return true;
        return [c.b00, c.token_id, (c.prenom || "") + " " + (c.nom || ""), (c.nom || "") + " " + (c.prenom || "")]
          .some(function (x) { return String(x || "").toLowerCase().indexOf(q) >= 0; });
      }).reverse();
      var off = Math.max(a.p_offset || 0, 0), lim = Math.min(Math.max(a.p_limit || 50, 1), 10000);
      return { total: f.length, items: f.slice(off, off + lim) };
    },
    admin_students: function (db, a) {
      var q = String(a.p_search || "").trim().toLowerCase();
      var items = Object.keys(db.students).map(function (k) { return db.students[k]; }).filter(function (s) {
        return !q || [s.b00, s.email, s.prenom + " " + s.nom, s.nom + " " + s.prenom].some(function (x) { return x.toLowerCase().indexOf(q) >= 0; });
      }).sort(function (x, y) { return (x.nom + x.prenom).localeCompare(y.nom + y.prenom); }).map(function (s) {
        var oks = db.scans.filter(function (c) { return c.b00 === s.b00 && c.verdict === "ok"; });
        return { b00: s.b00, prenom: s.prenom, nom: s.nom, email: s.email, created_at: s.created_at, blocked: s.blocked,
          photo_reset: s.photo_reset, consent: !!s.consent_at, has_pin: !!s.pin, week_generated: weekCount(db, s.b00),
          total_ok: oks.length, last_ok: oks.length ? oks[oks.length - 1].scanned_at : null };
      });
      return { week_limit: db.settings.week_limit, items: items };
    },
    admin_student: function (db, a) {
      var s = db.students[String(a.p_b00 || "").trim().toUpperCase()];
      if (!s) return { error: "not_found" };
      var mine = db.scans.filter(function (c) { return c.b00 === s.b00; });
      return {
        b00: s.b00, prenom: s.prenom, nom: s.nom, email: s.email, photo: s.photo, created_at: s.created_at, consent_at: s.consent_at,
        blocked: s.blocked, photo_reset: s.photo_reset, has_pin: !!s.pin,
        pin_locked_until: s.pin_locked_until && new Date(s.pin_locked_until) > now() ? s.pin_locked_until : null,
        week_limit: db.settings.week_limit, week_generated: weekCount(db, s.b00),
        total_ok: mine.filter(function (c) { return c.verdict === "ok"; }).length,
        total_refused: mine.filter(function (c) { return c.verdict !== "ok"; }).length,
        scans: mine.slice().reverse().slice(0, 50).map(function (c) { return { scanned_at: c.scanned_at, verdict: c.verdict }; })
      };
    },
    admin_action: function (db, a) {
      var b00 = String(a.p_b00 || "").trim().toUpperCase(), s = db.students[b00], wk = ymd(weekStart(now()));
      if (!s) return { error: "not_found" };
      switch (a.p_action) {
        case "block": s.blocked = true; break;
        case "unblock": s.blocked = false; break;
        case "reset_photo": s.photo_reset = true; break;
        case "reset_pin": s.pin = null; s.pin_failures = 0; s.pin_locked_until = null; break;
        case "reset_week": Object.keys(db.tokens).forEach(function (k) { var x = db.tokens[k]; if (x.b00 === b00 && x.week === wk) x.counted = false; }); break;
        case "delete":
          Object.keys(db.tokens).forEach(function (k) { if (db.tokens[k].b00 === b00) delete db.tokens[k]; });
          delete db.students[b00]; save(db); return { deleted: true };
        default: return { error: "bad_action" };
      }
      save(db);
      return RPC.admin_student(db, a);
    },
    admin_set: function (db, a) {
      var v = String(a.p_value || "").trim(), k = a.p_key;
      if (k === "week_limit") { if (!/^\d{1,2}$/.test(v) || +v < 1) return { error: "bad_value" }; db.settings.week_limit = +v; }
      else if (k === "agent_pin") { if (!/^\d{4,8}$/.test(v)) return { error: "bad_value" }; db.settings.agent_pin = v; }
      else if (k === "admin_password") { if (v.length < 8) return { error: "bad_value" }; db.settings.admin_password = v; }
      else if (k === "email_domain") { v = v.replace(/^@/, "").toLowerCase(); if (v && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return { error: "bad_value" }; db.settings.email_domain = v; }
      else return { error: "bad_key" };
      save(db);
      return { ok: true, key: k, value: v };
    }
  };
  var STUDENT_FNS = ["my_state", "register_me", "give_consent", "update_my_photo", "set_my_pin", "generate_my_token", "delete_my_account"];

  function session(email) {
    return { access_token: "demo|" + email, refresh_token: "demo|" + email, expires_in: 30 * 86400,
             expires_at: Math.floor(now() / 1000) + 30 * 86400, user: { email: email } };
  }

  /* ---------- point d'entrée appelé par common.js ---------- */
  function call(path, body, bearer) {
    var db = load();
    return new Promise(function (res) { setTimeout(res, 180 + Math.random() * 220); }).then(function () {   // petit délai « réseau »
      if (path === "/auth/v1/otp") {
        if (!allowed(db, String(body.email || "").toLowerCase())) return {};
        return {};
      }
      if (path === "/auth/v1/verify") {
        if (body.token !== DEMO.mailCode) return Promise.reject({ status: 403, body: { error_code: "otp_expired", msg: "Token has expired or is invalid" }, code: "SERVER" });
        return session(String(body.email || "").toLowerCase());
      }
      if (path.indexOf("/auth/v1/token") === 0) { var e = emailOf(body.refresh_token); return e ? session(e) : Promise.reject({ status: 400, body: {}, code: "SERVER" }); }
      if (path === "/auth/v1/logout") return {};

      var fn = path.replace("/rest/v1/rpc/", ""), f = RPC[fn];
      if (!f) return fail("SERVER");
      var email = emailOf(bearer);
      if (STUDENT_FNS.indexOf(fn) >= 0 && !email) return Promise.reject({ status: 401, body: {}, code: "NOT_AUTH" });
      if (fn.indexOf("admin_") === 0 && body.p_pw !== db.settings.admin_password) return { error: "bad" };
      return f(db, body, email);
    });
  }

  window.SesameDemo = { call: call, reset: reset, creds: DEMO, load: load, hmacHex: hmacHex };

  /* ---------- interface de la démo ---------- */
  function ready(fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else setTimeout(fn, 0); }
  ready(function () {
    var embedded = window.top !== window;
    var q = function (s) { return document.querySelector(s); };
    var isAdmin = !!q("#a-login");

    if (!embedded) {
      var bar = document.createElement("div");
      bar.className = "demo-bar";
      bar.innerHTML = '<div class="demo-bar-in"><b>Démo</b><span>Profils fictifs, rien n\'est enregistré en ligne.</span>'
        + (isAdmin ? '<span>Mot de passe : <code>' + DEMO.adminPw + '</code></span>'
                   : '<span>Code perso : <code>' + DEMO.studentPin + '</code></span><span>PIN agent : <code>' + DEMO.agentPin + '</code></span>')
        + '<button type="button">Réinitialiser</button></div>';
      var top = q(".topbar");
      top.parentNode.insertBefore(bar, top.nextSibling);
      bar.querySelector("button").onclick = function () { reset(); location.reload(); };
    }

    if (isAdmin) { q("#a-pw").placeholder = "Démo : " + DEMO.adminPw; return; }

    // Le code de démo est écrit en clair sous chaque champ, avec un bouton pour le remplir
    // (dans le champ lui-même, le texte était coupé sur petit écran).
    function hintUnder(inputSel, label, value) {
      var input = q(inputSel), p = document.createElement("p");
      input.placeholder = value;
      p.className = "demo-fill";
      p.innerHTML = "<span>" + label + " <code>" + value + "</code></span>";
      var b = document.createElement("button");
      b.type = "button"; b.textContent = "Remplir";
      b.onclick = function () { input.value = value; input.dispatchEvent(new Event("input")); input.focus(); };
      p.appendChild(b);
      var lbl = input.closest("label") || input;
      lbl.parentNode.insertBefore(p, lbl.nextSibling);
    }
    hintUnder("#c-pin", "Démo : le code de Camille est", DEMO.studentPin);
    hintUnder("#pin", "Démo : le PIN agent est", DEMO.agentPin);
    hintUnder("#k-code", "Démo : le code reçu par mail est", DEMO.mailCode);
    var lead = q("#s-code .lead");
    if (lead) lead.insertAdjacentHTML("beforeend", "<br><b>Démo :</b> aucun mail n'est envoyé, le code est <b>" + DEMO.mailCode + "</b>.");

    // Côté agent : « scanner » le QR affiché côté étudiant, sans caméra.
    var box = document.createElement("div");
    box.className = "demo-scan";
    box.innerHTML = "<p><b>Démo :</b> pas besoin de caméra. Générez un QR côté étudiant, puis :</p>"
      + '<div class="row"><button class="btn" type="button" id="demo-scan-live">Scanner le QR</button>'
      + '<button class="btn ghost" type="button" id="demo-scan-old">Tester une capture d\'écran</button></div>'
      + '<p id="demo-scan-msg" hidden></p>';
    var scanner = q("#ag-scanner");
    scanner.insertBefore(box, scanner.firstChild);
    var msg = q("#demo-scan-msg");
    function current() {
      var p = localStorage.getItem("sesame-demo.qr");
      if (!p) { msg.hidden = false; msg.textContent = "Aucun QR affiché pour l'instant : côté étudiant, cliquez sur « Générer mon QR » et tapez " + DEMO.studentPin + "."; }
      else msg.hidden = true;
      return p;
    }
    q("#demo-scan-live").onclick = function () { var p = current(); if (p && window.SesameApp) window.SesameApp.scan(p); };
    q("#demo-scan-old").onclick = function () {
      var p = current(); if (!p) return;
      // Même QR, mais tel qu'il était 30 secondes plus tôt : c'est ce que donnerait une capture d'écran.
      var id = p.slice(7, 15), t = load().tokens[id];
      if (!t) return;
      var old = step() - 3;
      hmacHex(t.secret, id + "." + old).then(function (hex) { window.SesameApp.scan("SESAME:" + id + "." + old + "." + hex.slice(0, 8)); });
    };
  });
})();
