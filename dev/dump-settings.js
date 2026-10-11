// Nur-Lese-Diagnose: rohe MELCloud-Settings eines ATA-Units ausgeben.
// Nutzt die gespeicherten Tokens/Config des Plugins (Standardpfad /data).
"use strict";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const auth = require("../plugin/src/melcloudAuth");
const { BFF_BASE, BFF_UA } = require("../plugin/src/melcloudAuth");
const configModule = require("../plugin/src/config");

(async () => {
	const config = configModule.load();
	const token = await auth.getAccessToken(config.melEmail, config.melPassword);
	// Raw-JSON direkt holen, um die originalen String-Werte zu sehen:
	const resp = await fetch(`${BFF_BASE}/context`, {
		headers: { authorization: `Bearer ${token}`, "user-agent": BFF_UA, accept: "application/json" },
	});
	const json = await resp.json();
	for (const b of json.buildings || []) {
		for (const u of b.airToAirUnits || []) {
			console.log(`\n=== ${u.givenDisplayName} (${u.id}) isConnected=${u.isConnected} ===`);
			for (const s of u.settings || []) console.log(`  ${s.name} = ${JSON.stringify(s.value)}`);
		}
	}
})().catch((e) => {
	console.error("FAILED: " + e.message);
	process.exit(1);
});
