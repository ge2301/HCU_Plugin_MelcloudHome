// HCU-Inspektion: verbindet sich als Plugin bei der HCU und mitschreibt, was
// die HCU tatsaechlich schickt (insbesondere: kommt CONTROL_REQUEST an?).
// Zusaetzlich: HMIP_SYSTEM_REQUEST /getSystemState -> aktuelle Geraeteliste
// der Homematic-Welt inkl. Kanaele (sind mc-* dort ueberhaupt enthalten?).
//
// Lesend: MELCloud wird nur abgefragt (GET /context); Steuerbefehle von der
// HCU werden NUR protokolliert, NICHT an MELCloud weitergeleitet.
//
// Vorher laufendes Plugin beenden (nur eine WS-Verbindung pro Plugin-ID)!
//
// Aufruf:
//   node dev\hcu-inspect.js <pluginId> <hcuHost> <tokenFile> [--minutes 5]

"use strict";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // HCU self-signed cert

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const auth = require("../plugin/src/melcloudAuth");
const { MelcloudClient } = require("../plugin/src/melcloudClient");
const configModule = require("../plugin/src/config");
const deviceMapper = require("../plugin/src/deviceMapper");

const argv = process.argv.slice(2);
const pluginId = argv[0];
const host = argv[1];
const tokenFile = argv[2];
if (!pluginId || !host || !tokenFile) {
	console.error("Usage: node dev/hcu-inspect.js <pluginId> <hcuHost> <tokenFile> [--minutes N]");
	process.exit(2);
}
const minutesIdx = argv.indexOf("--minutes");
const minutes = minutesIdx > 0 ? Number(argv[minutesIdx + 1]) || 5 : 5;
const LOG_PATH = path.join(__dirname, "inspect.log");

function log(line) {
	const stamp = new Date().toISOString();
	const s = `[${stamp}] ${line}`;
	console.log(s);
	try {
		fs.appendFileSync(LOG_PATH, s + "\n", "utf8");
	} catch (e) {
		/* ignore log errors */
	}
}

