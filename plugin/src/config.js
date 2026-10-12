"use strict";

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * Configuration handling for the MELCloud Home plugin.
 *
 * The HCU stores the user configuration and delivers it via CONFIG_UPDATE_REQUEST
 * whenever the user saves the form in HCUweb. We persist the last known values to
 * disk so that the plugin:
 *   1. keeps running with the correct settings after a container restart, and
 *   2. can pre-fill the configuration form (currentValue) on CONFIG_TEMPLATE_REQUEST.
 *
 * The MELCloud password is persisted (it is needed for a fresh login when the
 * refresh token was revoked) but is NEVER returned via currentValue.
 * OAuth tokens live in a separate file (tokens.json) managed by melcloudAuth.
 */

// /data is the plugin directory that the HCU keeps across updates/restarts
// (see Connect API docs, "Container environment").
const CONFIG_PATH = process.env.MELCLOUD_CONFIG_PATH || "/data/config.json";

const DEFAULT_CONFIG = {
	melEmail: "",
	melPassword: "",
	pollIntervalSeconds: 60,
	minRequestGapSeconds: 2,
	/** Manual host for the "WebUI öffnen" link; "" = derive from the HCU SGTIN */
	webuiHost: "",
	/** unitId -> boolean, devices hidden only when explicitly false */
	exposeUnits: {},
	/** deviceId -> boolean, per-device transfer-to-HCU switch (default: true) */
	exposeDevices: {},
};

const MIN_POLL_INTERVAL_S = 30;
const MIN_GAP_S = 1;

function load() {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
			logger.info(`Loaded persisted configuration from ${CONFIG_PATH}`);
			return { ...DEFAULT_CONFIG, ...parsed };
		}
	} catch (err) {
		logger.warn(`Could not read config file ${CONFIG_PATH}: ${err.message}`);
	}
	return { ...DEFAULT_CONFIG };
}

function save(config) {
	try {
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		const toWrite = { ...config };
		delete toWrite._lastStatusText; // runtime-only, do not persist
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		logger.info(`Persisted configuration to ${CONFIG_PATH}`);
	} catch (err) {
		logger.warn(`Could not persist config file ${CONFIG_PATH}: ${err.message}`);
	}
}

function isConfigured(config) {
	return Boolean(config.melEmail && config.melPassword);
}

function showPropertyId(unitId) {
	return `show_${unitId.replace(/-/g, "")}`;
}

/**
 * Applies a CONFIG_UPDATE_REQUEST body's "properties" map onto the config,
 * coercing values into the correct types.
 */
function applyUpdate(config, properties) {
	const next = { ...config, exposeUnits: { ...config.exposeUnits } };
	const map = properties || {};

	if (map.melEmail !== undefined) next.melEmail = String(map.melEmail).trim();
	// Empty password input means "keep the stored one" (HCUweb never shows it).
	if (map.melPassword !== undefined && String(map.melPassword).trim() !== "") {
		next.melPassword = String(map.melPassword);
	}
	if (map.pollIntervalSeconds !== undefined && map.pollIntervalSeconds !== "") {
		next.pollIntervalSeconds = Math.max(
			MIN_POLL_INTERVAL_S,
			Number(map.pollIntervalSeconds) || DEFAULT_CONFIG.pollIntervalSeconds
		);
	}
	if (map.minRequestGapSeconds !== undefined && map.minRequestGapSeconds !== "") {
		next.minRequestGapSeconds = Math.max(
			MIN_GAP_S,
			Number(map.minRequestGapSeconds) || DEFAULT_CONFIG.minRequestGapSeconds
		);
	}
	// Empty host = automatic (SGTIN of the HCU). Any other value overrides the
	// host part of the "WebUI öffnen" link, e.g. "192.168.1.20" or "hcu1-abcd.local".
	if (map.webuiHost !== undefined) next.webuiHost = String(map.webuiHost).trim();
	// Dynamic per-device booleans: show_<unitIdWithoutDashes>.
	// Kept raw here; applyShowProps() resolves them onto real unit IDs,
	// because the dash-stripping in showPropertyId is not reversible.
	for (const key of Object.keys(map)) {
		if (!key.startsWith("show_")) continue;
		next._showProps = next._showProps || {};
		next._showProps[key] = map[key] === true || map[key] === "true";
	}
	return next;
}

