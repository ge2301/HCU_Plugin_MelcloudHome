// Prueft die Adresse, die der Link "WebUI öffnen" in der HCU-Konfiguration
// bekommt. Wichtigster Fall: Der Plugin-Container kennt nur den Alias
// "host.containers.internal" und die eigene Container-ID (z. B. b88b413aa83c) —
// beides kann kein Browser im LAN aufloesen. Richtig ist der mDNS-Name der HCU
// (http://hcu1-xxxx.local:<Port>, xxxx = letzte 4 Stellen des SGTIN aus /SGTIN).
//
// Aufruf: node dev\check-ui-url.js

"use strict";
const assert = require("assert");
const {
	hcuHostFromSgtin,
	normalizeHostSpec,
	resolveUiBaseUrl,
	readSgtin,
} = require("../plugin/src/uiUrl");

const P = 5300;

// SGTIN -> mDNS-Name der HCU
assert.strictEqual(hcuHostFromSgtin("3014F789ABCDEF0000ABCD"), "hcu1-abcd.local");
assert.strictEqual(hcuHostFromSgtin("  3014F789ABCD  "), "hcu1-abcd.local");
assert.strictEqual(hcuHostFromSgtin("abc"), "");
assert.strictEqual(hcuHostFromSgtin(""), "");

// Host-Eingaben (Feld "Host der WebUI", WEBUI_HOST, argv)
assert.strictEqual(normalizeHostSpec("", P), "");
assert.strictEqual(normalizeHostSpec("192.168.1.20", P), "192.168.1.20:5300");
assert.strictEqual(normalizeHostSpec("hcu1-abcd.local", P), "hcu1-abcd.local:5300");
assert.strictEqual(normalizeHostSpec("hcu1-abcd.local:8080", P), "hcu1-abcd.local:8080");
assert.strictEqual(normalizeHostSpec("http://hcu1-abcd.local:8080/", P), "hcu1-abcd.local:8080");
assert.strictEqual(normalizeHostSpec("https://host.lan:8443/config", P), "https://host.lan:8443");
assert.strictEqual(normalizeHostSpec("not a host!", P), "");

// Fall 1: Plugin laeuft auf der HCU (argv host ist der interne Alias) -> SGTIN
assert.strictEqual(
	resolveUiBaseUrl({ argvHost: "host.containers.internal", sgtin: "3014F789ABCD", port: P }),
	"http://hcu1-abcd.local:5300"
);

// Fall 2: manuelles Feld im Konfigurationsformular gewinnt
assert.strictEqual(
	resolveUiBaseUrl({
		override: "192.168.1.20",
		argvHost: "host.containers.internal",
		sgtin: "3014F789ABCD",
		port: P,
	}),
	"http://192.168.1.20:5300"
);

// Fall 3: WEBUI_HOST nach dem Formularfeld, vor dem SGTIN
assert.strictEqual(
	resolveUiBaseUrl({
		envHost: "hcu.local",
		argvHost: "host.containers.internal",
		sgtin: "3014F789ABCD",
		port: P,
	}),
	"http://hcu.local:5300"
);

// Fall 4: lokaler Testlauf gegen echten HCU-Namen, ohne SGTIN-Datei
assert.strictEqual(resolveUiBaseUrl({ argvHost: "hcu1-e60b.local", port: P }), "http://hcu1-e60b.local:5300");

// Fall 5: nichts ermittelbar -> leer, die Konfigurationsseite zeigt dann
// keinen kaputten Link, sondern den Hinweis auf das Host-Feld
assert.strictEqual(resolveUiBaseUrl({ argvHost: "host.containers.internal", port: P }), "");

// Die Container-ID darf niemals im Link landen
const link = resolveUiBaseUrl({ argvHost: "host.containers.internal", sgtin: "3014F789ABCD", port: P });
assert.ok(!link.includes("containers.internal"), "interner Alias im Link");
assert.ok(!/\/\/[0-9a-f]{12}:/.test(link), "Container-ID im Link");

// SGTIN-Dateien: erste vorhandene gewinnt, /SGTIN ist der dokumentierte Ort
assert.strictEqual(
	readSgtin((p) => {
		const files = { "/SGTIN": "3014F789ABCD\n", "/data/SGTIN": "ANDERER" };
		if (files[p] !== undefined) return files[p];
		throw new Error("ENOENT");
	}),
	"3014F789ABCD"
);
assert.strictEqual(
	readSgtin((p) => {
		if (p === "/data/SGTIN") return "  ZZ99  ";
		throw new Error("ENOENT");
	}),
	"ZZ99"
);
assert.strictEqual(
	readSgtin(() => {
		throw new Error("ENOENT");
	}),
	""
);

console.log("WEBUI-URL-PRUEFUNG OK — Link auf der HCU-Seite: " + link);