async function main() {
	fs.writeFileSync(LOG_PATH, `=== HCU-Inspection ${new Date().toISOString()} plugin=${pluginId} host=${host} ===\n`, "utf8");
	const authToken = (await fs.promises.readFile(tokenFile, "utf8")).trim();
	log(`Token geladen (${authToken.length} Zeichen), verbinde wss://${host}:9001 als ${pluginId}`);

	// Geraeteliste wie im Plugin aufbauen, damit DISCOVER_RESPONSE identisch ist
	let devices = [];
	try {
		const config = configModule.load();
		const token = await auth.getAccessToken(config.melEmail, config.melPassword);
		const ctx = await new MelcloudClient({ minGapMs: 1000 }).fetchContext(token);
		devices = deviceMapper.buildDevices(ctx.units, config);
		log(`MELCloud-Geraete aufgebaut: ${devices.map((d) => d.deviceId).join(", ") || "KEINE"}`);
	} catch (e) {
		log(`WARNUNG: MELCloud-Geraete nicht aufbaubar (${e.message}) — DISCOVER antwortet leer`);
	}

	const ws = new WebSocket(`wss://${host}:9001`, {
		rejectUnauthorized: false,
		headers: { authtoken: authToken, "plugin-id": pluginId },
	});

	const send = (msg) => {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify(msg));
		log(`SEND  ${msg.type}${msg.body && msg.body.path ? " " + msg.body.path : ""}`);
	};

	ws.on("open", () => {
		log("=== VERBUNDEN — HCU-Verbindung offen ===");
		send({ id: uuidv4(), pluginId, type: "PLUGIN_STATE_RESPONSE", body: { pluginReadinessStatus: "READY" } });
		// Homematic-Welt anfordern (lesen, wie die HCU unsere Geraete sieht)
		send({
			id: uuidv4(),
			pluginId,
			type: "HMIP_SYSTEM_REQUEST",
			body: { path: "/hmip/home/getSystemState", body: {} },
		});
	});
	ws.on("error", (e) => log(`WS-FEHLER: ${e.code || ""} ${e.message}`));
	ws.on("close", (c, r) => {
		log(`WS GESCHLOSSEN (code ${c}) ${r || ""}`);
		process.exit(0);
	});

	ws.on("message", (data) => {
		let m;
		try {
			m = JSON.parse(data);
		} catch {
			log(`EMPFING (nicht-JSON): ${String(data).slice(0, 200)}`);
			return;
		}
		// Vollstaendig protokollieren (SystemState-Rohdaten nur kompakt)
		if (m.type === "HMIP_SYSTEM_RESPONSE") {
			const devs = (m.body && m.body.body && m.body.body.devices) || m.body && m.body.devices || {};
			const list = Object.values(devs);
			log(`EMPFING HMIP_SYSTEM_RESPONSE: ${list.length} Geraet(e) in der Homematic-Welt`);
			for (const d of list) {
				const chs = Object.values(d.functionalChannels || {})
					.map((ch) => `${ch.index}:${ch.functionalChannelType}${ch.channelRole ? "/" + ch.channelRole : ""}`)
					.join(" ");
				log(`   GERAET ${d.id} | ${d.type} | model=${d.modelType || "-"} | label="${d.label || ""}" | reach=${d.permanentlyReachable} | kanael: ${chs || "-"}`);
			}
			fs.writeFileSync(path.join(__dirname, "inspect-systemstate.json"), JSON.stringify(m, null, 1), "utf8");
			log("   Vollstaendige Response: dev/inspect-systemstate.json");
			return;
		}
		log(`EMPFING ${m.type}: ${JSON.stringify(m.body || {}).slice(0, 400)}`);

		switch (m.type) {
			case "DISCOVER_REQUEST":
				send({
					id: uuidv4(),
					pluginId,
					type: "DISCOVER_RESPONSE",
					requestId: m.id,
					body: { success: true, devices: devices.map((d) => ({ reachable: true, ...d })) },
				});
				break;
			case "PLUGIN_STATE_REQUEST":
				send({ id: uuidv4(), pluginId, type: "PLUGIN_STATE_RESPONSE", body: { pluginReadinessStatus: "READY" } });
				break;
			case "CONTROL_REQUEST":
				log("");
				log("!!!  CONTROL_REQUEST ANGEKOMMEN — die HCU routet korrekt!  !!!");
				log(`!!!  deviceId=${m.body && m.body.deviceId} features=${JSON.stringify((m.body && m.body.features) || [])}`);
				log("!!!  Inspektions-Modus: Befehl wird NICHT an MELCloud gesendet.");
				log("");
				send({
					id: uuidv4(),
					pluginId,
					type: "CONTROL_RESPONSE",
					body: { deviceId: m.body && m.body.deviceId, success: true },
				});
				break;
			case "CONFIG_TEMPLATE_REQUEST":
				send({
					id: uuidv4(),
					pluginId,
					type: "CONFIG_TEMPLATE_RESPONSE",
					requestId: m.id,
					body: { groups: {}, properties: {}, configUrl: `http://${host.replace(/\.local$/i, "")}:5300` },
				});
				break;
			case "CONFIG_UPDATE_REQUEST":
				log("   (Inspektion: Konfiguration wird NICHT angewendet)");
				send({
					id: uuidv4(),
					pluginId,
					type: "CONFIG_UPDATE_RESPONSE",
					requestId: m.id,
					body: { status: "APPLIED", message: "Inspektion — nichts geändert." },
				});
				break;
			default:
				break; // nur geloggt
		}
	});

	const stop = setTimeout(() => {
		log(`Zeitlimit ${minutes} min erreicht — beende.`);
		ws.close();
	}, minutes * 60000);
	stop.unref();
	log(`Laeuft ${minutes} min (oder bis Strg+C). JETZT in der App den Schalter umlegen!`);
	log(`Live-Mitschnitt: ${LOG_PATH}`);
}

main().catch((e) => {
	log(`FATAL: ${e.stack || e.message}`);
	process.exit(1);
});