/**
 * Resolves the raw show_* properties onto real unit IDs by matching against
 * the currently known units (discovered via /context).
 */
function applyShowProps(config, units) {
	const props = config._showProps;
	if (!props) return config;
	const next = { ...config, exposeUnits: { ...config.exposeUnits } };
	for (const unit of units || []) {
		const pid = showPropertyId(unit.id);
		if (props[pid] !== undefined) next.exposeUnits[unit.id] = props[pid];
	}
	delete next._showProps;
	return next;
}

function isUnitExposed(config, unitId) {
	return config.exposeUnits[unitId] !== false; // default: shown
}

function isDeviceExposed(config, deviceId) {
	return (config.exposeDevices || {})[deviceId] !== false; // default: shown
}

/**
 * Builds the CONFIG_TEMPLATE_RESPONSE body describing the configuration form
 * that HCUweb renders for the user. The primary entry point is the WebUI link
 * (the plugin serves its own full configuration page — reference pattern);
 * the plain properties below remain as a minimal fallback editor.
 *
 * @param {object} config          - current configuration
 * @param {Array}  [units]         - currently known MELCloud units (for the device list)
 * @param {string} [statusText]    - human readable connection status for the info group
 * @param {string} [configUrl]     - URL of the embedded WebUI, e.g. http://hcu1-e60b:5300
 */
