// Prüft das Browser-JS der WebUI SO, wie es nach Template-Auswertung ausgeliefert wird.
"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "plugin", "src", "webui.js"), "utf8");
const start = src.indexOf("const PAGE = ");
if (start < 0) {
	console.error("PAGE-Konstante nicht gefunden");
	process.exit(2);
}
const end = src.indexOf("`;", start);
const m = [null, src.slice(start + "const PAGE = ".length, end + 2)];
if (!m) {
	console.error("PAGE-Konstante nicht gefunden");
	process.exit(2);
}
const html = eval(m[1]); // Template-Literal auswerten wie zur Laufzeit
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
try {
	new Function(js);
	console.log("SERVED JS PARSES OK (" + js.split("\n").length + " Zeilen)");
} catch (e) {
	fs.writeFileSync(path.join(__dirname, "_served.js"), js);
	console.error("SYNTAX ERROR: " + e.message + " — Script nach dev/_served.js geschrieben");
	process.exit(1);
}
