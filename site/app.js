/* Sésame — appli étudiant + agent (v2) */
(function () {
  "use strict";

  var S = window.Sesame, $ = S.$, show = S.show, setErr = S.setErr, store = S.store, sess = S.sess;
  var auth = S.auth, rpc = S.rpc, hm = S.hm, dayFr = S.dayFr, plural = S.plural;
  var PREFIX = "SESAME:";
  var CONTACT = /COLLEZ/.test(S.CFG.CONTACT_EMAIL || "") ? "l'équipe du projet" : (S.CFG.CONTACT_EMAIL || "l'équipe du projet");

  /* ---------- notice RGPD (même texte partout) ---------- */
  Array.prototype.forEach.call(document.querySelectorAll(".privacy"), function (box) {
    box.appendChild(document.importNode($("#tpl-privacy").content, true));
    Array.prototype.forEach.call(box.querySelectorAll(".contact"), function (c) { c.textContent = CONTACT; });
  });

  /* ---------- onglets ---------- */
  function setView(v) {
    $("#tab-etu").setAttribute("aria-selected", v === "etu");
    $("#tab-agent").setAttribute("aria-selected", v === "agent");
    show($("#v-etu"), v === "etu");
    show($("#v-agent"), v === "agent");
    store.set("sesame.view", v);
    if (v !== "agent") stopCamera();
  }
  $("#tab-etu").onclick = function () { setView("etu"); };
  $("#tab-agent").onclick = function () { setView("agent"); };

  /* ---------- images ---------- */
  function loadImg(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), i = new Image();
      i.onload = function () { res(i); URL.revokeObjectURL(u); };
      i.onerror = function () { rej(new Error("img")); URL.revokeObjectURL(u); };
      i.src = u;
    });
  }
  function squarePhoto(file) {
    return loadImg(file).then(function (img) {
      var s = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement("canvas");
      c.width = c.height = 360;
      c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 360, 360);
      return c.toDataURL("image/jpeg", 0.8);
    });
  }
  function pickPhoto(input, preview, errEl, done) {
    input.onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      squarePhoto(f).then(function (data) {
        var i = new Image(); i.src = data; i.alt = "";
        preview.textContent = ""; preview.appendChild(i);
        setErr(errEl); done(data);
      }, function () { setErr(errEl, "Impossible de lire cette image. Essayez une autre photo."); });
    };
  }
  var work = document.createElement("canvas"), workCtx = work.getContext("2d", { willReadFrequently: true });
  function readQR(source, w, h, max) {
    var k = Math.min(1, max / Math.max(w, h));
    work.width = Math.round(w * k); work.height = Math.round(h * k);
    workCtx.drawImage(source, 0, 0, work.width, work.height);
    var r = window.jsQR(workCtx.getImageData(0, 0, work.width, work.height).data, work.width, work.height, { inversionAttempts: "attemptBoth" });
    return r ? r.data : null;
  }

  /* =================================================================
     ÉTUDIANT
     ================================================================= */
  var SCREENS = ["#s-email", "#s-code", "#s-reg", "#s-consent", "#s-photo", "#s-setpin", "#stu-card"];
  function screen(id) { SCREENS.forEach(function (s) { show($(s), s === id); }); }

  var cfg = store.getJSON("sesame.cfg") || { email_domain: "essec.edu", week_limit: 6 };
  function domainHint() {
    $("#e-hint").textContent = cfg.email_domain ? "Adresse @" + cfg.email_domain + " uniquement." : "";
    $("#e-email").placeholder = "prenom.nom@" + (cfg.email_domain || "essec.edu");
  }
  domainHint();
  if (S.configured) rpc("public_config", {}).then(function (c) { cfg = c; store.setJSON("sesame.cfg", c); domainHint(); }, function () {});

  /* ----- 1. adresse mail ----- */
  var pendingEmail = store.get("sesame.pendingEmail") || "";
  var resendAt = 0, resendTimer = null;

  $("#f-email").onsubmit = function (e) {
    e.preventDefault();
    var E = $("#e-err"); setErr(E);
    var email = $("#e-email").value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setErr(E, "Entrez une adresse mail valide.");
    if (cfg.email_domain && !new RegExp("@" + cfg.email_domain.replace(/\./g, "\\.") + "$").test(email))
      return setErr(E, "Utilisez votre adresse @" + cfg.email_domain + ".");
    var btn = $("#e-submit"); btn.disabled = true; btn.textContent = "Envoi du code…";
    auth.sendCode(email).then(function () {
      pendingEmail = email; store.set("sesame.pendingEmail", email);
      openCodeScreen();
    }, function (err) { setErr(E, auth.errorMessage(err)); })
      .then(function () { btn.disabled = false; btn.textContent = "Recevoir mon code"; });
  };

  function openCodeScreen() {
    $("#c-to").textContent = pendingEmail;
    $("#k-code").value = ""; setErr($("#k-err"));
    screen("#s-code");
    resendAt = Date.now() + 60000; tickResend();
    setTimeout(function () { try { $("#k-code").focus(); } catch (e) {} }, 50);
  }
  function tickResend() {
    clearTimeout(resendTimer);
    var left = Math.ceil((resendAt - Date.now()) / 1000), b = $("#k-resend");
    b.disabled = left > 0;
    b.textContent = left > 0 ? "Renvoyer le code (" + left + " s)" : "Renvoyer le code";
    if (left > 0) resendTimer = setTimeout(tickResend, 1000);
  }
  $("#k-resend").onclick = function () {
    setErr($("#k-err"));
    auth.sendCode(pendingEmail).then(function () { resendAt = Date.now() + 60000; tickResend(); setErr($("#k-err")); },
      function (err) { setErr($("#k-err"), auth.errorMessage(err)); });
  };
  $("#k-change").onclick = function () { store.del("sesame.pendingEmail"); screen("#s-email"); };
  $("#k-code").addEventListener("input", function (e) { e.target.value = e.target.value.replace(/\D/g, ""); });

  $("#f-code").onsubmit = function (e) {
    e.preventDefault();
    var E = $("#k-err"), code = $("#k-code").value.replace(/\D/g, "");
    if (code.length < 6) return setErr(E, "Le code compte au moins 6 chiffres.");
    var btn = $("#k-submit"); if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "Vérification…";
    auth.verify(pendingEmail, code).then(function () {
      store.del("sesame.pendingEmail");
      return loadState(true);
    }).catch(function (err) { setErr(E, err && err.status ? auth.errorMessage(err) : S.errMsg(err)); })
      .then(function () { btn.disabled = false; btn.textContent = "Valider"; });
  };

  /* ----- déconnexion ----- */
  function signOut() {
    clearInterval(pollTimer); pollTimer = null;
    auth.signOut();
    state = null; shownQR = null; qrNow = null; regPhoto = null; newPhoto = null;
    store.del("sesame.state"); store.del("sesame.photo");
    $("#e-email").value = "";
    screen("#s-email");
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-signout]"), function (b) { b.onclick = signOut; });

  /* ----- état de l'étudiant ----- */
  var state = null, pollTimer = null, shownQR = null;

  function loadState(withPhoto) {
    var needPhoto = withPhoto || !store.get("sesame.photo");
    return rpc("my_state", { p_with_photo: needPhoto }, { user: true }).then(route, function (err) {
      if (err.code === "NOT_AUTH") { signOut(); setErr($("#e-err"), S.MESSAGES.NOT_AUTH); return; }
      if (state) { setErr($("#c-err"), S.errMsg(err)); return; }
      setErr($("#e-err"), S.errMsg(err));
    });
  }

  function route(s) {
    if (s.photo) store.set("sesame.photo", s.photo);
    if (!s.registered || s.needs_consent || s.needs_photo || s.needs_pin || s.blocked) qrNow = null;
    if (!s.registered) {
      if (!s.email_allowed) {
        signOut();
        setErr($("#e-err"), "Cette adresse n'est pas autorisée. Utilisez votre adresse @" + (cfg.email_domain || "de l'école") + ".");
        return;
      }
      store.del("sesame.state");
      screen("#s-reg");
      return;
    }
    if (s.needs_consent) { screen("#s-consent"); return; }
    if (s.needs_photo) { screen("#s-photo"); return; }
    if (s.needs_pin) { screen("#s-setpin"); return; }
    openCard(s);
  }

  /* ----- code personnel ----- */
  function pinProblem(a, b) {
    if (!/^\d{6}$/.test(a)) return S.MESSAGES.PIN_FORMAT;
    if (/^(\d)\1{5}$/.test(a) || ["123456", "654321", "012345", "543210", "121212", "123123"].indexOf(a) >= 0) return S.MESSAGES.PIN_WEAK;
    if (a !== b) return "Les deux codes ne sont pas identiques.";
    return null;
  }
  Array.prototype.forEach.call(document.querySelectorAll("input.pin"), function (i) {
    i.addEventListener("input", function () { i.value = i.value.replace(/\D/g, "").slice(0, 6); });
  });

  $("#f-setpin").onsubmit = function (e) {
    e.preventDefault();
    var E = $("#n-err"), a = $("#n-pin").value, p = pinProblem(a, $("#n-pin2").value);
    if (p) return setErr(E, p);
    var b = $("#n-submit"); b.disabled = true; setErr(E);
    rpc("set_my_pin", { p_pin: a }, { user: true }).then(function (st) {
      $("#n-pin").value = ""; $("#n-pin2").value = ""; route(st);
    }, function (err) { setErr(E, S.errMsg(err)); }).then(function () { b.disabled = false; });
  };

  /* ----- 3. inscription ----- */
  var regPhoto = null, newPhoto = null;
  pickPhoto($("#r-photo"), $("#r-ph"), $("#r-err"), function (d) { regPhoto = d; });
  pickPhoto($("#p-photo"), $("#p-ph"), $("#p-err"), function (d) { newPhoto = d; });
  $("#r-b00").addEventListener("input", function (e) { e.target.value = e.target.value.toUpperCase().replace(/\s/g, ""); });

  $("#f-reg").onsubmit = function (e) {
    e.preventDefault();
    var E = $("#r-err"); setErr(E);
    var prenom = $("#r-prenom").value.trim(), nom = $("#r-nom").value.trim(), b00 = $("#r-b00").value.trim().toUpperCase();
    if (!prenom || !nom) return setErr(E, S.MESSAGES.NAME_MISSING);
    if (!/^B00\d{6}$/.test(b00)) return setErr(E, S.MESSAGES.B00_FORMAT);
    if (!regPhoto) return setErr(E, "Ajoutez une photo de vous : l'agent la compare avec votre visage.");
    var pin = $("#r-pin").value, pinErr = pinProblem(pin, $("#r-pin2").value);
    if (pinErr) return setErr(E, pinErr);
    if (!$("#r-consent").checked) return setErr(E, S.MESSAGES.CONSENT_REQUIRED);
    var btn = $("#r-submit"); btn.disabled = true; btn.textContent = "Création…";
    rpc("register_me", { p_prenom: prenom, p_nom: nom, p_b00: b00, p_photo: regPhoto, p_consent: true, p_pin: pin }, { user: true })
      .then(route, function (err) { setErr(E, S.errMsg(err)); })
      .then(function () { btn.disabled = false; btn.textContent = "Créer mon pass"; });
  };

  $("#g-accept").onclick = function () {
    var b = $("#g-accept"); b.disabled = true;
    rpc("give_consent", {}, { user: true }).then(route, function (err) { setErr($("#g-err"), S.errMsg(err)); })
      .then(function () { b.disabled = false; });
  };

  $("#p-save").onclick = function () {
    if (!newPhoto) return setErr($("#p-err"), "Prenez d'abord une photo.");
    var b = $("#p-save"); b.disabled = true;
    rpc("update_my_photo", { p_photo: newPhoto }, { user: true }).then(route, function (err) { setErr($("#p-err"), S.errMsg(err)); })
      .then(function () { b.disabled = false; });
  };

  /* ----- 4. carte et QR ----- */
  // Le QR n'est affiché qu'après le code personnel. Il est gardé en mémoire seulement
  // (jamais enregistré sur le téléphone) et masqué si l'appli reste en arrière-plan plus de 2 min.
  var qrNow = null, hiddenAt = 0;

  function openCard(s) {
    screen("#stu-card");
    var photo = s.photo || store.get("sesame.photo");
    if (photo) $("#c-photo").src = photo;
    $("#c-name").textContent = s.prenom + " " + s.nom;
    $("#c-b00").textContent = s.b00;
    render(s);
    showInstallTip();
  }

  function render(s) {
    state = s;
    store.setJSON("sesame.state", s);
    var n = s.used_this_week, lim = s.week_limit || 6;
    if (qrNow && (s.blocked || !s.has_active || new Date(qrNow.expires_at) <= new Date())) qrNow = null;   // QR utilisé, expiré ou compte bloqué

    $("#c-quota").textContent = n + " / " + lim + " QR utilisés cette semaine";
    var dots = "";
    for (var i = 0; i < lim; i++) dots += '<i class="' + (i < n ? "used" : "") + '"></i>';
    $("#c-dots").innerHTML = dots;

    show($("#c-qrbox"), !!qrNow);
    if (qrNow) {
      if (shownQR !== qrNow.id) { shownQR = qrNow.id; live.step = null; }
      startLive();
    } else {
      stopLive(); shownQR = null; $("#qr").innerHTML = ""; $("#c-code").textContent = "";
    }

    var usedToday = !s.has_active && S.isToday(s.used_today_at);
    show($("#c-used"), usedToday && !qrNow);
    if (usedToday) $("#c-used-t").textContent = "Passage validé à " + hm(s.used_today_at);

    var full = n >= lim;
    var canAsk = !qrNow && !s.blocked && (s.has_active || !full);
    var formOpen = !$("#c-pinform").hidden;
    show($("#c-gen"), canAsk && !formOpen);
    if (!canAsk) show($("#c-pinform"), false);
    $("#c-gen").textContent = s.has_active ? "Afficher mon QR" : usedToday ? "Générer un nouveau QR" : "Générer mon QR";

    var box = $("#c-alert");
    if (s.blocked) {
      box.className = "alert bad";
      $("#c-alert-t").textContent = "Votre compte est bloqué";
      $("#c-alert-p").textContent = "L'équipe sécurité a suspendu votre accès à Sésame. Présentez-vous à l'accueil sécurité.";
      show($("#c-reg"), false); show(box, true);
    } else if (full) {
      box.className = "alert bad";
      $("#c-alert-t").textContent = s.has_active ? "C'est votre dernier QR de la semaine" : "Vous avez utilisé tous vos QR cette semaine";
      $("#c-alert-p").textContent = (s.has_active ? "Après celui-ci, vous ne pourrez plus en générer avant lundi. " : "")
        + "Sans votre carte, adressez-vous à l'agent de sécurité à l'entrée. "
        + "Si vous l'avez perdue, ou si vous l'oubliez trop souvent, rendez-vous au registraire pour la refaire.";
      show($("#c-reg"), true); show(box, true);
    } else if (lim - n === 1) {
      box.className = "alert warn";
      $("#c-alert-t").textContent = "Plus qu'un QR disponible cette semaine";
      $("#c-alert-p").textContent = "Pensez à retrouver votre carte étudiante et à ne plus l'oublier : le prochain QR sera le dernier avant lundi.";
      show($("#c-reg"), false); show(box, true);
    } else {
      show(box, false);
    }

    clearInterval(pollTimer); pollTimer = null;
    if (qrNow) pollTimer = setInterval(function () { if (!document.hidden) loadState(false); }, 4000);
  }

  /* ----- QR dynamique : un nouveau QR toutes les 10 secondes ----- */
  // Le QR contient « code.étape.signature ». La signature est calculée sur le téléphone avec
  // la clé secrète du QR (reçue après le code personnel, gardée en mémoire seulement).
  // Le serveur refuse un QR de plus de ~20 s : une capture d'écran ne sert à rien.
  var STEP_MS = 10000, qrOffset = 0;
  var live = { timer: null, step: null };
  var enc = window.TextEncoder ? new TextEncoder() : null;

  function hmacHex(secret, msg) {
    if (!enc || !window.crypto || !crypto.subtle) return Promise.reject(new Error("crypto"));
    return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then(function (key) { return crypto.subtle.sign("HMAC", key, enc.encode(msg)); })
      .then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
      });
  }
  function otp(hex) { return ("000" + (parseInt(hex.slice(8, 16), 16) % 10000)).slice(-4); }
  function drawQR(payload) {
    var qr = window.qrcode(0, "M");
    qr.addData(payload); qr.make();
    $("#qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  }
  function startLive() {
    if (!qrNow) return;
    if (!qrNow.secret) {                       // base pas encore mise à jour : ancien QR fixe
      show($("#qr-live"), false);
      if (live.step !== "static") { drawQR(PREFIX + qrNow.id); $("#c-code").textContent = S.fmtCode(qrNow.id); live.step = "static"; }
      return;
    }
    show($("#qr-live"), true);
    if (!live.timer) live.timer = setInterval(tickLive, 200);
    tickLive();
  }
  function stopLive() { clearInterval(live.timer); live.timer = null; live.step = null; }
  function tickLive() {
    if (!qrNow || !qrNow.secret) return stopLive();
    var now = Date.now() + qrOffset, step = Math.floor(now / STEP_MS), left = STEP_MS - (now % STEP_MS);
    $("#qr-bar").style.transform = "scaleX(" + (left / STEP_MS).toFixed(3) + ")";
    $("#qr-secs").textContent = Math.ceil(left / 1000) + " s";
    $("#qr-clock").textContent = new Date(now).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (step === live.step) return;
    live.step = step;
    var id = qrNow.id;
    hmacHex(qrNow.secret, id + "." + step).then(function (hex) {
      if (!qrNow || qrNow.id !== id || live.step !== step) return;
      var payload = PREFIX + id + "." + step + "." + hex.slice(0, 8);
      drawQR(payload);
      $("#c-code").textContent = S.fmtCode(id) + "-" + otp(hex);
      var box = $("#c-qrbox"); box.classList.remove("flip"); void box.offsetWidth; box.classList.add("flip");
      if (S.demo) store.set("sesame.qr", payload);         // la démo « scanne » ce QR côté agent
    }, function () {
      setErr($("#c-err"), "Ce navigateur ne peut pas afficher le QR sécurisé. Ouvrez Sésame dans Safari ou Chrome, en https.");
    });
  }

  function lockedText(until) { return "Trop de codes incorrects. Réessayez à " + hm(until) + "."; }

  $("#c-gen").onclick = function () {
    setErr($("#c-err")); setErr($("#c-pin-err"));
    if (state && state.pin_locked_until && new Date(state.pin_locked_until) > new Date())
      setErr($("#c-pin-err"), lockedText(state.pin_locked_until));
    show($("#c-gen"), false); show($("#c-pinform"), true);
    $("#c-pin").value = "";
    setTimeout(function () { try { $("#c-pin").focus(); } catch (e) {} }, 30);
  };
  $("#c-pin-cancel").onclick = function () {
    show($("#c-pinform"), false); setErr($("#c-pin-err")); $("#c-pin").value = "";
    if (state) render(state);
  };
  $("#c-pinform").onsubmit = function (e) {
    e.preventDefault();
    var E = $("#c-pin-err"), pin = $("#c-pin").value;
    if (!/^\d{6}$/.test(pin)) return setErr(E, "Entrez vos 6 chiffres.");
    var b = $("#c-pin-ok"); if (b.disabled) return;
    b.disabled = true; b.textContent = "Vérification…"; setErr(E);
    rpc("generate_my_token", { p_pin: pin }, { user: true }).then(function (r) {
      $("#c-pin").value = "";
      if (r && r.error === "PIN_BAD") return setErr(E, "Code incorrect. " + (r.remaining > 1 ? "Encore " + r.remaining + " essais." : "Dernier essai avant blocage de 15 minutes."));
      if (r && r.error === "PIN_LOCKED") { if (state) state.pin_locked_until = r.until; return setErr(E, lockedText(r.until)); }
      qrNow = r.qr;
      if (r.qr && r.qr.server_time) qrOffset = Number(r.qr.server_time) - Date.now();   // horloge du serveur
      show($("#c-pinform"), false);
      render(r.state);
    }, function (err) {
      if (err.code === "NOT_AUTH") return signOut();
      if (["WEEK_LIMIT", "BLOCKED", "PHOTO_REQUIRED", "CONSENT_REQUIRED", "PIN_REQUIRED"].indexOf(err.code) >= 0) {
        show($("#c-pinform"), false); return loadState(false);
      }
      setErr(E, S.errMsg(err));
    }).then(function () { b.disabled = false; b.textContent = "Valider"; });
  };
  $("#c-hide").onclick = function () { qrNow = null; if (S.demo) store.del("sesame.qr"); if (state) render(state); };

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (qrNow && hiddenAt && Date.now() - hiddenAt > 120000) qrNow = null;
    if (state && auth.signedIn) loadState(false);
  });

  /* ----- mes données : suppression du compte ----- */
  $("#d-ask").onclick = function () { show($("#d-confirm"), true); show($("#d-ask"), false); };
  $("#d-no").onclick = function () { show($("#d-confirm"), false); show($("#d-ask"), true); };
  $("#d-yes").onclick = function () {
    var b = $("#d-yes"); b.disabled = true;
    rpc("delete_my_account", {}, { user: true }).then(function () {
      show($("#d-confirm"), false); show($("#d-ask"), true); $("#mydata").open = false;
      signOut();
      setErr($("#e-err"));
      $("#e-hint").textContent = "Votre compte a été supprimé.";
    }, function (err) { setErr($("#d-err"), S.errMsg(err)); }).then(function () { b.disabled = false; });
  };

  /* ----- installation sur l'écran d'accueil ----- */
  var deferredPrompt = null;
  var standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferredPrompt = e;
    show($("#install-btn"), true);
    $("#install-txt").textContent = " Elle s'ouvrira comme une appli, en un geste.";
  });
  function showInstallTip() {
    if (standalone || store.get("sesame.install.dismissed")) return;
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    $("#install-txt").textContent = deferredPrompt ? " Elle s'ouvrira comme une appli, en un geste."
      : ios ? " Dans Safari : bouton Partager, puis « Sur l'écran d'accueil »."
      : " Dans le menu du navigateur : « Ajouter à l'écran d'accueil » ou « Installer l'application ».";
    show($("#install"), true);
  }
  $("#install-btn").onclick = function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () { deferredPrompt = null; show($("#install"), false); });
  };
  $("#install-x").onclick = function () { store.set("sesame.install.dismissed", "1"); show($("#install"), false); };

  /* =================================================================
     AGENT
     ================================================================= */
  var pin = sess.get("sesame.pin"), histTimer = null;

  /* ----- son ----- */
  var actx = null, soundOn = store.get("sesame.sound") !== "off";
  function audioUnlock() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
    } catch (e) { actx = null; }
  }
  function tone(freq, start, dur, type, vol) {
    var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + start;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function beep(kind) {
    if (!soundOn || !actx) return;
    try {
      if (kind === "ok") { tone(880, 0, 0.12, "sine", 0.35); tone(1320, 0.12, 0.2, "sine", 0.35); }
      else if (kind === "warn") { tone(520, 0, 0.25, "triangle", 0.35); }
      else { tone(220, 0, 0.18, "square", 0.18); tone(220, 0.24, 0.24, "square", 0.18); }
    } catch (e) {}
  }
  function renderSound() {
    $("#snd").textContent = soundOn ? "Son activé" : "Son coupé";
    $("#snd").setAttribute("aria-pressed", soundOn);
  }
  $("#snd").onclick = function () { soundOn = !soundOn; store.set("sesame.sound", soundOn ? "on" : "off"); renderSound(); audioUnlock(); };
  renderSound();

  /* ----- verrouillage ----- */
  function unlock() {
    show($("#ag-lock"), false); show($("#ag-main"), true);
    loadHistory();
    clearInterval(histTimer);
    histTimer = setInterval(function () { if (!document.hidden && !$("#v-agent").hidden) loadHistory(); }, 30000);
  }
  function relock(message) {
    clearInterval(histTimer); histTimer = null;
    stopCamera(); pin = null; sess.del("sesame.pin");
    show($("#ag-main"), false); show($("#ag-lock"), true);
    setErr($("#pin-err"), message || "");
  }
  function pinError(code) {
    return code === "locked" ? S.MESSAGES.locked : "Code PIN incorrect.";
  }
  if (pin) unlock();

  $("#f-pin").onsubmit = function (e) {
    e.preventDefault();
    audioUnlock();
    var v = $("#pin").value.trim(), btn = $("#pin-submit");
    if (!v) return setErr($("#pin-err"), "Entrez le code PIN.");
    btn.disabled = true;
    rpc("verify_pin", { p_pin: v }).then(function (r) {
      if (r && r.ok) { pin = v; sess.set("sesame.pin", v); setErr($("#pin-err")); $("#pin").value = ""; unlock(); }
      else { setErr($("#pin-err"), pinError(r && r.error)); $("#pin").value = ""; }
    }, function (err) { setErr($("#pin-err"), S.errMsg(err)); }).then(function () { btn.disabled = false; });
  };
  $("#ag-lockbtn").onclick = function () { relock(); };

  /* ----- caméra en direct ----- */
  var video = $("#video"), stream = null, scanning = false, lastTick = 0, checking = false;
  var lastCode = "", lastCodeAt = 0, torchOn = false;

  function startCamera() {
    audioUnlock();
    var m = $("#cam-msg");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      m.textContent = "Ce navigateur ne donne pas accès à la caméra. Utilisez « Prendre le QR en photo » ou le code.";
      return;
    }
    $("#cam-start").disabled = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(function (s) { stream = s; video.srcObject = s; return video.play(); })
      .then(function () {
        show($("#cam-idle"), false);
        var track = stream.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : {};
        show($("#torch"), !!caps.torch);
        scanning = true; requestAnimationFrame(tick);
      })
      .catch(function (err) {
        stopCamera();
        m.textContent = (err && err.name === "NotAllowedError")
          ? "L'accès à la caméra a été refusé. Autorisez-le dans les réglages du navigateur, ou utilisez le code."
          : "La caméra n'a pas pu démarrer. Utilisez « Prendre le QR en photo » ou le code.";
      })
      .then(function () { $("#cam-start").disabled = false; });
  }
  function stopCamera() {
    scanning = false; torchOn = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    video.srcObject = null;
    show($("#cam-idle"), true); show($("#torch"), false);
    $("#torch").setAttribute("aria-pressed", "false");
  }
  $("#torch").onclick = function () {
    var track = stream && stream.getVideoTracks()[0]; if (!track) return;
    torchOn = !torchOn;
    track.applyConstraints({ advanced: [{ torch: torchOn }] }).then(function () {
      $("#torch").setAttribute("aria-pressed", String(torchOn));
    }, function () { torchOn = false; show($("#torch"), false); });
  };
  function tick(now) {
    if (!scanning) return;
    if (now - lastTick > 150 && video.readyState >= 2 && !checking) {
      lastTick = now;
      var text = readQR(video, video.videoWidth, video.videoHeight, 640);
      // Le même QR encore devant la caméra juste après un verdict est ignoré.
      if (text && !(text === lastCode && Date.now() - lastCodeAt < 8000)) { handleScan(text); return; }
    }
    requestAnimationFrame(tick);
  }
  $("#cam-start").onclick = startCamera;
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopCamera(); });

  $("#snap").onchange = function (e) {
    audioUnlock();
    var f = e.target.files[0]; e.target.value = ""; if (!f) return;
    show($("#ag-busy"), true);
    loadImg(f).then(function (img) {
      var text = readQR(img, img.naturalWidth, img.naturalHeight, 1280);
      show($("#ag-busy"), false);
      if (!text) return verdict("none", "QR illisible", "Reprenez la photo en cadrant le QR bien à plat, ou tapez le code.");
      handleScan(text);
    }, function () { show($("#ag-busy"), false); verdict("none", "Photo illisible", "Réessayez avec une autre photo."); });
  };

  $("#man").addEventListener("input", function (e) { e.target.value = e.target.value.toUpperCase(); });
  $("#f-man").onsubmit = function (e) {
    e.preventDefault(); audioUnlock();
    var v = $("#man").value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (v.length !== 12) return verdict("none", "Code invalide", "Le code compte 12 caractères, par exemple K7QF-2MXP-0427.");
    $("#man").value = "";
    check(v);
  };

  function handleScan(text) {
    scanning = false;
    lastCode = text; lastCodeAt = Date.now();
    if (text.indexOf(PREFIX) !== 0) return verdict("bad", "QR non reconnu", "Ce QR code n'a pas été créé avec Sésame.");
    check(text.slice(PREFIX.length));
  }

  function check(code) {
    checking = true; show($("#ag-busy"), true);
    rpc("check_token", { p_code: code, p_pin: pin })
      .then(function (r) {
        if (r && r.error) return relock(r.error === "locked" ? S.MESSAGES.locked : "Le code PIN a changé. Entrez le nouveau code.");
        var s = r.student;
        if (r.verdict === "ok") verdict("ok", "Autorisé", "Vérifiez que la photo correspond à la personne.", s, r.week);
        else if (r.verdict === "used") verdict("bad", "Déjà utilisé", "Validé " + dayFr(r.used_at) + " à " + hm(r.used_at) + ". Ce QR ne donne plus accès.", s, r.week);
        else if (r.verdict === "expired") verdict("warn", "Expiré", "Ce QR n'était valable que le " + dayFr(r.created_at) + ".", s, r.week);
        else if (r.verdict === "blocked") verdict("bad", "Compte bloqué", "Ce compte a été bloqué par l'équipe sécurité. Ne pas laisser entrer avec ce QR.", s, r.week);
        else if (r.verdict === "stale") verdict("warn", "Capture refusée", "Ce QR a plus de 20 secondes : c'est sans doute une capture d'écran. Demandez à l'étudiant·e d'ouvrir Sésame et de montrer le QR en direct.", s, r.week);
        else verdict("bad", "QR inconnu", "Aucun pass ne correspond à ce code.");
        loadHistory();
      }, function (err) { verdict("none", "Vérification impossible", S.errMsg(err)); })
      .then(function () { checking = false; show($("#ag-busy"), false); });
  }

  /* ----- verdict ----- */
  var autoTimer = null;
  function chip(text, kind) {
    var c = document.createElement("span");
    c.className = "chip" + (kind ? " " + kind : "");
    c.textContent = text;
    return c;
  }
  function shortDay(t) { return new Date(t).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }); }

  function renderWeek(w) {
    var box = $("#v-week");
    if (!w) { show(box, false); return; }
    var stats = $("#v-week-stats"); stats.textContent = "";
    var n = (w.passages || []).length;
    stats.appendChild(chip(plural(n, "passage validé", "passages validés"), "ok"));
    stats.appendChild(chip(w.generated + " / " + w.limit + " QR générés",
      w.generated >= w.limit ? "bad" : (w.limit - w.generated === 1 ? "warn" : "")));
    if (w.refused > 0) stats.appendChild(chip(plural(w.refused, "scan refusé", "scans refusés"), "bad"));
    var ul = $("#v-week-list"); ul.textContent = "";
    (w.passages || []).forEach(function (t) {
      var li = document.createElement("li"), a = document.createElement("span"), b = document.createElement("span");
      a.textContent = shortDay(t); b.textContent = hm(t);
      li.appendChild(a); li.appendChild(b); ul.appendChild(li);
    });
    show(box, true);
  }

  function verdict(kind, title, sub, s, week) {
    scanning = false;
    clearTimeout(autoTimer);
    renderWeek(s ? week : null);
    $("#v-band").className = "band " + kind;
    $("#v-title").textContent = title;
    $("#v-sub").textContent = sub;
    show($("#v-badge"), !!s);
    if (s) {
      $("#v-photo").src = s.photo || "";
      $("#v-photo").alt = "Photo de " + s.prenom + " " + s.nom;
      $("#v-name").textContent = s.prenom + " " + s.nom;
      $("#v-b00").textContent = s.b00;
    }
    show($("#ag-scanner"), false);
    show($("#ag-result"), true);
    beep(kind);
    if (navigator.vibrate) navigator.vibrate(kind === "ok" ? 80 : [120, 80, 120]);
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Autorisé : retour automatique au scanner après 4 s (sauf si l'agent a déjà appuyé).
    var count = $("#v-count");
    count.className = "countdown";
    if (kind === "ok") {
      void count.offsetWidth;            // relance l'animation
      count.className = "countdown run";
      autoTimer = setTimeout(nextScan, 4000);
    }
  }
  function nextScan() {
    clearTimeout(autoTimer);
    $("#v-count").className = "countdown";
    show($("#ag-result"), false);
    show($("#ag-scanner"), true);
    if (stream) { scanning = true; requestAnimationFrame(tick); }
  }
  $("#v-next").onclick = nextScan;

  // Utilisé par la démo pour « scanner » le QR affiché côté étudiant.
  window.SesameApp = { scan: function (text) { audioUnlock(); if (!checking) handleScan(text); } };

  /* ----- passages du jour ----- */
  function loadHistory() {
    if (!pin) return;
    rpc("agent_history", { p_pin: pin }).then(function (h) {
      if (h && h.error) return relock(h.error === "locked" ? S.MESSAGES.locked : "Le code PIN a changé. Entrez le nouveau code.");
      setErr($("#h-err"));
      var sum = $("#h-sum"); sum.textContent = "";
      sum.appendChild(chip(plural(h.ok, "autorisé", "autorisés"), "ok"));
      sum.appendChild(chip(plural(h.refused, "refusé", "refusés"), h.refused ? "bad" : ""));
      var ol = $("#h-list"); ol.textContent = "";
      (h.items || []).forEach(function (it) {
        var li = document.createElement("li");
        var t = document.createElement("span"); t.className = "t"; t.textContent = hm(it.scanned_at);
        var p = document.createElement("div"); p.className = "p";
        var name = document.createElement("b");
        name.textContent = it.prenom ? it.prenom + " " + it.nom : (it.b00 ? "Compte supprimé" : "Code inconnu");
        var sub = document.createElement("span");
        sub.textContent = it.b00 || (it.token_id ? S.fmtCode(it.token_id) : "");
        p.appendChild(name); p.appendChild(sub);
        var v = S.VERDICTS[it.verdict] || [it.verdict, ""];
        li.appendChild(t); li.appendChild(p); li.appendChild(chip(v[0], v[1]));
        ol.appendChild(li);
      });
      show($("#h-empty"), !(h.items || []).length);
    }, function (err) { if (err.code !== "NETWORK") setErr($("#h-err"), S.errMsg(err)); });
  }
  $("#h-refresh").onclick = loadHistory;

  /* =================================================================
     DÉMARRAGE
     ================================================================= */
  show($("#cfgwarn"), !S.configured);
  setView(location.hash === "#agent" ? "agent" : location.hash === "#etudiant" ? "etu" : (store.get("sesame.view") || "etu"));

  if (auth.signedIn) {
    // Affichage immédiat de la carte (sans QR), puis mise à jour.
    var cached = store.getJSON("sesame.state");
    if (cached && cached.registered && !cached.needs_consent && !cached.needs_photo && !cached.needs_pin) openCard(cached);
    loadState(false);
  } else if (pendingEmail) {
    openCodeScreen();
  } else {
    screen("#s-email");
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
