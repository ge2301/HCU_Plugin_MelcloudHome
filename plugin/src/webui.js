"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * Embedded WebUI (same pattern as the rollladensteuerung reference plugin):
 * the plugin serves its own configuration page; the HCU only shows a link
 * (CONFIG_TEMPLATE info property) pointing to it. The HCU maps exposed
 * container ports 1:1 to the LAN.
 *
 * Routes:
 *   GET  /            -> redirect to /config
 *   GET  /config      -> configuration UI (HTML)
 *   GET  /logo.png    -> MELCloud Home logo (plugin/assets/logo.png)
 *   GET  /api/config  -> current config (password never leaves the plugin)
 *   POST /api/config  -> save + connect   { melEmail, melPassword?, pollIntervalSeconds,
 *                                            minRequestGapSeconds, expose:{unitId:bool} }
 *   POST /api/poll    -> "connection test" (poll without saving)
 *   POST /api/control -> control one unit     { unitId, power?, operationMode?, setTemperature? }
 *   GET  /api/status  -> live status for auto refresh
 *
 * Callbacks from index.js:
 *   getState()          -> { configured, readiness, status, lastError, lastPollOkAt,
 *                            config:{melEmail,hasPassword,pollIntervalSeconds,
 *                            minRequestGapSeconds,exposeUnits}, units, devices }
 *   onSave(body)        -> Promise<{ status, message }>
 *   onPoll()            -> Promise<{ status, message }>
 */

