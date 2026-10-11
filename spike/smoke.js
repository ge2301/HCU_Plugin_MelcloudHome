"use strict";

/**
 * Local smoke test for the plugin modules WITHOUT an HCU/WebSocket.
 * Exercises: config -> melcloudAuth -> melcloudClient -> deviceMapper.
 * Read-only (login + GET /context only, no control commands).
 *
 *   $env:MEL_EMAIL=...; $env:MEL_PASS=...; node spike/smoke.js
 */

process.env.MELCLOUD_CONFIG_PATH = require("path").join(__dirname, ".smoke-config.json");
process.env.MELCLOUD_TOKENS_PATH = require("path").join(__dirname, ".smoke-tokens.json");
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "info";

const fs = require("fs");
const configModule = require("../plugin/src/config");
const auth = require("../plugin/src/melcloudAuth");
const { MelcloudClient } = require("../plugin/src/melcloudClient");
const deviceMapper = require("../plugin/src/deviceMapper");

const EMAIL = process.env.MEL_EMAIL;
const PASS = process.env.MEL_PASS;
if (!EMAIL || !PASS) {
	console.error("Set MEL_EMAIL and MEL_PASS.");
	process.exit(2);
}

function cleanup() {
	for (const f of [process.env.MELCLOUD_CONFIG_PATH, process.env.MELCLOUD_TOKENS_PATH]) {
		try {
			if (fs.existsSync(f)) fs.unlinkSync(f);
		} catch {
			/* ignore */
		}
	}
}

(async () => {
	console.log("1) config template (unconfigured)");
	let config = configModule.load();
	console.log("   isConfigured:", configModule.isConfigured(config));
	const tpl0 = configModule.buildTemplate(config, [], "noch nicht verbunden");
	console.log("   groups:", Object.keys(tpl0.groups).join(", "));

	console.log("2) apply credentials + save");
	config = configModule.applyUpdate(config, { melEmail: EMAIL, melPassword: PASS });
	configModule.save(config);
	console.log("   isConfigured:", configModule.isConfigured(config));

	console.log("3) access token (PKCE/Cognito or refresh)");
	const token = await auth.getAccessToken(config.melEmail, config.melPassword);
	console.log("   token:", String(token).slice(0, 12) + "...");

	console.log("4) GET /context via MelcloudClient");
	const client = new MelcloudClient({ minGapMs: (config.minRequestGapSeconds || 2) * 1000 });
	const ctx = await client.fetchContext(token);
	console.log("   account:", ctx.account.email, "| units:", ctx.units.length);
	for (const u of ctx.units) {
		console.log(
			`   - ${u.name}: power=${u.state?.power} mode=${u.state?.operationMode} ` +
				`set=${u.state?.setTemperature} room=${u.state?.roomTemperature} conn=${u.connected}`
		);
	}

	console.log("5) deviceMapper.buildDevices");
	const devices = deviceMapper.buildDevices(ctx.units, config);
	console.log(`   ${devices.length} device(s):`);
	for (const d of devices) console.log(`   - [${d.deviceType}] ${d.friendlyName} (${d.deviceId})`);

	console.log("6) STATUS_EVENT delta (no change -> empty, then a simulated change)");
	const first = deviceMapper.buildStatusEvents(ctx.units, config, new Map());
	console.log("   first pass events:", first.events.length);
	const second = deviceMapper.buildStatusEvents(ctx.units, config, first.nextById);
	console.log("   unchanged pass events:", second.events.length, "(expect 0)");

	console.log("7) buildTemplate WITH devices");
	const tpl1 = configModule.buildTemplate(config, ctx.units, "Verbunden");
	const deviceProps = Object.keys(tpl1.properties).filter((k) => k.startsWith("show_"));
	console.log("   dynamic device props:", deviceProps.join(", ") || "(none)");

	console.log("\nSMOKE OK — Module laufen gegen die echte MELCloud-Home-API.");
	cleanup();
})()
	.catch((e) => {
		console.error("SMOKE FAILED:", e.message);
		cleanup();
		process.exit(1);
	});