function buildTemplate(config, units, statusText, configUrl) {
	const groups = {
		webui: {
			friendlyName: "WebUI",
			description: "Komfortoberfläche des Plugins im Browser.",
			order: 1,
		},
		account: {
			friendlyName: "MELCloud-Zugang",
			description: "Zugangsdaten für dein MELCloud-Home-Konto (melcloudhome.com).",
			order: 2,
		},
		operation: {
			friendlyName: "Betrieb",
			description: "Abfrageintervall und Schutz vor zu häufigen Anfragen.",
			order: 3,
		},
		devices: {
			friendlyName: "Geräte",
			description: "Welche MELCloud-Geräte in Homematic IP angezeigt werden.",
			order: 4,
		},
		info: {
			friendlyName: "Info",
			description: "Verbindungsstatus.",
			order: 5,
		},
	};

	const properties = {};

	if (configUrl) {
		// WEBLINK gem. Connect API 1.0.1 §6.6.11: currentValue = Link,
		// defaultValue = zusätzlicher Text; HCUweb rendert daraus einen
		// anklickbaren Link auf die Plugin-WebUI. Der Host kommt vom SGTIN der
		// HCU (http://hcu1-xxxx.local), nicht aus /etc/hostname — das enthält
		// nur die Container-ID, die kein Browser im LAN auflösen kann.
		properties.webui_link = {
			dataType: "WEBLINK",
			groupId: "webui",
			order: 1,
			friendlyName: "MELCloud Home Bridge WebUI",
			description: "Vollständige Konfiguration, Klimasteuerung und Live-Status im Browser.",
			currentValue: configUrl,
			defaultValue: "WebUI öffnen",
			required: false,
		};
	} else {
		properties.webui_link_missing = {
			dataType: "STRING",
			groupId: "webui",
			order: 1,
			friendlyName: "MELCloud Home Bridge WebUI",
			description:
				"Der Host der WebUI konnte nicht ermittelt werden (SGTIN der HCU nicht lesbar). Trage unten den Host ein, z. B. hcu1-abcd.local oder die IP-Adresse der HCU.",
			currentValue: "",
			required: "false",
		};
	}

	properties.webuiHost = {
		dataType: "STRING",
		groupId: "webui",
		order: 2,
		friendlyName: "Host der WebUI (leer = automatisch)",
		description:
			"Automatisch wird http://hcu1-XXXX.local:<Port> verwendet; XXXX sind die letzten vier Stellen des SGTIN (Unterseite der HCU, im Container unter /SGTIN). Nur ausfüllen, falls die HCU im Netzwerk unter einem anderen Namen erreichbar ist, z. B. hcu1-abcd.local oder 192.168.1.20.",
		currentValue: config.webuiHost || "",
		maximumLength: 120,
		required: "false",
	};

	properties.melEmail = {
		dataType: "STRING",
		friendlyName: "E-Mail",
		description: "Anmeldemail des MELCloud-Home-Kontos.",
		groupId: "account",
		required: "true",
		order: 1,
		currentValue: config.melEmail || "",
	};

	properties.melPassword = {
		dataType: "STRING",
		friendlyName: "Passwort",
		description:
			"Passwort des MELCloud-Home-Kontos. Aus Sicherheitsgründen wird es nie angezeigt; leer lassen zum Behalten.",
		groupId: "account",
		order: 2,
		currentValue: "",
	};

	properties.pollIntervalSeconds = {
		dataType: "INTEGER",
		friendlyName: "Abfrageintervall (Sekunden)",
		description:
			"Wie oft der Gerätezustand bei MELCloud abgefragt wird. Kleinster sicherer Wert: 30 Sekunden.",
		groupId: "operation",
		minimum: MIN_POLL_INTERVAL_S,
		maximum: 3600,
		defaultValue: String(DEFAULT_CONFIG.pollIntervalSeconds),
		order: 1,
		currentValue: String(config.pollIntervalSeconds || DEFAULT_CONFIG.pollIntervalSeconds),
	};

	properties.minRequestGapSeconds = {
		dataType: "INTEGER",
		friendlyName: "Mindestabstand zwischen Anfragen (Sekunden)",
		description:
			"Sicherheitsschwelle gegenüber der MELCloud-API, um Kontosperren zu vermeiden. Standard 2 s.",
		groupId: "operation",
		minimum: MIN_GAP_S,
		maximum: 60,
		defaultValue: String(DEFAULT_CONFIG.minRequestGapSeconds),
		order: 2,
		currentValue: String(config.minRequestGapSeconds || DEFAULT_CONFIG.minRequestGapSeconds),
	};

	if (units && units.length > 0) {
		units.forEach((unit, idx) => {
			properties[showPropertyId(unit.id)] = {
				dataType: "BOOLEAN",
				friendlyName: `${unit.name || unit.id}`,
				description: `Klima-Innengerät (${unit.connected ? "verbunden" : "getrennt"}) · deviceId ${unit.id.slice(0, 8)}`,
				groupId: "devices",
				defaultValue: "true",
				order: idx + 1,
				currentValue: String(isUnitExposed(config, unit.id)),
			};
		});
	} else {
		properties.devicesHint = {
			dataType: "STRING",
			friendlyName: "Geräte",
			description:
				"Es wurden noch keine Geräte erkannt. Nach dem ersten erfolgreichen Login erscheinen die MELCloud-Geräte hier.",
			groupId: "devices",
			order: 1,
			currentValue: "",
			required: "false",
		};
	}

	properties.status = {
		dataType: "STRING",
		friendlyName: "Verbindungsstatus",
		description: "Letzter Status der MELCloud-Verbindung.",
		groupId: "info",
		order: 1,
		currentValue: statusText || "noch nicht verbunden",
		required: "false",
	};

	return { groups, properties };
}

/** Redacted copy for logs / debug output. */
function redact(config) {
	return {
		...config,
		melPassword: config.melPassword ? "***" : "",
	};
}

module.exports = {
	CONFIG_PATH,
	DEFAULT_CONFIG,
	MIN_POLL_INTERVAL_S,
	load,
	save,
	isConfigured,
	applyUpdate,
	applyShowProps,
	isUnitExposed,
	isDeviceExposed,
	showPropertyId,
	buildTemplate,
	redact,
};
