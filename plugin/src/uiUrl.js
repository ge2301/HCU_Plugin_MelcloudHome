"use strict";

/**
 * Host/URL of the embedded WebUI exactly as it must appear in the "WebUI öffnen"
 * WEBLINK of the HCU configuration page.
 *
 * Why this is not trivial: inside the plugin container
 *   - the argv HCU host is the alias "host.containers.internal" (only valid
 *     inside the container's network namespace) and
 *   - /etc/hostname contains the container id (e.g. b88b413aa83c),
 * neither of which a LAN browser can resolve. The HCU's LAN name is its mDNS
 * name "hcu1-XXXX.local", where XXXX are the last four digits of the SGTIN
 * (Connect API 1.0.1 §2.1). The HCU mounts that SGTIN into every plugin
 * container at /SGTIN (§4.2 "Container environment") and maps exposed ports
 * 1:1, so http://hcu1-xxxx.local:<exposedPort> is the reachable URL. The
 * working rollladen reference plugin builds its link the same way.
 */

const fs = require("fs");

/** Documented location plus fallbacks (local runs, alternative mounts). */
const SGTIN_FILES = ["/SGTIN", "/data/SGTIN", "./SGTIN"];

/** "hcu1-<last 4 of sgtin>.local" or "" when the SGTIN is unknown. */
function hcuHostFromSgtin(sgtin) {
	const s = String(sgtin || "").trim();
	if (s.length < 4) return "";
	return `hcu1-${s.slice(-4).toLowerCase()}.local`;
}

/**
 * Normalise a user/dev supplied host into "host[:port]" (or "https://host:port").
 * Accepts "hcu1-abcd.local", "192.168.1.20", "192.168.1.20:5300", "http://host/",
 * "https://host:8443/x". An explicit port is kept, otherwise defaultPort is
 * appended. Returns "" for empty or unparsable input.
 */
function normalizeHostSpec(value, defaultPort) {
	let v = String(value || "").trim();
	if (!v) return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
	let url;
	try {
		url = new URL(v);
	} catch {
		return "";
	}
	if (!url.hostname) return "";
	const secure = url.protocol === "https:";
	let host = url.hostname;
	if (url.port) host = `${host}:${url.port}`;
	else if (defaultPort) host = `${host}:${defaultPort}`;
	return secure ? `https://${host}` : host;
}

/** "hcu1-xxxx.local:port" or "". */
function sgtinSpec(sgtin, port) {
	const h = hcuHostFromSgtin(sgtin);
	return h ? `${h}:${port}` : "";
}

/**
 * Resolve the base URL of the WebUI for the HCU config page.
 *
 * @param {object} opts
 * @param {string} [opts.override]     manual host from the HCU config form
 * @param {string} [opts.envHost]      WEBUI_HOST environment variable
 * @param {string} [opts.argvHost]     HCU host from argv (dev runs use a real name)
 * @param {string} [opts.sgtin]        SGTIN already read from the container
 * @param {number} opts.port           exposed WebUI port
 * @param {string} [opts.internalHost] host alias that must never end up in the link
 * @returns {string} e.g. "http://hcu1-e60b.local:5300", or "" when not determinable
 */
function resolveUiBaseUrl({
	override,
	envHost,
	argvHost,
	sgtin,
	port,
	internalHost = "host.containers.internal",
} = {}) {
	const spec =
		normalizeHostSpec(override, port) ||
		normalizeHostSpec(envHost, port) ||
		sgtinSpec(sgtin, port) ||
		normalizeHostSpec(argvHost === internalHost ? "" : argvHost, port);
	if (!spec) return "";
	return /^https?:\/\//i.test(spec) ? spec : `http://${spec}`;
}

/** Read the SGTIN from the container filesystem ("" when it is not mounted). */
function readSgtin(readFileSync = fs.readFileSync, files = SGTIN_FILES) {
	for (const p of files) {
		try {
			const s = String(readFileSync(p, "utf8") || "").trim();
			if (s) return s;
		} catch {
			/* candidate not present — try the next one */
		}
	}
	return "";
}

module.exports = { SGTIN_FILES, hcuHostFromSgtin, normalizeHostSpec, resolveUiBaseUrl, readSgtin };
