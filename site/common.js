/* Sésame — outils partagés (appli étudiant/agent et espace admin) */
(function () {
  "use strict";

  var CFG = window.SESAME_CONFIG || {};
  var BASE = String(CFG.SUPABASE_URL || "").replace(/\/+$/, "");
  var KEY = String(CFG.SUPABASE_KEY || "");

  // Mode démo (?demo dans l'adresse) : faux étudiants, base simulée dans le navigateur
  // (demo-server.js). Rien n'est envoyé à la vraie base de données.
  var DEMO = /(^|[?&])demo(=|&|$)/.test(location.search.slice(1));
  var configured = DEMO || (/^https:\/\//.test(BASE) && KEY && !/COLLEZ/.test(KEY));

  // En démo, les données du navigateur sont rangées à part pour ne jamais se mélanger aux vraies.
  function nk(k) { return DEMO ? String(k).replace(/^sesame\./, "sesame-demo.") : k; }

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var store = {
    get: function (k) { try { return localStorage.getItem(nk(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(nk(k), v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(nk(k)); } catch (e) {} },
    getJSON: function (k) { try { return JSON.parse(localStorage.getItem(nk(k)) || "null"); } catch (e) { return null; } },
    setJSON: function (k, v) { try { localStorage.setItem(nk(k), JSON.stringify(v)); } catch (e) {} }
  };
  var sess = {
    get: function (k) { try { return sessionStorage.getItem(nk(k)); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(nk(k), v); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(nk(k)); } catch (e) {} }
  };

  function show(el, on) { if (el) el.hidden = !on; }
  function setErr(el, msg) { if (!el) return; el.textContent = msg || ""; el.hidden = !msg; }
  function hm(t) { return new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
  function dayFr(t) { return new Date(t).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }); }
  function dateFr(t) { return new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  function isToday(t) { return !!t && new Date(t).toDateString() === new Date().toDateString(); }
  function fmtCode(id) { id = String(id || ""); return id.length > 4 ? id.slice(0, 4) + "-" + id.slice(4, 8) : id; }
  function plural(n, one, many) { return n + " " + (n > 1 ? many : one); }

  var VERDICTS = {
    ok: ["Autorisé", "ok"], used: ["Déjà utilisé", "bad"], expired: ["Expiré", "warn"],
    blocked: ["Compte bloqué", "bad"], unknown: ["Inconnu", "bad"], stale: ["Capture refusée", "warn"]
  };

  var MESSAGES = {
    NOT_AUTH: "Votre session a expiré. Reconnectez-vous avec votre adresse mail.",
    EMAIL_DOMAIN: "Utilisez votre adresse mail de l'école.",
    B00_FORMAT: "Le numéro doit être B00 suivi de 6 chiffres, par exemple B00123456.",
    NAME_MISSING: "Entrez votre prénom et votre nom.",
    PHOTO_INVALID: "La photo n'a pas pu être enregistrée. Essayez avec une autre photo.",
    PHOTO_LOCKED: "Votre photo est verrouillée. Pour la changer, adressez-vous à l'équipe sécurité.",
    PHOTO_REQUIRED: "L'équipe sécurité vous demande une nouvelle photo avant de générer un QR.",
    CONSENT_REQUIRED: "Cochez la case pour accepter l'utilisation de vos données.",
    B00_TAKEN: "Ce numéro étudiant est déjà inscrit avec une autre adresse mail. Adressez-vous à l'équipe sécurité.",
    ALREADY_REGISTERED: "Cette adresse mail est déjà inscrite avec un autre numéro étudiant.",
    NOT_REGISTERED: "Ce compte n'est pas encore inscrit.",
    BLOCKED: "Votre compte est bloqué. Adressez-vous à l'équipe sécurité.",
    WEEK_LIMIT: "Limite de QR atteinte cette semaine.",
    PIN_FORMAT: "Le code personnel doit compter exactement 6 chiffres.",
    PIN_WEAK: "Ce code est trop simple (par exemple 123456 ou 111111). Choisissez-en un autre.",
    PIN_REQUIRED: "Choisissez d'abord votre code personnel.",
    PIN_ALREADY_SET: "Votre code personnel existe déjà. Pour le changer, adressez-vous à l'équipe sécurité.",
    bad: "Code incorrect.",
    locked: "Trop d'essais incorrects. Réessayez dans 15 minutes.",
    bad_value: "Valeur invalide.",
    not_found: "Introuvable.",
    NETWORK: "Pas de connexion internet. Vérifiez le réseau et réessayez.",
    CONFIG: "L'appli n'est pas encore reliée à sa base de données (config.js).",
    SERVER: "Le serveur a renvoyé une erreur. Réessayez dans un instant."
  };
  function errMsg(e) { return MESSAGES[e && e.code] || MESSAGES.SERVER; }

  function baseHeaders(bearer) {
    var h = { "Content-Type": "application/json", apikey: KEY };
    if (bearer) h.Authorization = "Bearer " + bearer;
    else if (KEY.indexOf("sb_") !== 0) h.Authorization = "Bearer " + KEY;   // ancienne clé "anon" (JWT)
    return h;
  }

  function call(path, body, bearer) {
    if (DEMO) {
      if (!window.SesameDemo) return Promise.reject({ code: "SERVER" });
      return window.SesameDemo.call(path, body || {}, bearer);
    }
    if (!configured) return Promise.reject({ code: "CONFIG" });
    return fetch(BASE + path, { method: "POST", headers: baseHeaders(bearer), body: JSON.stringify(body || {}) })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
          if (!res.ok) throw { status: res.status, body: data, code: (data && data.message) || "SERVER" };
          return data;
        });
      }, function () { throw { code: "NETWORK" }; });
  }

  /* ---------- Connexion étudiant : code à usage unique reçu par mail ---------- */
  var AUTH_KEY = "sesame.auth";
  var session = store.getJSON(AUTH_KEY);
  var refreshing = null;

  function saveSession(d) {
    var exp = d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600);
    session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: exp,
                email: (d.user && d.user.email) || (session && session.email) || "" };
    store.setJSON(AUTH_KEY, session);
    return session;
  }

  function authError(e) {
    var b = (e && e.body) || {};
    var code = String(b.error_code || b.error || "");
    var text = String(b.msg || b.error_description || b.message || "");
    var c = code + " " + text, msg;
    if (e && e.code === "NETWORK") return MESSAGES.NETWORK;
    if (e && e.code === "CONFIG") return MESSAGES.CONFIG;
    if (/over_email_send_rate_limit|over_request_rate_limit|rate.?limit|security purposes/i.test(c) || (e && e.status === 429))
      msg = "Trop de demandes de code. Attendez une minute, puis réessayez.";
    else if (/email_address_not_authorized|not authorized/i.test(c))
      msg = "L'envoi des mails n'est pas encore configuré : il faut activer le SMTP personnalisé dans Supabase.";
    else if (/sending|smtp|unexpected_failure/i.test(c) || (e && e.status >= 500))
      msg = "Le mail n'a pas pu être envoyé. Vérifiez les réglages SMTP dans Supabase (adresse d'envoi, mot de passe d'application).";
    else if (/otp_expired|otp_disabled|token has expired|token.*invalid|invalid.*token/i.test(c))
      msg = "Code incorrect ou expiré. Vérifiez-le, ou demandez un nouveau code.";
    else if (/signup_disabled|signups not allowed/i.test(c))
      msg = "Les inscriptions sont désactivées dans Supabase (Authentication > Sign In / Providers).";
    else if (/email_provider_disabled|email logins are disabled/i.test(c))
      msg = "La connexion par mail est désactivée dans Supabase (Authentication > Sign In / Providers > Email).";
    else if (/invalid api key|no api key/i.test(c) || (e && e.status === 401))
      msg = "La clé dans config.js n'est pas acceptée par Supabase. Vérifiez SUPABASE_KEY.";
    else if (/email_address_invalid|unable to validate email|invalid format/i.test(c))
      msg = "Supabase refuse cette adresse mail.";
    else msg = MESSAGES.SERVER;
    // Détail technique affiché pour aider au diagnostic pendant les tests
    if (text || code) msg += " (détail : " + (code ? code + " — " : "") + text + ")";
    return msg;
  }

  var auth = {
    get email() { return session && session.email; },
    get signedIn() { return !!(session && session.refresh_token); },
    sendCode: function (email) {
      return call("/auth/v1/otp", { email: email, create_user: true });
    },
    verify: function (email, token) {
      return call("/auth/v1/verify", { type: "email", email: email, token: token }).then(function (d) {
        if (!d || !d.access_token) throw { code: "SERVER" };
        saveSession(d);
        return session;
      });
    },
    refresh: function () {
      if (!session || !session.refresh_token) return Promise.reject({ code: "NOT_AUTH" });
      if (!refreshing) {
        refreshing = call("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token })
          .then(saveSession, function (e) {
            if (e.code !== "NETWORK") auth.clear();
            throw e.code === "NETWORK" ? e : { code: "NOT_AUTH" };
          })
          .then(function (s) { refreshing = null; return s; }, function (e) { refreshing = null; throw e; });
      }
      return refreshing;
    },
    token: function () {
      if (!session) return Promise.reject({ code: "NOT_AUTH" });
      if (session.expires_at - 60 > Date.now() / 1000) return Promise.resolve(session.access_token);
      return auth.refresh().then(function (s) { return s.access_token; });
    },
    signOut: function () {
      var t = session && session.access_token;
      auth.clear();
      if (t && configured) call("/auth/v1/logout", {}, t).catch(function () {});
    },
    clear: function () { session = null; store.del(AUTH_KEY); },
    errorMessage: authError
  };

  /* ---------- Appel d'une fonction de la base ---------- */
  function rpc(fn, args, opts) {
    opts = opts || {};
    if (!opts.user) return call("/rest/v1/rpc/" + fn, args);
    var attempt = function (retry) {
      return auth.token().then(function (t) {
        return call("/rest/v1/rpc/" + fn, args, t).catch(function (e) {
          if (retry && e.status === 401) return auth.refresh().then(function () { return attempt(false); });
          throw e;
        });
      });
    };
    return attempt(true);
  }

  // En démo, les liens entre les pages (appli ↔ espace sécurité) restent en démo.
  if (DEMO) {
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function (a) {
      var h = a.getAttribute("href");
      if (/^(\.\/|admin\.html|index\.html)/.test(h) && h.indexOf("demo") < 0) {
        var parts = h.split("#");
        a.setAttribute("href", parts[0] + (parts[0].indexOf("?") < 0 ? "?" : "&") + "demo" + (parts[1] ? "#" + parts[1] : ""));
      }
    });
    document.documentElement.classList.add("is-demo");
  }

  window.Sesame = {
    demo: DEMO, nk: nk,
    CFG: CFG, configured: configured, $: $, store: store, sess: sess, show: show, setErr: setErr,
    hm: hm, dayFr: dayFr, dateFr: dateFr, isToday: isToday, fmtCode: fmtCode, plural: plural,
    VERDICTS: VERDICTS, MESSAGES: MESSAGES, errMsg: errMsg, rpc: rpc, auth: auth
  };
})();
