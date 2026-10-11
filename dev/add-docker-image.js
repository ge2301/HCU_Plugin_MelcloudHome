// Fuegt das Plugin-Logo (PNG) als base64-"image"-Feld in das
// de.eq3.hmip.plugin.metadata-LABEL des Dockerfiles ein (Doku 4.1).
// Aufruf: node dev/add-docker-image.js [pngPfad]
"use strict";
const fs = require("fs");

const png = process.argv[2] || "C:/Users/ge230/Documents/Mitsubishi/logo_wide.png";
const dPath = "C:/Users/ge230/Documents/Mitsubishi/HCU_Plugin_MelcloudHome/Dockerfile";

const b64 = fs.readFileSync(png).toString("base64");
let t = fs.readFileSync(dPath, "utf8");
if (t.includes('"image"')) {
	console.log("ABBRUCH: image-Feld existiert bereits im Dockerfile");
	process.exit(1);
}
const nl = t.includes("\r\n") ? "\r\n" : "\n";
const lines = t.split(/\r?\n/);
const idx = lines.findIndex((l) => l.trim().startsWith('"changelog"'));
if (idx < 0) {
	console.log('ABBRUCH: changelog-Zeile nicht gefunden');
	process.exit(1);
}
lines.splice(idx, 0, '\t"image": "' + b64 + '",\\');
fs.writeFileSync(dPath, lines.join(nl), "utf8");
console.log(`eingefuegt: ${fs.statSync(png).size} PNG-Bytes -> ${b64.length} Base64-Zeichen, neue Zeile ${idx + 1}`);

// Validierung: Docker-Zeilenvfortsetzung zusammenfuegen, JSON parsen
const joined = fs
	.readFileSync(dPath, "utf8")
	.split(/\r?\n/)
	.reduce((acc, l) => (acc.endsWith("\\") ? acc.slice(0, -1) + l : acc + "\n" + l), "");
const m = joined.match(/de\.eq3\.hmip\.plugin\.metadata=\s*\n?'(\{[\s\S]*\})'/);
if (!m) {
	console.log("VALIDIERUNG: LABEL nicht gefunden");
	process.exit(1);
}
const meta = JSON.parse(m[1]);
const back = Buffer.from(meta.image, "base64");
console.log("VALIDIERUNG: JSON gueltig, Felder:", Object.keys(meta).join(", "));
console.log(`VALIDIERUNG: image decodiert ${back.length} Bytes, identisch zur PNG: ${back.equals(fs.readFileSync(png))}`);
