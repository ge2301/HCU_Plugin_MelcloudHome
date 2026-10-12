"use strict";

const fs = require("fs").promises;
const logger = require("./logger");
const configModule = require("./config");
const auth = require("./melcloudAuth");
const { MelcloudClient, ApiError } = require("./melcloudClient");
const deviceMapper = require("./deviceMapper");
const HcuClient = require("./hcuClient");
const { startWebUI } = require("./webui");
const { resolveUiBaseUrl, readSgtin } = require("./uiUrl");

const UI_PORT = Number(process.env.PORT || 5300);

/**
 * Entry point of the MELCloud Home HCU plugin.
 *
 * Command line arguments (as provided by the Dockerfile ENTRYPOINT):
 *   argv[2] = pluginId
 *   argv[3] = HCU host (e.g. host.containers.internal on the HCU)
 *   argv[4] = path to the auth token file (e.g. /TOKEN)
 */
async function main() {
	const [, , pluginId, host, authTokenFile] = process.argv;
	if (!pluginId || !host || !authTokenFile) {
		logger.error("Usage: node src/index.js <pluginId> <hcuHost> <authTokenFile>");
		process.exit(2);
	}
	const authToken = (await fs.readFile(authTokenFile, "utf8")).trim();

	// Mutable runtime state -------------------------------------------------
	let config = configModule.load();
	let lastContext = null; // last successful parsed { account, units }
	let lastError = null;
	let lastPollOkAt = null;
	let consecutiveFailures = 0;
	let nextAllowedPollAt = 0; // backoff gate
	let featuresById = new Map(); // deviceId -> serialized features (delta base)
	let announcedDeviceSig = null; // device-id signature last announced to HCU
	let pollTimer = null;
	let lastLoggedUiUrl = null; // avoids repeating the WebUI-URL log line

	const client = new MelcloudClient({
		minGapMs: (config.minRequestGapSeconds || 2) * 1000,
	});

	// Derived helpers -------------------------------------------------------
	function currentReadiness() {
		if (!configModule.isConfigured(config)) return "CONFIG_REQUIRED";
		if (lastPollOkAt == null && lastError != null) return "ERROR";
		return "READY";
	}

	function discoveredUnits() {
		return lastContext ? lastContext.units : [];
	}

	function statusText() {
		if (!configModule.isConfigured(config)) return "Zugangsdaten fehlen.";
		if (lastError) return `Letzter Fehler: ${lastError}`;
		if (!lastPollOkAt) return "Verbindung wird aufgebaut…";
		const n = discoveredUnits().length;
		const t = new Date(lastPollOkAt).toLocaleString("de-DE");
		return `Verbunden · ${n} Gerät(e) erkannt · letzte Aktualisierung: ${t}`;
	}

	function currentDevices() {
		return deviceMapper.buildDevices(discoveredUnits(), config);
	}

	/**
	 * Base URL of the embedded WebUI as reachable FROM THE LAN — see uiUrl.js.
	 * Re-evaluated on every CONFIG_TEMPLATE_REQUEST, so a host that the user
	 * enters in the config form takes effect without a container restart.
	 */
	function uiBaseUrl() {
		const url = resolveUiBaseUrl({
			override: config.webuiHost,
			envHost: process.env.WEBUI_HOST,
			argvHost: host,
			sgtin: (process.env.SGTIN || "").trim() || readSgtin(),
			port: UI_PORT,
		});
		if (!url) {
			logger.warn("WebUI-Host nicht bestimmbar (kein /SGTIN im Container) — WebUI-Link entfällt.");
		}
		return url;
	}

	/** Log the link the HCU config page will show — but only when it changes. */
	function logUiBaseUrl(url) {
		if (url === lastLoggedUiUrl) return;
		lastLoggedUiUrl = url;
		if (url) logger.info(`WebUI-Link der HCU-Konfigurationsseite: ${url}/config`);
	}

	// HCU client ------------------------------------------------------------
	const hcu = new HcuClient({
		pluginId,
		host,
		authToken,
		callbacks: {
			getReadiness: currentReadiness,
			getDevices: currentDevices,
			getConfigTemplate: () => {
				const uiUrl = uiBaseUrl();
				logUiBaseUrl(uiUrl);
				return configModule.buildTemplate(config, discoveredUnits(), statusText(), uiUrl);
			},
			onConfigUpdate: (properties) => applyAndConnect(properties),
			onControlRequest: async (body) => {
				// Echte Steuerung: HCU -> CONTROL_REQUEST -> PUT /monitor/ataunit.
				const target = deviceMapper.resolveControlTarget(body && body.deviceId);
				if (!target) {
					return {
						success: false,
						error: { code: "UNKNOWN_DEVICE", message: `Unbekanntes Gerät: ${body && body.deviceId}` },
					};
				}
				const partial = deviceMapper.controlFeaturesToPartial(body.features);
				if (Object.keys(partial).length === 0) {
					return {
						success: false,
						error: { code: "FEATURE_NOT_SUPPORTED", message: "Kein unterstütztes Feature in der Anfrage." },
					};
				}
				const result = await controlUnit(target.unitId, partial);
				return result.success
					? { success: true }
					: { success: false, error: { code: "CONTROL_FAILED", message: result.message } };
			},
		},
	});

	// Polling ---------------------------------------------------------------
	async function pollOnce() {
		if (!configModule.isConfigured(config)) {
			logger.debug("Skipping poll: plugin not configured yet");
			return;
		}
		if (Date.now() < nextAllowedPollAt) {
			logger.debug("Skipping poll: in backoff window");
			return;
		}
		try {
			let ctx;
			try {
				const token = await auth.getAccessToken(config.melEmail, config.melPassword);
				ctx = await client.fetchContext(token);
			} catch (err) {
				if (err instanceof ApiError && err.statusCode === 401) {
					logger.info("MELCloud returned 401 — forcing re-login");
					const token = await auth.relogin(config.melEmail, config.melPassword);
					ctx = await client.fetchContext(token);
				} else {
					throw err;
				}
			}
			lastContext = ctx;
			lastPollOkAt = Date.now();
			if (lastError) {
				logger.info("MELCloud connection recovered");
				if (hcu) hcu.pushReadiness();
			}
			lastError = null;
			consecutiveFailures = 0;

			const { events, nextById } = deviceMapper.buildStatusEvents(
				ctx.units,
				config,
				featuresById
			);
			featuresById = nextById;
			if (events.length > 0) {
				hcu.sendStatusEvents(events);
				logger.info(`MELCloud update: ${ctx.units.length} unit(s), ${events.length} device change(s)`);
			} else {
				logger.debug(`MELCloud update: ${ctx.units.length} unit(s), no changes`);
			}

			// Re-announce the device list whenever its composition changes
			// (the initial DISCOVER_REQUEST may have arrived with 0 devices).
			const sig = [...nextById.keys()].sort().join(",");
			if (sig !== announcedDeviceSig) {
				announcedDeviceSig = sig;
				if (nextById.size > 0) {
					logger.info("Device list changed — re-announcing to HCU");
					hcu.announceDevices();
				}
			}
		} catch (err) {
			lastError = err.message;
			consecutiveFailures++;
			const backoffMs = Math.min(
				60_000 * Math.pow(2, consecutiveFailures - 1),
				60 * 60 * 1000
			);
			nextAllowedPollAt = Date.now() + backoffMs;
			logger.error(
				`MELCloud poll failed (#${consecutiveFailures}): ${err.message} — next try in ${Math.round(backoffMs / 1000)}s`
			);
			if (hcu) hcu.pushReadiness();
		}
	}

	function restartPolling() {
		if (pollTimer) clearInterval(pollTimer);
		const intervalMs = Math.max(
			configModule.MIN_POLL_INTERVAL_S,
			config.pollIntervalSeconds || 60
		) * 1000;
		pollTimer = setInterval(pollOnce, intervalMs);
		logger.info(`Polling every ${intervalMs / 1000}s`);
	}

	/**
	 * Sends a control command to one MELCloud ATA unit.
	 * @param {string} unitId
	 * @param {object} partial - { power?, operationMode?, setTemperature? } (MELCloud names)
	 */
	async function controlUnit(unitId, partial) {
		if (!configModule.isConfigured(config)) return { success: false, message: "Plugin ist nicht konfiguriert." };
		const unit = discoveredUnits().find((u) => u.id === unitId);
		if (!unit || unit.kind === "atw" || !unit.state) return { success: false, message: "Gerät nicht gefunden." };

		// Validieren/Auf MELCloud-Werte normalisieren.
		const clean = {};
		if (partial.power !== undefined) clean.power = Boolean(partial.power);
		if (partial.operationMode !== undefined) clean.operationMode = partial.operationMode;
		if (partial.setTemperature !== undefined) {
			const caps = unit.capabilities || {};
			const mins = ["minTempHeat", "minTempCoolDry", "minTempAutomatic"]
				.map((k) => Number(caps[k]))
				.filter(Number.isFinite);
			const maxs = ["maxTempHeat", "maxTempCoolDry", "maxTempAutomatic"]
				.map((k) => Number(caps[k]))
				.filter(Number.isFinite);
			const step = caps.hasHalfDegreeIncrements ? 0.5 : 1;
			const lo = mins.length ? Math.min(...mins) : 8;
			const hi = maxs.length ? Math.max(...maxs) : 32;
			let t = Number(partial.setTemperature);
			if (!Number.isFinite(t)) return { success: false, message: "Ungültige Solltemperatur." };
			t = Math.min(hi, Math.max(lo, t));
			clean.setTemperature = Number((Math.round(t / step) * step).toFixed(1));
		}
		if (Object.keys(clean).length === 0) return { success: false, message: "Kein gültiger Steuerbefehl." };

		logger.info(`Control "${unit.name}": ${JSON.stringify(clean)}`);
		try {
			let token = await auth.getAccessToken(config.melEmail, config.melPassword);
			try {
				await client.putAtaUnit(token, unitId, clean);
			} catch (err) {
				if (err instanceof ApiError && err.statusCode === 401) {
					token = await auth.relogin(config.melEmail, config.melPassword);
					await client.putAtaUnit(token, unitId, clean);
				} else throw err;
			}
		} catch (err) {
			logger.error(`Control failed: ${err.message}`);
			return { success: false, message: `Befehl abgelehnt: ${err.message}` };
		}

		// Optimistic update: HCU/Unsere UI sehen den Zielwert sofort,
		// die Wolke bestätigt beim Abgleich-Poll in wenigen Sekunden.
		if (clean.power !== undefined) unit.state.power = clean.power;
		if (clean.operationMode !== undefined) unit.state.operationMode = clean.operationMode;
		if (clean.setTemperature !== undefined) unit.state.setTemperature = clean.setTemperature;
		if (lastContext) {
			const { events, nextById } = deviceMapper.buildStatusEvents(lastContext.units, config, featuresById);
			featuresById = nextById;
			if (events.length) hcu.sendStatusEvents(events);
		}
		setTimeout(() => {
			nextAllowedPollAt = 0;
			pollOnce();
		}, 4000);
		return { success: true, message: "Befehl an MELCloud gesendet." };
	}

	// Shared config apply (used by HCUweb form AND embedded WebUI) ----------
	async function applyAndConnect(properties, exposeMap, exposeDevicesMap) {
		const prevEmail = config.melEmail;
		const prevPass = config.melPassword;
		config = configModule.applyUpdate(config, properties || {});
		config = configModule.applyShowProps(config, discoveredUnits());
		if (exposeMap && typeof exposeMap === "object") {
			const exp = { ...config.exposeUnits };
			for (const [id, v] of Object.entries(exposeMap)) exp[id] = Boolean(v);
			config.exposeUnits = exp;
		}
		if (exposeDevicesMap && typeof exposeDevicesMap === "object") {
			const exp = { ...config.exposeDevices };
			for (const [id, v] of Object.entries(exposeDevicesMap)) exp[id] = Boolean(v);
			config.exposeDevices = exp;
			// Geräteliste kann sich geändert haben -> HCU neu informieren.
			announcedDeviceSig = null;
		}
		const credsChanged = config.melEmail !== prevEmail || config.melPassword !== prevPass;
		if (credsChanged) auth.clearTokens();
		configModule.save(config);
		client.setMinGapMs((config.minRequestGapSeconds || 2) * 1000);
		consecutiveFailures = 0;
		nextAllowedPollAt = 0;
		logger.info(`Configuration updated (${configModule.redact(config).melEmail || "ohne Email"})`);
		restartPolling();
		await pollOnce();
		if (!configModule.isConfigured(config)) {
			return { status: "APPLIED", message: "Bitte E-Mail und Passwort des MELCloud-Home-Kontos angeben." };
		}
		if (lastError) {
			return { status: "APPLIED", message: `Konfiguration gespeichert, aber MELCloud nicht erreichbar: ${lastError}` };
		}
		return {
			status: "APPLIED",
			message: `Verbindung zu MELCloud Home erfolgreich. ${discoveredUnits().length} Gerät(e) erkannt.`,
		};
	}

	// Embedded WebUI (reference pattern: the plugin serves its own config
	// page; the HCU config screen only shows a link to it) -------------------
	const webui = startWebUI({
		port: UI_PORT,
		getState: () => ({
			configured: configModule.isConfigured(config),
			readiness: currentReadiness(),
			status: statusText(),
			lastError,
			lastPollOkAt,
			config: {
				melEmail: config.melEmail,
				hasPassword: Boolean(config.melPassword),
				pollIntervalSeconds: config.pollIntervalSeconds,
				minRequestGapSeconds: config.minRequestGapSeconds,
				exposeUnits: config.exposeUnits || {},
				exposeDevices: config.exposeDevices || {},
			},
			units: discoveredUnits().map((u) => ({
				id: u.id,
				name: u.name,
				connected: u.connected,
				state: u.state,
				capabilities: u.capabilities,
			})),
			devices: currentDevices(),
		}),
		onSave: (body) => applyAndConnect(body, body.expose, body.exposeDevices),
		onControl: (body) => {
			const partial = {};
			if (typeof body.power === "boolean") partial.power = body.power;
			if (["Heat", "Cool", "Automatic", "Dry", "Fan"].includes(body.operationMode)) {
				partial.operationMode = body.operationMode;
			}
			if (body.setTemperature != null && Number.isFinite(Number(body.setTemperature))) {
				partial.setTemperature = Number(body.setTemperature);
			}
			return controlUnit(body.unitId, partial);
		},
		onPoll: async () => {
			if (!configModule.isConfigured(config)) {
				return { status: "FAILED", message: "Bitte zuerst E-Mail und Passwort speichern." };
			}
			nextAllowedPollAt = 0;
			await pollOnce();
			return lastError
				? { status: "FAILED", message: `MELCloud nicht erreichbar: ${lastError}` }
				: { status: "APPLIED", message: `Verbindung OK. ${discoveredUnits().length} Gerät(e) erkannt.` };
		},
	});

	// Start -----------------------------------------------------------------
	// Log the URL that the HCU config page will link to, so a wrong host is
	// visible in the plugin log without opening the config page first.
	logUiBaseUrl(uiBaseUrl());
	// Poll MELCloud BEFORE connecting so the DISCOVER_REQUEST that arrives
	// immediately after connect already sees the real device list (login can
	// take a few seconds; answering DISCOVER with 0 devices left the HCU
	// without any devices until the HCU page was reopened).
	await pollOnce();
	hcu.connect();
	restartPolling();

	// Graceful shutdown -----------------------------------------------------
	function shutdown() {
		logger.info("Shutting down plugin");
		if (pollTimer) clearInterval(pollTimer);
		if (webui) webui.close();
		hcu.stop();
		process.exit(0);
	}
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	logger.error(`Fatal error: ${err.stack || err.message}`);
	process.exit(1);
});
