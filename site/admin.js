/* Sésame — espace sécurité (admin) */
(function () {
  "use strict";

  var S = window.Sesame, $ = S.$, show = S.show, setErr = S.setErr, sess = S.sess, rpc = S.rpc, hm = S.hm;
  var pw = sess.get("sesame.admin");

  show($("#cfgwarn"), !S.configured);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function chip(text, kind) { return el("span", "chip" + (kind ? " " + kind : ""), text); }
  function verdictChip(v) { var x = S.VERDICTS[v] || [v, ""]; return chip(x[0], x[1]); }
  function dShort(t) { return new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }); }

  /* Toutes les fonctions admin renvoient {error:'bad'|'locked'} si le mot de passe ne va plus. */
  function call(fn, args) {
    args = args || {}; args.p_pw = pw;
    return rpc(fn, args).then(function (r) {
      if (r && (r.error === "bad" || r.error === "locked")) { logout(r.error === "locked" ? S.MESSAGES.locked : "Session expirée. Reconnectez-vous."); throw { code: "handled" }; }
      if (r && r.error) throw { code: r.error };
      return r;
    });
  }
  function fail(errEl) { return function (e) { if (e && e.code !== "handled") setErr(errEl, S.errMsg(e)); }; }

  /* ---------- connexion ---------- */
  $("#f-login").onsubmit = function (e) {
    e.preventDefault();
    var v = $("#a-pw").value, E = $("#a-err"), btn = $("#a-submit");
    if (!v) return setErr(E, "Entrez le mot de passe.");
    btn.disabled = true; setErr(E);
    rpc("admin_login", { p_pw: v }).then(function (r) {
      if (r && r.ok) { pw = v; sess.set("sesame.admin", v); $("#a-pw").value = ""; enter(r); }
      else setErr(E, r && r.error === "locked" ? S.MESSAGES.locked : "Mot de passe incorrect.");
    }, function (err) { setErr(E, S.errMsg(err)); }).then(function () { btn.disabled = false; });
  };
  function enter(r) {
    show($("#a-login"), false); show($("#a-main"), true); show($("#logout"), true);
    show($("#a-default"), !!(r && r.default_password));
    tab("overview");
  }
  function logout(msg) {
    pw = null; sess.del("sesame.admin");
    show($("#a-main"), false); show($("#a-login"), true); show($("#logout"), false);
    setErr($("#a-err"), typeof msg === "string" ? msg : "");
  }
  $("#logout").onclick = function () { logout(); };

  /* ---------- onglets ---------- */
  var tabs = ["overview", "history", "students", "settings"];
  function tab(name) {
    tabs.forEach(function (t) {
      show($("#t-" + t), t === name);
      $('[data-tab="' + t + '"]').setAttribute("aria-selected", t === name);
    });
    if (name === "overview") loadOverview();
    if (name === "history") loadHistory(true);
    if (name === "students") loadStudents();
    if (name === "settings") loadSettings();
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (b) { b.onclick = function () { tab(b.dataset.tab); }; });
  Array.prototype.forEach.call(document.querySelectorAll("[data-goto]"), function (b) { b.onclick = function () { tab(b.dataset.goto); }; });

  /* ---------- vue d'ensemble ---------- */
  var overview = null;
  function loadOverview() {
    call("admin_overview").then(function (o) {
      overview = o;
      show($("#a-default"), !!o.default_password);
      $("#k-today-ok").textContent = o.today_ok;
      $("#k-today-bad").textContent = o.today_refused;
      $("#k-week-ok").textContent = o.week_ok;
      $("#k-week-s").textContent = "passages autorisés · " + S.plural(o.week_generated, "QR généré", "QR générés");
      $("#k-students").textContent = o.students;
      $("#k-students-s").textContent = "étudiants · " + o.students_week + " cette semaine" + (o.blocked ? " · " + o.blocked + " bloqué" + (o.blocked > 1 ? "s" : "") : "");
      drawChart(o.days || []);
    }, fail($("#h-err")));
    call("admin_history", { p_search: "", p_from: null, p_to: null, p_limit: 8, p_offset: 0 }).then(function (h) {
      var tb = $("#o-last"); tb.textContent = "";
      if (!h.items.length) { var tr = el("tr"), td = el("td", "", "Aucun scan pour l'instant."); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); }
      h.items.forEach(function (it) { tb.appendChild(historyRow(it, false)); });
    }, function () {});
  }

  function drawChart(days) {
    var W = 720, H = 240, L = 34, R = 8, T = 12, B = 30;
    var max = 0; days.forEach(function (d) { max = Math.max(max, d.ok + d.refused); });
    var step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
    var top = Math.max(step, Math.ceil(max / step) * step);
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var n = days.length || 1, bw = (W - L - R) / n, gap = Math.min(10, bw * 0.3);
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("class", "chart");
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Passages autorisés et refusés sur les 14 derniers jours");
    function add(tag, attrs, text) {
      var e = document.createElementNS(ns, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      svg.appendChild(e); return e;
    }
    for (var v = 0; v <= top; v += step) {
      add("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" });
      add("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", class: "axis" }, v);
    }
    days.forEach(function (d, i) {
      var x = L + i * bw + gap / 2, w = bw - gap;
      if (d.ok) add("rect", { x: x, y: y(d.ok), width: w, height: y(0) - y(d.ok), rx: 2, class: "bar-ok" }).appendChild(document.createElementNS(ns, "title")).textContent = d.ok + " autorisés";
      if (d.refused) add("rect", { x: x, y: y(d.ok + d.refused), width: w, height: y(d.ok) - y(d.ok + d.refused), rx: 2, class: "bar-bad" }).appendChild(document.createElementNS(ns, "title")).textContent = d.refused + " refusés";
      var dt = new Date(d.day + "T12:00:00");
      add("text", { x: x + w / 2, y: H - 10, "text-anchor": "middle", class: "axis" + (i === n - 1 ? " today" : "") },
        i === n - 1 ? "Auj." : dt.getDate());
    });
    var box = $("#chart"); box.textContent = ""; box.appendChild(svg);
  }

  /* ---------- historique ---------- */
  var histOffset = 0, histTotal = 0, PAGE = 100;
  function historyRow(it, withCode) {
    var tr = el("tr");
    tr.appendChild(el("td", "", dShort(it.scanned_at)));
    tr.appendChild(el("td", "mono", hm(it.scanned_at)));
    tr.appendChild(el("td", "", it.prenom ? it.prenom + " " + it.nom : (it.b00 ? "Compte supprimé" : "Code inconnu")));
    tr.appendChild(el("td", "mono", it.b00 || "–"));
    if (withCode) tr.appendChild(el("td", "mono", it.token_id ? S.fmtCode(it.token_id) : "–"));
    var td = el("td"); td.appendChild(verdictChip(it.verdict)); tr.appendChild(td);
    return tr;
  }
  function histArgs(limit, offset) {
    return { p_search: $("#h-q").value.trim(), p_from: $("#h-from").value || null, p_to: $("#h-to").value || null, p_limit: limit, p_offset: offset };
  }
  function loadHistory(reset) {
    if (reset) { histOffset = 0; $("#h-rows").textContent = ""; }
    setErr($("#h-err"));
    call("admin_history", histArgs(PAGE, histOffset)).then(function (h) {
      histTotal = h.total;
      h.items.forEach(function (it) { $("#h-rows").appendChild(historyRow(it, true)); });
      histOffset += h.items.length;
      $("#h-count").textContent = S.plural(histTotal, "scan", "scans") + (histOffset < histTotal ? " · " + histOffset + " affichés" : "");
      show($("#h-more"), histOffset < histTotal);
      if (!histTotal) { var tr = el("tr"), td = el("td", "", "Aucun scan ne correspond."); td.colSpan = 6; tr.appendChild(td); $("#h-rows").appendChild(tr); }
    }, fail($("#h-err")));
  }
  $("#f-hist").onsubmit = function (e) { e.preventDefault(); loadHistory(true); };
  $("#h-more").onclick = function () { loadHistory(false); };

  $("#h-csv").onclick = function () {
    var b = $("#h-csv"); b.disabled = true; b.textContent = "Préparation…";
    call("admin_history", histArgs(10000, 0)).then(function (h) {
      var q = function (v) { v = v == null ? "" : String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var lines = ["Date;Heure;Prénom;Nom;B00;Code QR;Résultat"];
      h.items.forEach(function (it) {
        var d = new Date(it.scanned_at);
        lines.push([d.toLocaleDateString("fr-FR"), d.toLocaleTimeString("fr-FR"), it.prenom, it.nom, it.b00, it.token_id,
          (S.VERDICTS[it.verdict] || [it.verdict])[0]].map(q).join(";"));
      });
      var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sesame-historique-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }, fail($("#h-err"))).then(function () { b.disabled = false; b.textContent = "Exporter en CSV"; });
  };

  /* ---------- étudiants ---------- */
  var current = null;
  function loadStudents() {
    setErr($("#s-err"));
    call("admin_students", { p_search: $("#s-q").value.trim() }).then(function (r) {
      var tb = $("#s-rows"); tb.textContent = "";
      $("#s-count").textContent = S.plural(r.items.length, "étudiant", "étudiants") + (r.items.length >= 500 ? " (500 premiers)" : "");
      if (!r.items.length) { var tr0 = el("tr"), td0 = el("td", "", "Aucun étudiant ne correspond."); td0.colSpan = 6; tr0.appendChild(td0); tb.appendChild(tr0); }
      r.items.forEach(function (s) {
        var tr = el("tr", "click" + (current && current.b00 === s.b00 ? " sel" : ""));
        tr.tabIndex = 0;
        tr.appendChild(el("td", "", s.prenom + " " + s.nom));
        tr.appendChild(el("td", "mono", s.b00));
        var lim = r.week_limit;
        var q = el("td"); q.appendChild(chip(s.week_generated + " / " + lim, s.week_generated >= lim ? "bad" : (lim - s.week_generated === 1 ? "warn" : ""))); tr.appendChild(q);
        tr.appendChild(el("td", "mono", s.total_ok));
        tr.appendChild(el("td", "", s.last_ok ? dShort(s.last_ok) + " " + hm(s.last_ok) : "–"));
        var st = el("td");
        if (s.blocked) st.appendChild(chip("Bloqué", "bad"));
        else if (s.photo_reset) st.appendChild(chip("Photo demandée", "warn"));
        else if (!s.consent) st.appendChild(chip("Accord manquant", "warn"));
        else if (!s.has_pin) st.appendChild(chip("Code à créer", "warn"));
        else st.appendChild(chip("Actif", "ok"));
        tr.appendChild(st);
        var open = function () { openStudent(s.b00); };
        tr.onclick = open;
        tr.onkeydown = function (e) { if (e.key === "Enter") open(); };
        tb.appendChild(tr);
      });
    }, fail($("#s-err")));
  }
  $("#f-stu").onsubmit = function (e) { e.preventDefault(); loadStudents(); };

  function openStudent(b00) {
    setErr($("#sd-err")); show($("#sd-ok"), false); show($("#sd-confirm"), false);
    call("admin_student", { p_b00: b00 }).then(renderStudent, fail($("#s-err")));
  }
  function renderStudent(s) {
    current = s;
    show($("#sd"), true);
    $("#sd-name").textContent = s.prenom + " " + s.nom;
    $("#sd-photo").src = s.photo; $("#sd-photo").alt = "Photo de " + s.prenom + " " + s.nom;
    $("#sd-b00").textContent = s.b00;
    $("#sd-email").textContent = s.email;
    $("#sd-created").textContent = S.dateFr(s.created_at);
    $("#sd-consent").textContent = s.consent_at ? "Donné le " + S.dateFr(s.consent_at) : "Pas encore donné";
    $("#sd-pin").textContent = !s.has_pin ? "À créer à la prochaine connexion"
      : s.pin_locked_until ? "Bloqué jusqu'à " + hm(s.pin_locked_until) + " (trop d'erreurs)" : "Créé";
    $("#sd-pin-btn").disabled = !s.has_pin && !s.pin_locked_until;
    var c = $("#sd-chips"); c.textContent = "";
    c.appendChild(chip(s.week_generated + " / " + s.week_limit + " QR cette semaine", s.week_generated >= s.week_limit ? "bad" : ""));
    c.appendChild(chip(S.plural(s.total_ok, "passage autorisé", "passages autorisés"), "ok"));
    if (s.total_refused) c.appendChild(chip(S.plural(s.total_refused, "scan refusé", "scans refusés"), "bad"));
    if (s.blocked) c.appendChild(chip("Compte bloqué", "bad"));
    if (s.photo_reset) c.appendChild(chip("Nouvelle photo demandée", "warn"));
    $("#sd-block").textContent = s.blocked ? "Débloquer le compte" : "Bloquer le compte";
    $("#sd-block").className = s.blocked ? "btn small" : "btn small danger-solid";
    $("#sd-photo-btn").disabled = !!s.photo_reset;
    var ul = $("#sd-scans"); ul.textContent = "";
    if (!s.scans.length) ul.appendChild(el("li", "", "Aucun scan."));
    s.scans.forEach(function (x) {
      var li = el("li"); li.appendChild(el("span", "", dShort(x.scanned_at) + " · " + hm(x.scanned_at)));
      li.appendChild(verdictChip(x.verdict)); ul.appendChild(li);
    });
    $("#sd").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function act(action, okText) {
    if (!current) return;
    setErr($("#sd-err")); show($("#sd-ok"), false);
    call("admin_action", { p_b00: current.b00, p_action: action }).then(function (r) {
      if (r.deleted) { current = null; show($("#sd"), false); loadStudents(); return; }
      renderStudent(r);
      $("#sd-ok").textContent = okText; show($("#sd-ok"), true);
      loadStudents();
    }, fail($("#sd-err")));
  }
  $("#sd-block").onclick = function () { act(current.blocked ? "unblock" : "block", current.blocked ? "Compte débloqué." : "Compte bloqué : ses QR sont refusés au scan."); };
  $("#sd-reset").onclick = function () { act("reset_week", "Compteur remis à zéro pour cette semaine."); };
  $("#sd-photo-btn").onclick = function () { act("reset_photo", "Nouvelle photo demandée : l'étudiant devra la prendre avant son prochain QR."); };
  $("#sd-pin-btn").onclick = function () { act("reset_pin", "Code réinitialisé : l'étudiant en choisira un nouveau à sa prochaine connexion."); };
  $("#sd-del").onclick = function () { show($("#sd-confirm"), true); };
  $("#sd-del-no").onclick = function () { show($("#sd-confirm"), false); };
  $("#sd-del-yes").onclick = function () { act("delete", ""); };
  $("#sd-close").onclick = function () { current = null; show($("#sd"), false); };

  /* ---------- réglages ---------- */
  function loadSettings() {
    call("admin_overview").then(function (o) {
      $("#set-limit").value = o.settings.week_limit;
      $("#set-pin").value = o.settings.agent_pin;
      $("#set-domain").value = o.settings.email_domain;
    }, function () {});
  }
  function saveSetting(form, key, getValue, okText, after) {
    form.onsubmit = function (e) {
      e.preventDefault();
      var ok = form.querySelector(".ok-msg"), err = form.querySelector(".err");
      show(ok, false); setErr(err);
      var v = getValue(); if (v === null) return;
      call("admin_set", { p_key: key, p_value: v }).then(function (r) {
        ok.textContent = okText(r.value); show(ok, true);
        if (after) after(v);
      }, function (e2) {
        if (e2 && e2.code === "handled") return;
        setErr(err, e2 && e2.code === "bad_value" ? {
          week_limit: "Entrez un nombre entre 1 et 99.",
          agent_pin: "Le PIN doit compter 4 à 8 chiffres.",
          email_domain: "Entrez un domaine valide, par exemple essec.edu.",
          admin_password: "8 caractères minimum."
        }[key] : S.errMsg(e2));
      });
    };
  }
  saveSetting($("#f-limit"), "week_limit", function () { return $("#set-limit").value.trim(); },
    function (v) { return "Enregistré : " + v + " QR par semaine."; });
  saveSetting($("#f-pin"), "agent_pin", function () { return $("#set-pin").value.trim(); },
    function (v) { return "Nouveau PIN enregistré : " + v + "."; });
  saveSetting($("#f-domain"), "email_domain", function () { return $("#set-domain").value.trim(); },
    function (v) { return v ? "Seules les adresses @" + v + " peuvent s'inscrire." : "Toutes les adresses peuvent s'inscrire."; });
  saveSetting($("#f-pw"), "admin_password", function () {
    var a = $("#set-pw").value, b = $("#set-pw2").value, err = $("#f-pw .err");
    if (a.length < 8) { setErr(err, "8 caractères minimum."); return null; }
    if (a !== b) { setErr(err, "Les deux mots de passe ne sont pas identiques."); return null; }
    return a;
  }, function () { return "Mot de passe changé."; }, function (v) {
    pw = v; sess.set("sesame.admin", v);
    $("#set-pw").value = ""; $("#set-pw2").value = "";
    show($("#a-default"), false);
  });

  /* ---------- démarrage ---------- */
  if (pw && S.configured) {
    rpc("admin_login", { p_pw: pw }).then(function (r) { if (r && r.ok) enter(r); else logout(); }, function () { logout(); });
  }
})();
