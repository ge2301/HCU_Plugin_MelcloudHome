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
	.field input[type=text]:focus, .field input[type=password]:focus, .field input[type=number]:focus {
		outline: none; border-color: #d64541; box-shadow: 0 0 0 3px rgba(214, 69, 65, .35); }
	.desc { font-size: 11.5px; color: #67788a; margin-top: 3px; }
	.masked { color: #9aa8b5; }
	.row { display: flex; gap: 16px; flex-wrap: wrap; }
	.row .field { flex: 1 1 160px; }
	.chk { display: flex; align-items: center; gap: 8px; font-size: 14px; margin: 6px 0; }
	.chk .mut { color: #67788a; font-size: 12px; }
	input[type=checkbox] { accent-color: #12598C; width: 15px; height: 15px; }
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
	nav { display: flex; gap: 4px; margin: 0 0 16px; border-bottom: 2px solid #e3e8ee; }
	nav button { flex: 1 1 0; display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: transparent; color: #67788a; border: 0; border-bottom: 3px solid transparent; border-radius: 0; margin-bottom: -2px; padding: 9px 6px; font-size: 13.5px; font-weight: bold; }
	nav button svg { width: 18px; height: 18px; fill: currentColor; flex: none; }
	nav button[data-tab="settings"] svg, nav button[data-tab="control"] svg { width: 23.4px; height: 23.4px; }
	nav button[data-tab="guide"] svg { width: 22.5px; height: 22.5px; }
	nav button:hover { color: #12598C; }
	nav button.active { background: transparent; color: #12598C; border-bottom-color: #12598C; }
	.taboff { display: none; }
	.guide h3 { color: #12598C; font-size: 13.5px; margin: 18px 0 6px; }
	.guide p, .guide li { font-size: 13.5px; color: #33475b; margin: 5px 0; }
	.guide ol, .guide ul { margin: 4px 0 10px; padding-left: 22px; }
	.guide .note { background: #f2f7fb; border-left: 3px solid #12598C; border-radius: 0 6px 6px 0; padding: 8px 12px; margin: 10px 0; font-size: 13px; color: #33475b; }
	@media (max-width: 600px) {
		/* Abstand der Inhalte zum linken/rechten Rand der drei Container
		   (cards) auf kleinen Screens halbiert: 24 -> 12 px. */
		.card { padding-left: 12px; padding-right: 12px; }
		.ac { padding-left: 8px; padding-right: 8px; }
		/* Tabs zeigen auf kleinen Screens nur das Icon (Label im title-Attribut). */
		.tab-label { display: none; }
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

	</div>

	<div class="card">
		<nav id="tabs" aria-label="Bereiche">
			<button type="button" class="active" data-tab="settings" title="MELCloud"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M260-200q-74.85 0-127.42-52.23Q80-304.46 80-379.31q0-68.77 47-122.07 47-53.31 116.85-57.24Q257.31-646 324.23-703q66.92-57 155.77-57 100.08 0 170.04 69.96T720-520v40h24.62q57.46 1.85 96.42 42.19Q880-397.46 880-340q0 58.85-40.58 99.42Q798.85-200 740-200H260Z"/></svg><span class="tab-label">MELCloud</span></button>
			<button type="button" data-tab="hcu" title="HCU-Geräte"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M314.8 176.8h-40.4v78.6h39.8c24.7 0 39.1-15.6 39.1-39.6s-14.5-39-38.5-39M503.6 66.5c-2.7-30.9-27.3-55.4-58.1-58.1a2141.5 2141.5 0 0 0-379 0C35.6 11.1 11.1 35.7 8.4 66.5a2141.5 2141.5 0 0 0 0 379c2.7 30.9 27.3 55.4 58.1 58.1 63.1 5.6 126.3 8.4 189.5 8.4s126.4-2.8 189.5-8.4c30.9-2.7 55.4-27.3 58.1-58.1 5.6-63.1 8.4-126.3 8.4-189.5s-2.8-126.4-8.4-189.5M186.7 371.2h-42.4V140.9h42.4zM322 291.7h-47.6v79.4H232V140.9h90c43.7 0 74.2 30.1 74.2 74.9s-30.6 75.9-74.2 75.9"/></svg><span class="tab-label">HCU-Geräte</span></button>
			<button type="button" data-tab="control" title="Steuerung"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M280-280q-83.33 0-141.67-58.28Q80-396.56 80-479.82q0-83.26 58.33-141.72Q196.67-680 280-680h400q83.33 0 141.67 58.28Q880-563.44 880-480.18q0 83.26-58.33 141.72Q763.33-280 680-280H280Zm470.77-129.14Q780-438.28 780-479.91q0-41.63-29.14-70.86Q721.72-580 680.09-580q-41.63 0-70.86 29.14Q580-521.72 580-480.09q0 41.63 29.14 70.86Q638.28-380 679.91-380q41.63 0 70.86-29.14Z"/></svg><span class="tab-label">Steuerung</span></button>
			<button type="button" data-tab="guide" title="Anleitung"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M503.96-283.73q9.12-9.12 9.12-22.42 0-13.31-9.12-22.43-9.11-9.11-22.42-9.11-13.31 0-22.42 9.11-9.12 9.12-9.12 22.43 0 13.3 9.12 22.42 9.11 9.11 22.42 9.11 13.31 0 22.42-9.11Zm92.35-303.65q0-45.54-31.12-74.85-31.11-29.31-79.57-29.31-33.47 0-62.97 15.81t-47.19 44.65q-3.92 6.39-.88 14 3.04 7.62 10.88 10.54 7.39 2.69 15 .12 7.62-2.58 12-9.2 12.54-19.61 29.81-29.15t40.88-9.54q33.39 0 53.97 18.85 20.57 18.84 20.57 48.77 0 18-9.69 34.92t-32.15 36.92q-26 24.54-38.62 44.54-12.61 20-15.08 43.93-1.23 7.07 4.27 13.19 5.5 6.11 13.81 6.11 7.85 0 13.58-4.88 5.73-4.89 7.19-13.19 3-16.77 11.77-30.43 8.77-13.65 28.77-33.65 31.08-31.08 42.92-52.15 11.85-21.08 11.85-46ZM224.62-160q-27.62 0-46.12-18.5Q160-197 160-224.62v-510.76q0-27.62 18.5-46.12Q197-800 224.62-800h510.76q27.62 0 46.12 18.5Q800-763 800-735.38v510.76q0 27.62-18.5 46.12Q763-160 735.38-160H224.62Z"/></svg><span class="tab-label">Anleitung</span></button>
		</nav>
		<form id="cfg">
		<section id="tab-control" class="taboff">
		<h2 style="margin-top:0">Klimasteuerung</h2>
		<div id="controls"><span class="mut">Noch keine Klimaanlage erkannt — zuerst Zugangsdaten speichern bzw. „Verbindung testen“.</span></div>
		</section>

		<section id="tab-hcu" class="taboff">
		<h2 style="margin-top:0">Geräte an die HCU übertragen</h2>
		<div class="desc">Nur gehäkelte Geräte erscheinen in der Homematic-Welt (HCU-App, CCU-Programme). Die Steuerung über diese Seite funktioniert unabhängig davon immer voll — inklusive Entfeuchten und Lüfter. Änderungen hier mit „Speichern &amp; Verbinden“ übernehmen.</div>
		<div id="exposeBox"></div>
		<div class="btns">
			<button type="submit" id="saveBtn">Speichern &amp; Verbinden</button>
		</div>
		<h2>Von der HCU übernommene Geräte</h2>
		<table><thead><tr><th>Typ</th><th>Name</th><th>Werte</th></tr></thead>
		<tbody id="devTable"><tr><td colspan="3" class="mut">—</td></tr></tbody></table>
		</section>

		<section id="tab-settings">
		<h2 style="margin-top:0">MELCloud-Zugang</h2>
		<div class="row">
			<div class="field"><label>E-Mail</label>
				<input type="text" id="melEmail" autocomplete="username">
				<div class="desc">Anmeldemail des MELCloud-<b>Home</b>-Kontos (melcloudhome.com).</div>
			</div>
			<div class="field"><label>Passwort</label>
				<input type="password" id="melPassword" autocomplete="new-password">
				<div class="desc" id="passDesc">Wird nicht im Klartext angezeigt — zum Ändern neues Passwort eingeben.</div>
			</div>
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
		<div class="btns">
			<button type="button" class="sec" id="pollBtn">Verbindung testen</button>
			<button type="submit" id="saveBtn2">Speichern &amp; Verbinden</button>
		</div>
		</section>

		<section id="tab-guide" class="taboff">
		<div class="guide">
		<h2 style="margin-top:0">Anleitung</h2>

		<h3>1. Voraussetzungen</h3>
		<ul>
			<li>Eine Home Control Unit mit Firmware 1.4.7 oder neuer, in der dieses Plugin installiert und aktiv ist.</li>
			<li>Ein MELCloud-Home-Konto: Ihre Klimageräte sind im Heim-WLAN angemeldet und in der App „MELCloud Home“ sichtbar und steuerbar.</li>
			<li>Diese Konfigurationsseite erreichen Sie über den WebUI-Link auf der Plugin-Seite in HCUweb oder direkt im Browser unter http://&lt;Adresse&gt;:5300.</li>
		</ul>

		<h3>2. MELCloud-Home-Konto verbinden (Tab „MELCloud“)</h3>
		<ol>
			<li>Öffnen Sie den Tab „MELCloud“.</li>
			<li>Geben Sie E-Mail-Adresse und Passwort Ihres MELCloud-Home-Kontos ein. Hinweis: Es ist das Konto der App „MELCloud Home“ (melcloudhome.com), nicht die Anmeldung des früheren Portals melcloud.com.</li>
			<li>Klicken Sie auf „Verbindung testen“. Die Statuszeile oben muss auf Grün springen und die erkannten Geräte melden, z. B. „Verbunden · 1 Gerät(e) erkannt“.</li>
			<li>Klicken Sie auf „Speichern &amp; Verbinden“. Die Geräteliste wird geladen und an die Home Control Unit gemeldet.</li>
		</ol>
		<div class="note">Das Passwort wird ausschließlich lokal im Plugin gespeichert und an keiner Stelle wieder angezeigt. Lassen Sie das Passwortfeld bei späteren Änderungen leer, bleibt das gespeicherte Passwort gültig.</div>

		<h3>3. Betriebsparameter verstehen (Tab „MELCloud“, Abschnitt „Betrieb“)</h3>
		<ul>
			<li><b>Abfrageintervall:</b> Wie oft (in Sekunden) der Zustand Ihrer Geräte bei MELCloud abgefragt wird. Ein kleines Intervall aktualisiert die Anzeige schneller, erzeugt aber mehr Anfragen an die Cloud. Mindestwert: 30 Sekunden.</li>
			<li><b>Mindestabstand zwischen Anfragen:</b> Pause, die das Plugin zwischen zwei Anfragen an MELCloud einhält. Das schützt Ihr Konto vor Sperren wegen zu häufiger Anfragen. Der Standardwert von 2 Sekunden ist empfohlen.</li>
		</ul>

		<h3>4. Geräte in Homematic IP übernehmen (Tab „HCU-Geräte“)</h3>
		<ol>
			<li>Das Plugin stellt je Klimagerät zwei Geräte bereit: „Klima“ (Thermostat mit Ist- und Solltemperatur) und „An/Aus“ (Schalter).</li>
			<li>Diese Geräte erscheinen nach dem Speichern automatisch in der Homematic-IP-App. Ordnen Sie sie dort wie gewohnt einem Raum zu und verwenden Sie sie in Programmen.</li>
			<li>Über die Checkboxen „Geräte an die HCU übertragen“ bestimmen Sie, welche Geräte an die Home Control Unit gemeldet werden. Ohne Haken verschwindet das Gerät nach dem Speichern aus Homematic IP; steuerbar bleibt das Gerät über diese Seite trotzdem.</li>
			<li>Die Tabelle „Von der HCU übernommene Geräte“ zeigt, welche Werte aktuell an die Home Control Unit gemeldet werden.</li>
		</ol>

		<h3>5. Klimagerät bedienen</h3>
		<p><b>Über die Homematic-IP-App:</b> Ein- und Ausschalten über das Gerät „An/Aus“, Solltemperatur setzen und Ist-Temperatur ablesen über das Gerät „Klima“. Die Betriebsart lässt sich in der App nicht wählen — dafür ist die Bedienung auf dieser Seite gedacht.</p>
		<p><b>Über diese Seite (Tab „Steuerung“):</b> An/Aus, Solltemperatur mit den Schaltflächen für wärmer und kälter, sowie alle fünf Betriebsarten Auto, Heizen, Kühlen, Entfeuchten und Lüfter. Die Betriebsarten Entfeuchten und Lüfter bietet Homematic IP nicht an, sie sind nur hier wählbar. Befehle werden sofort an MELCloud gesendet; die Anzeige gleicht sich spätestens nach einem Abfrageintervall mit dem Cloud-Wert ab.</p>

		<h3>6. Wichtige Hinweise</h3>
		<ul>
			<li>Wird das Gerät mit der Infrarot-Fernbedienung geschaltet, erkennt MELCloud diesen Vorgang oft nicht. Die angezeigten Zustände können dann von der Realität abweichen, bis Sie das Gerät wieder über App oder diese Seite schalten.</li>
			<li>Ändern Sie Ihr MELCloud-Passwort, müssen Sie es auch auf dieser Seite neu eingeben und speichern.</li>
			<li>Ein als „getrennt“ markiertes Gerät ist meist nicht im Heim-WLAN erreichbar. Prüfen Sie die Stromversorgung und die MELCloud-Home-App.</li>
		</ul>

		<h3>7. Fehlerfälle</h3>
		<table>
			<thead><tr><th>Situation</th><th>Abhilfe</th></tr></thead>
			<tbody>
				<tr><td>Statuszeile: „Zugangsdaten fehlen.“</td><td>Tab „MELCloud“ öffnen, E-Mail und Passwort eintragen, „Speichern &amp; Verbinden“.</td></tr>
				<tr><td>„Verbindung testen“ meldet Ablehnung der Anmeldedaten</td><td>Passwort geändert? Neues Passwort eingeben und speichern. Wichtig: MELCloud-Home-Konto, nicht melcloud.com.</td></tr>
				<tr><td>Geräte fehlen in der Homematic-IP-App</td><td>Tab „HCU-Geräte“: Haken gesetzt? Gespeichert? Bis zu zwei Minuten warten, danach Plugin bzw. HCU neu starten lassen.</td></tr>
				<tr><td>Solltemperatur weicht nach Setzen ab</td><td>Grenzen und Raster der Solltemperatur kommen vom Gerät (siehe Hinweis auf der Steuerkarte, z. B. 10–31 °C in 0,5-°C-Schritten). MELCloud rundet ggf. auf den nächsten erlaubten Wert.</td></tr>
				<tr><td>Status hinkt hinterher</td><td>„Verbindung testen“ oder das Aktualisieren-Symbol oben rechts löst eine sofortige Abfrage aus.</td></tr>
			</tbody>
		</table>
		</div>
		</section>
		</form>
	</div>
</div>
<script>
	const $ = (id) => document.getElementById(id);
	function banner(cls, text) { const b = $("banner"); b.className = "banner " + cls; b.textContent = text; }
	function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
	const expose = {}; // unitId -> bool (master switch for HCU transfer)
	const exposeDev = {}; // deviceId -> bool (per device for HCU transfer)
	const unitState = {}; // unitId -> last known unit payload (also optimistic)
	/* Passwortfeld: bei gespeichertem Passwort Platzhalter-Maske zeigen — das echte
	   Passwort verlässt das Plugin nie; Klick ins Feld löscht die Maske zum Überschreiben. */
	const PW_MASK = "************";
	let storedPw = false, pwMasked = false;
	function setPwMask() { $("melPassword").value = PW_MASK; pwMasked = true; $("melPassword").classList.add("masked"); }
	function clearPwMask() { $("melPassword").value = ""; pwMasked = false; $("melPassword").classList.remove("masked"); }
	function pwSend() { return pwMasked ? "" : $("melPassword").value; }
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
		storedPw = Boolean(c.hasPassword);
		if (storedPw) {
			setPwMask();
			$("passDesc").textContent = "Gespeichert. Zum Ändern das Feld leeren und neues Passwort tippen — nicht ändern, um das gespeicherte zu behalten.";
		} else {
			clearPwMask();
			$("passDesc").textContent = "Noch kein Passwort gespeichert — bitte eingeben.";
		}
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

	/* -------- Tabs (Steuerung / HCU-Geräte / Einstellungen) -------------- */
	document.querySelectorAll("#tabs button").forEach((b) => {
		b.addEventListener("click", () => {
			document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
			["control", "hcu", "settings", "guide"].forEach((t) => {
				document.getElementById("tab-" + t).classList.toggle("taboff", t !== b.dataset.tab);
			});
		});
	});

	$("cfg").addEventListener("submit", async (ev) => {
		ev.preventDefault();
		const btn = ev.submitter || $("saveBtn"); // Speichern-Button des aktiven Tabs
		const body = {
			melEmail: $("melEmail").value.trim(),
			melPassword: pwSend(),
			pollIntervalSeconds: Number($("pollIntervalSeconds").value) || 60,
			minRequestGapSeconds: Number($("minRequestGapSeconds").value) || 2,
			expose,
			exposeDevices: exposeDev,
		};
		await send(body, "/api/config", btn, "Verbinde…");
	});
	$("pollBtn").addEventListener("click", async () => {
		const body = { melEmail: $("melEmail").value.trim(), melPassword: pwSend() };
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
	$("melPassword").addEventListener("focus", () => { if (pwMasked) clearPwMask(); });
	$("melPassword").addEventListener("blur", () => { if (storedPw && $("melPassword").value === "") setPwMask(); });
	async function send(body, url, btn, busyText) {
		const old = btn.textContent; btn.disabled = true; btn.textContent = busyText;
		try {
			const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
			banner(r.status === "APPLIED" ? "ok" : "err", r.message);
			clearPwMask();
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
