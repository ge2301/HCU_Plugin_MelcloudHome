"use strict";

/**
 * One-shot Connect API token bootstrap for running the plugin LOCALLY (no Docker).
 *
 * Mirrors Connect API docs section 2.4 "Get an authorization token":
 *   1. (user) In HCUweb > developer mode: enable "Connect API WebSocket" + generate an activation key
 *   2. POST https://<hcu>:6969/hmip/auth/requestConnectApiAuthToken  -> authToken
 *   3. POST https://<hcu>:6969/hmip/auth/confirmConnectApiAuthToken  -> clientId (token now valid)
 * The resulting authToken is written to dev/authtoken.txt for the plugin to use.
 *
 * The activation key is single-use and expires; this script is run once by the
 * developer and is NOT part of the plugin.
 *
 * Usage:
 *   node dev/hcu-token.js <hcuHost> <activationKey>
 *   node dev/hcu-token.js hcu1-1234.local ABCDEF
 *
 * Optional env: PLUGIN_ID (default de.community.homematic.plugin.melcloud)
 */

// The HCU serves HTTPS/WSS with a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fs = require("fs");
const path = require("path");

const [,, hcuHost, activationKey] = process.argv;
if (!hcuHost || !activationKey) {
	console.error("Usage: node dev/hcu-token.js <hcuHost> <activationKey>");
	console.error("  hcuHost e.g. hcu1-1234.local (XXXX = last 4 of the SGTIN under the HCU)");
	console.error("  activationKey from HCUweb > developer mode");
	process.exit(2);
}

const PLUGIN_ID = process.env.PLUGIN_ID || "de.community.homematic.plugin.melcloud";
const FRIENDLY_NAME = { en: "MELCloud Home", de: "MELCloud Home" };
const TOKEN_FILE = path.join(__dirname, "authtoken.txt");

async function post(hcu, endpoint, body) {
	const url = `https://${hcu}:6969/hmip/auth/${endpoint}`;
	const resp = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", VERSION: "12" },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!resp.ok) {
		throw new Error(`${endpoint} -> HTTP ${resp.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json)}`);
	}
	return json;
}

(async () => {
	console.log(`HCU:        https://${hcuHost}:6969`);
	console.log(`Plugin-ID:  ${PLUGIN_ID}`);

	console.log("\n1) requestConnectApiAuthToken …");
	const req = await post(hcuHost, "requestConnectApiAuthToken", {
		activationKey,
		pluginId: PLUGIN_ID,
		friendlyName: FRIENDLY_NAME,
	});
	if (!req.authToken) throw new Error("response without authToken: " + JSON.stringify(req));
	console.log(`   authToken: ${String(req.authToken).slice(0, 10)}…`);

	console.log("2) confirmConnectApiAuthToken …");
	const conf = await post(hcuHost, "confirmConnectApiAuthToken", { activationKey, authToken: req.authToken });
	console.log(`   clientId:  ${conf.clientId}`);

	fs.writeFileSync(TOKEN_FILE, req.authToken.trim(), "utf8");
	console.log(`\nOK. Token gespeichert in ${TOKEN_FILE}`);
	console.log("Next:  .\\dev\\run-local.ps1 -HcuHost " + hcuHost);
})().catch((e) => {
	console.error("\nFAILED:", e.message);
	console.error("Hints: WebSocket in der HCUweb (Entwicklermodus) freigegeben? Aktivierungscode noch gültig/ungenutzt? Hostname richtig?");
	process.exit(1);
});