function esc(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const PAGE = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MELCloud Home – Konfiguration</title>
<style>
	body { font-family: Arial, sans-serif; margin: 0; background: linear-gradient(135deg,#12598C 0%,#002A49 40%,#002A49 60%,#00ACC8 100%); min-height: 100vh; }
	.wrap { max-width: 760px; margin: 24px auto; padding: 0 12px; }
	.card { background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
	h1 { color: #12598C; font-size: 20px; margin: 0 0 2px; }
	.logo { height: 34px; width: auto; display: block; margin: 0 0 2px; }
	.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 14px; }
	.head .logo { margin: 0; }
	.head .sub { margin: 0; }
	.sub { color: #12598C; font-size: 12px; margin-bottom: 14px; }
	h2 { color: #12598C; font-size: 15px; border-bottom: 2px solid #e3e8ee; padding-bottom: 6px; margin: 18px 0 10px; }
	h2:first-of-type { margin-top: 4px; }
	.field { margin: 10px 0; }
	.field label { display: block; font-size: 13px; font-weight: bold; margin-bottom: 3px; }
	.field input[type=text], .field input[type=password], .field input[type=number] {
		width: 100%; max-width: 380px; padding: 8px 10px; border: 1px solid #c4cdd6; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
	.desc { font-size: 11.5px; color: #67788a; margin-top: 3px; }
	.row { display: flex; gap: 16px; flex-wrap: wrap; }
	.row .field { flex: 1 1 160px; }
	.chk { display: flex; align-items: center; gap: 8px; font-size: 14px; margin: 6px 0; }
	.chk .mut { color: #67788a; font-size: 12px; }
	.status { display: flex; gap: 10px; align-items: center; font-size: 13.5px; }
	button.iconbtn { width: 24px; height: 24px; min-width: 24px; padding: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
	button.iconbtn svg { width: 16px; height: 16px; display: block; }
	button.iconbtn:disabled svg { opacity: .6; }
	button.iconbtn.spin svg { animation: spin .8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.dot { width: 12px; height: 12px; border-radius: 50%; background: #aab; flex: none; }
	.dot.ok { background: #2ecc71; } .dot.cfg { background: #f1c40f; } .dot.err { background: #e74c3c; }
	.banner { border-radius: 8px; padding: 10px 14px; font-size: 13.5px; margin: 0 0 14px; display: none; }
	.banner.ok { display: block; background: #e2f4e6; border: 1px solid #9fd4a8; }
	.banner.err { display: block; background: #fde8e6; border: 1px solid #e8a49d; }
	.btns { margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap; }
	button { background: #12598C; color: #fff; border: 0; border-radius: 6px; padding: 10px 22px; font-size: 14px; cursor: pointer; }
	button.sec { background: #5a7184; }
	button:disabled { opacity: .6; }
	table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
	th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e3e8ee; vertical-align: top; }
	code { font-size: 11px; word-break: break-all; color: #33475b; }
	.badge { background: #12598C; color: #fff; border-radius: 4px; padding: 2px 7px; font-size: 11px; white-space: nowrap; }
	.mut { color: #8a99a8; }
	.unit { border-bottom: 1px solid #e3e8ee; padding: 8px 0; }
	.unit:last-child { border-bottom: 0; }
	.subrow { margin: 2px 0 4px 22px; display: flex; flex-wrap: wrap; gap: 2px 16px; }
	.subrow.off { opacity: .45; }
	.subchk { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: #33475b; }
	.ac { border: 1px solid #dbe2ea; border-radius: 12px; padding: 14px 16px; margin: 10px 0; background: #f8fafc; }
	.ac.off { opacity: .65; }
	.ac-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
	.ac-name { font-weight: bold; color: #12598C; font-size: 15px; }
	.ac-sub { font-size: 12px; color: #67788a; margin-top: 2px; }
	.ac-set { display: flex; align-items: center; justify-content: center; gap: 18px; margin: 12px 0 8px; }
	.tval { font-size: 34px; font-weight: bold; color: #12598C; min-width: 96px; text-align: center; }
	.tval .tc { font-size: 15px; color: #67788a; margin-left: 4px; }
	button.tstep { width: 44px; height: 44px; border-radius: 50%; background: #12598C; color: #fff; font-size: 22px; padding: 0; line-height: 1; }
	.modes { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
	.ac .modes { justify-content: center; }
	.ac .desc { text-align: center; margin-top: 10px; }
	button.mode { background: #e3e8ee; color: #33475b; border: 1px solid #c4cdd6; border-radius: 16px; padding: 6px 14px; font-size: 12.5px; }
	button.mode.on { background: #12598C; color: #fff; border-color: #12598C; }
	.switch { position: relative; display: inline-block; width: 52px; height: 28px; flex: none; }
	.switch input { opacity: 0; width: 0; height: 0; }
	.sl { position: absolute; inset: 0; background: #aab; border-radius: 28px; transition: .2s; cursor: pointer; }
	.sl:before { content: ""; position: absolute; width: 22px; height: 22px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
	.switch input:checked + .sl { background: #2ecc71; }
	.switch input:checked + .sl:before { transform: translateX(24px); }
	summary { cursor: pointer; color: #12598C; font-size: 15px; font-weight: bold; }
	@media (max-width: 600px) {
		/* Abstand der Inhalte zum linken/rechten Rand der drei Container
		   (cards) auf kleinen Screens halbiert: 24 -> 12 px. */
		.card { padding-left: 12px; padding-right: 12px; }
		.ac { padding-left: 8px; padding-right: 8px; }
	}
</style>
</head>
<body>
<div class="wrap">
	<div class="card">
		<div class="head"><img class="logo" src="/logo.png" alt="MELCloud Home"><div class="sub">HCU-Plugin · Konfiguration</div></div>
		<div id="banner" class="banner"></div>
		<div class="card" style="box-shadow:none;border:1px solid #e3e8ee;margin:0 0 6px;padding:12px 14px;">
			<div class="status"><span id="dot" class="dot"></span><span id="statusLine">Lade Status…</span><button type="button" class="iconbtn" id="refreshBtn" title="Zustand sofort neu bei MELCloud abfragen" aria-label="Status aktualisieren"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="#FFFFFF"><path d="M240-478q0 45 17 87.5t53 78.5l10 10v-58q0-17 11.5-28.5T360-400q17 0 28.5 11.5T400-360v160q0 17-11.5 28.5T360-160H200q-17 0-28.5-11.5T160-200q0-17 11.5-28.5T200-240h70l-16-14q-52-46-73-105t-21-119q0-94 48-170.5T337-766q14-8 29.5-1t20.5 23q5 15-.5 30T367-691q-58 32-92.5 88.5T240-478Zm480-4q0-45-17-87.5T650-648l-10-10v58q0 17-11.5 28.5T600-560q-17 0-28.5-11.5T560-600v-160q0-17 11.5-28.5T600-800h160q17 0 28.5 11.5T800-760q0 17-11.5 28.5T760-720h-70l16 14q49 49 71.5 106.5T800-482q0 94-48 170.5T623-194q-14 8-29.5 1T573-216q-5-15 .5-30t19.5-23q58-32 92.5-88.5T720-482Z"/></svg></button></div>
		</div>

		<form id="cfg">
		<h2>MELCloud-Zugang</h2>
		<div class="row">
			<div class="field"><label>E-Mail</label>
				<input type="text" id="melEmail" autocomplete="username">
				<div class="desc">Anmeldemail des MELCloud-<b>Home</b>-Kontos (melcloudhome.com).</div>
			</div>
			<div class="field"><label>Passwort</label>
				<input type="password" id="melPassword" autocomplete="new-password">
				<div class="desc" id="passDesc">Wird nie angezeigt — leer lassen, um das gespeicherte Passwort zu behalten.</div>
			</div>
		</div>
		<div class="btns">
			<button type="button" class="sec" id="pollBtn">Verbindung testen</button>
		</div>

		<h2>Betrieb</h2>
		<div class="row">
			<div class="field"><label>Abfrageintervall (s)</label>
				<input type="number" id="pollIntervalSeconds" min="30" max="3600">
				<div class="desc">Wie oft der Zustand bei MELCloud abgefragt wird (min. 30 s).</div>
			</div>
			<div class="field"><label>Mindestabstand Anfragen (s)</label>
				<input type="number" id="minRequestGapSeconds" min="1" max="60">
				<div class="desc">Schutz vor Kontosperren — nicht zu klein wählen (Standard 2 s).</div>
			</div>
		</div>

		<h2>Klimasteuerung</h2>
		<div id="controls"><span class="mut">Noch keine Klimaanlage erkannt — zuerst Zugangsdaten speichern bzw. „Verbindung testen“.</span></div>
		</form>
	</div>

	<div class="card">
		<details>
			<summary>Geräte an die HCU übertragen</summary>
			<div class="desc" style="margin:6px 0;">Nur gehäkelte Geräte erscheinen in der Homematic-Welt (HCU-App, CCU-Programme). Die Steuerung über diese Seite funktioniert unabhängig davon immer voll — inklusive Entfeuchten und Lüfter. Änderungen hier mit „Speichern &amp; Verbinden“ übernehmen.
			</div>
			<div id="exposeBox"></div>
		</details>
		<div class="btns">
			<button type="submit" form="cfg" id="saveBtn">Speichern &amp; Verbinden</button>
		</div>
	</div>

	<div class="card">
		<h2 style="margin-top:0">Von der HCU übernommene Geräte</h2>
		<table><thead><tr><th>Typ</th><th>Name</th><th>Werte</th></tr></thead>
		<tbody id="devTable"><tr><td colspan="3" class="mut">—</td></tr></tbody></table>
	</div>
</div>
<script>
	const $ = (id) => document.getElementById(id);
	function banner(cls, text) { const b = $("banner"); b.className = "banner " + cls; b.textContent = text; }
	function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
	const expose = {}; // unitId -> bool (master switch for HCU transfer)
	const exposeDev = {}; // deviceId -> bool (per device for HCU transfer)
	const unitState = {}; // unitId -> last known unit payload (also optimistic)
	const MODE_LABELS = { Automatic: "Auto", Heat: "Heizen", Cool: "Kühlen", Dry: "Entfeuchten", Fan: "Lüfter" };
	function devIds(unitId) { return { climate: "mc-" + unitId, power: "mc-" + unitId + "-power" }; }
	function tempLimits(caps) {
		caps = caps || {};
		const mins = ["minTempHeat", "minTempCoolDry", "minTempAutomatic"].map((k) => Number(caps[k])).filter(Number.isFinite);
		const maxs = ["maxTempHeat", "maxTempCoolDry", "maxTempAutomatic"].map((k) => Number(caps[k])).filter(Number.isFinite);
		return { min: mins.length ? Math.min.apply(null, mins) : 10, max: maxs.length ? Math.max.apply(null, maxs) : 31, step: caps.hasHalfDegreeIncrements ? 0.5 : 1 };
	}
	function controlUnits(units) { return (units || []).filter((u) => u.state); }

	async function loadConfig() {
		const c = await (await fetch("/api/config")).json();
		$("melEmail").value = c.melEmail || "";
		$("pollIntervalSeconds").value = c.pollIntervalSeconds || 60;
		$("minRequestGapSeconds").value = c.minRequestGapSeconds || 2;
		if (!c.hasPassword) $("passDesc").textContent = "Noch kein Passwort gespeichert.";
		Object.assign(expose, c.exposeUnits || {});
		Object.assign(exposeDev, c.exposeDevices || {});
		renderExpose(controlUnits((await (await fetch("/api/status")).json()).units || []));
	}

	/* -------- control cards (one per air-conditioner) -------------------- */
	let renderedSig = "";
	function renderControls(units) {
		const box = $("controls");
		if (!units.length) { box.innerHTML = '<span class="mut">Noch keine Klimaanlage erkannt — zuerst Zugangsdaten speichern bzw. „Verbindung testen“.</span>'; return; }
		units.forEach((u) => { unitState[u.id] = u; });
		box.innerHTML = units.map((u) => {
			const st = u.state || {};
			const lim = tempLimits(u.capabilities);
			const modes = Object.keys(MODE_LABELS).map((m) => '<button type="button" class="mode' + (st.operationMode === m ? " on" : "") + '" data-mode="' + m + '" data-munit="' + esc(u.id) + '">' + MODE_LABELS[m] + "</button>").join("");
			return '<div class="ac' + (st.power ? "" : " off") + '" id="ac-' + esc(u.id) + '">' +
				'<div class="ac-top"><div><div class="ac-name">' + esc(u.name) + "</div>" +
				'<div class="ac-sub">' + (u.connected ? "verbunden" : "getrennt") + ' · Ist-Temperatur <b data-cur="' + esc(u.id) + '">' + (st.roomTemperature != null ? st.roomTemperature : "–") + "</b> °C</div></div>" +
				'<label class="switch" title="An/Aus"><input type="checkbox" data-pwr="' + esc(u.id) + '"' + (st.power ? " checked" : "") + "><span class='sl'></span></label></div>" +
				'<div class="ac-set">' +
				'<button type="button" class="tstep" data-tdec="' + esc(u.id) + '" title="kälter">−</button>' +
				'<div class="tval"><span data-setv="' + esc(u.id) + '">' + (st.setTemperature != null ? st.setTemperature : "–") + '</span><span class="tc">°C Soll</span></div>' +
				'<button type="button" class="tstep" data-tinc="' + esc(u.id) + '" title="wärmer">+</button></div>' +
				'<div class="modes">' + modes + "</div>" +
				'<div class="desc">Sollwert ' + lim.min + "–" + lim.max + " °C in " + lim.step + "-°C-Schritten · Änderungen werden sofort an MELCloud gesendet</div>" +
				"</div>";
		}).join("");
		box.querySelectorAll("input[data-pwr]").forEach((el) => {
			el.addEventListener("change", () => {
				const id = el.dataset.pwr;
				applyLocal(id, { power: el.checked });
				sendControl({ unitId: id, power: el.checked });
				el.blur();
			});
		});
		const stepTemp = (id, dir) => {
			const u = unitState[id];
			if (!u) return;
			const lim = tempLimits(u.capabilities);
			const el = document.querySelector('[data-setv="' + id + '"]');
			let v = parseFloat(el ? el.textContent : "");
			if (!Number.isFinite(v)) v = lim.min;
			v = Math.min(lim.max, Math.max(lim.min, Math.round((v + dir * lim.step) / lim.step) * lim.step));
			v = Number(v.toFixed(1));
			applyLocal(id, { setTemperature: v });
			queueTemp(id, v);
		};
		box.querySelectorAll("[data-tdec]").forEach((el) => el.addEventListener("click", () => stepTemp(el.dataset.tdec, -1)));
		box.querySelectorAll("[data-tinc]").forEach((el) => el.addEventListener("click", () => stepTemp(el.dataset.tinc, 1)));
		box.querySelectorAll("button[data-mode]").forEach((el) => {
			el.addEventListener("click", () => {
				const id = el.dataset.munit;
				const m = el.dataset.mode;
				const u = unitState[id];
				if (u && u.state && u.state.operationMode === m) return;
				applyLocal(id, { operationMode: m });
				sendControl({ unitId: id, operationMode: m });
			});
		});
	}
	/* Paint one unit from unitState (optimistic + live sync, no focus quirks). */
	function paintUnit(u) {
		const card = document.getElementById("ac-" + u.id);
		if (!card) return;
		const st = u.state || {};
		card.className = "ac" + (st.power ? "" : " off");
		const sw = card.querySelector("input[data-pwr]");
		if (sw && sw !== document.activeElement) sw.checked = Boolean(st.power);
		const cur = card.querySelector("[data-cur]");
		if (cur && st.roomTemperature != null) cur.textContent = st.roomTemperature;
		const sv = card.querySelector("[data-setv]");
		if (sv && st.setTemperature != null) sv.textContent = st.setTemperature;
		card.querySelectorAll("button[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === st.operationMode));
	}
	function applyLocal(id, patch) {
		const u = unitState[id];
		if (!u) return;
		u.state = u.state || {};
		Object.assign(u.state, patch);
		paintUnit(u);
	}
	/* Debounce rapid +/- taps into a single MELCloud command. */
	const tempTimers = {};
	function queueTemp(id, value) {
		clearTimeout(tempTimers[id]);
		tempTimers[id] = setTimeout(() => { delete tempTimers[id]; sendControl({ unitId: id, setTemperature: value }); }, 600);
	}

	/* -------- HCU transfer selection (collapsible, expert section) ------- */
	function renderExpose(units) {
		const box = $("exposeBox");
		if (!units.length) { box.innerHTML = ""; return; }
		box.innerHTML = units.map((u) => {
			const ids = devIds(u.id);
			const off = expose[u.id] === false;
			const subs = [[ids.climate, "Temperatur"], [ids.power, "An/Aus"]]
				.map((p) => '<label class="subchk"><input type="checkbox" data-dev="' + p[0] + '"' + (exposeDev[p[0]] !== false ? " checked" : "") + (off ? " disabled" : "") + "> " + p[1] + "</label>").join("");
			return '<div class="unit"><label class="chk"><input type="checkbox" data-unit="' + esc(u.id) + '"' + (expose[u.id] !== false ? " checked" : "") + "> <b>" + esc(u.name) + "</b> <span class='mut'>an die HCU übertragen</span></label>" +
				'<div class="subrow' + (off ? " off" : "") + '">' + subs + "</div></div>";
		}).join("");
		box.querySelectorAll("input[data-unit]").forEach((el) => {
			expose[el.dataset.unit] = el.checked;
			el.addEventListener("change", () => {
				expose[el.dataset.unit] = el.checked;
				// Master AUS => Unter-Checkboxen ausgegraut (wirkungslos, bleiben aber gesetzt)
				const row = el.closest(".unit").querySelector(".subrow");
				row.classList.toggle("off", !el.checked);
				row.querySelectorAll("input[data-dev]").forEach((s) => { s.disabled = !el.checked; });
			});
		});
		box.querySelectorAll("input[data-dev]").forEach((el) => { exposeDev[el.dataset.dev] = el.checked; el.addEventListener("change", () => { exposeDev[el.dataset.dev] = el.checked; }); });
	}

	async function sendControl(body) {
		try {
			const r = await (await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
			banner(r.status === "APPLIED" ? "ok" : "err", r.message);
			setTimeout(refreshStatus, 3000); // cloud confirmation poll runs after ~4 s
		} catch (e) { banner("err", "Fehler: " + e.message); }
	}

	async function refreshStatus() {
		try {
			const s = await (await fetch("/api/status")).json();
			$("statusLine").textContent = s.status + (s.lastError ? "" : "");
			$("dot").className = "dot " + (s.readiness === "READY" ? "ok" : s.readiness === "CONFIG_REQUIRED" ? "cfg" : s.readiness === "ERROR" ? "err" : "");
			const rows = (s.devices || []).map((d) =>
				"<tr><td><span class='badge'>" + esc(d.deviceType) + "</span></td><td>" + esc(d.friendlyName) +
				"</td><td><code>" + esc(JSON.stringify(d.features)) + "</code></td></tr>");
			$("devTable").innerHTML = rows.join("") || "<tr><td colspan='3' class='mut'>—</td></tr>";
			const units = controlUnits(s.units);
			const sig = units.map((u) => u.id).sort().join(",");
			if (sig !== renderedSig) {
				renderedSig = sig;
				renderControls(units);
				renderExpose(units);
			} else {
				units.forEach((u) => { unitState[u.id] = u; paintUnit(u); }); // live sync of all values
			}
		} catch (e) { /* keep last state */ }
	}

	$("cfg").addEventListener("submit", async (ev) => {
		ev.preventDefault();
		const body = {
			melEmail: $("melEmail").value.trim(),
			melPassword: $("melPassword").value,
			pollIntervalSeconds: Number($("pollIntervalSeconds").value) || 60,
			minRequestGapSeconds: Number($("minRequestGapSeconds").value) || 2,
			expose,
			exposeDevices: exposeDev,
		};
		await send(body, "/api/config", $("saveBtn"), "Verbinde…");
	});
	$("pollBtn").addEventListener("click", async () => {
		const body = { melEmail: $("melEmail").value.trim(), melPassword: $("melPassword").value };
		await send(body, "/api/poll", $("pollBtn"), "Prüfe…");
	});
	$("refreshBtn").addEventListener("click", async () => {
		const b = $("refreshBtn");
		b.disabled = true; b.classList.add("spin");
		try {
			const r = await (await fetch("/api/poll", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
			banner(r.status === "APPLIED" ? "ok" : "err", r.status === "APPLIED" ? "Zustand von MELCloud aktualisiert." : r.message);
			await refreshStatus();
		} catch (e) { banner("err", "Fehler: " + e.message); }
		b.disabled = false; b.classList.remove("spin");
	});
	async function send(body, url, btn, busyText) {
		const old = btn.textContent; btn.disabled = true; btn.textContent = busyText;
		try {
			const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
			banner(r.status === "APPLIED" ? "ok" : "err", r.message);
			$("melPassword").value = "";
			await loadConfig(); refreshStatus();
		} catch (e) { banner("err", "Fehler: " + e.message); }
		btn.disabled = false; btn.textContent = old;
	}

	loadConfig(); refreshStatus();
	setInterval(refreshStatus, 5000);
</script>
</body>
</html>`;

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => {
			chunks.push(c);
			if (Buffer.concat(chunks).length > 1_000_000) reject(new Error("body too large"));
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

function startWebUI({ port, getState, onSave, onPoll, onControl }) {
	const server = http.createServer(async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		try {
			if (req.method === "GET" && (req.url === "/" || req.url === "/config")) {
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
				res.writeHead(200);
				res.end(PAGE);
				return;
			}
			if (req.method === "GET" && req.url === "/logo.png") {
				const file = path.join(__dirname, "..", "assets", "logo.png");
				if (!fs.existsSync(file)) {
					res.writeHead(404);
					res.end("logo missing");
					return;
				}
				res.setHeader("Content-Type", "image/png");
				// No caching: swapping plugin/assets/logo.png takes effect on the
				// next browser reload, without restarting the plugin.
				res.setHeader("Cache-Control", "no-store");
				res.writeHead(200);
				fs.createReadStream(file).pipe(res);
				return;
			}
			if (req.method === "GET" && req.url === "/api/config") {
				const st = getState();
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200);
				res.end(
					JSON.stringify({
						melEmail: st.config.melEmail || "",
						hasPassword: Boolean(st.config.hasPassword),
						pollIntervalSeconds: st.config.pollIntervalSeconds,
						minRequestGapSeconds: st.config.minRequestGapSeconds,
						exposeUnits: st.config.exposeUnits || {},
						exposeDevices: st.config.exposeDevices || {},
					})
				);
				return;
			}
			if (req.method === "GET" && req.url === "/api/status") {
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200);
				res.end(JSON.stringify(getState()));
				return;
			}
			if (req.method === "POST" && (req.url === "/api/config" || req.url === "/api/poll")) {
				const body = await readJsonBody(req);
				const result =
					req.url === "/api/poll" ? await onPoll(body) : await onSave(body);
				logger.info(`WebUI ${req.url} -> ${result.status}: ${result.message}`);
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200);
				res.end(JSON.stringify(result));
				return;
			}
			if (req.method === "POST" && req.url === "/api/control") {
				const body = await readJsonBody(req);
				const r = await onControl(body);
				const out = { status: r.success ? "APPLIED" : "FAILED", message: r.message || "" };
				logger.info(`WebUI /api/control ${JSON.stringify(body)} -> ${out.status}: ${out.message}`);
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200);
				res.end(JSON.stringify(out));
				return;
			}
			res.writeHead(404);
			res.end("not found");
		} catch (err) {
			logger.error(`WebUI error: ${err.message}`);
			res.setHeader("Content-Type", "application/json");
			res.writeHead(500);
			res.end(JSON.stringify({ status: "FAILED", message: err.message }));
		}
	});

	server.on("error", (err) => logger.error(`WebUI server error: ${err.message}`));
	server.listen(port, "0.0.0.0", () =>
		logger.info(`WebUI available on http://0.0.0.0:${port}/config`)
	);
	return server;
}

module.exports = { startWebUI, esc };
