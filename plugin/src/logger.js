"use strict";

/**
 * Minimal timestamped logger. Levels can be filtered through the LOG_LEVEL
 * environment variable (error | warn | info | debug). Defaults to "info".
 *
 * IMPORTANT: never log the MELCloud password.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function ts() {
	return new Date().toISOString();
}

function log(level, ...args) {
	if (LEVELS[level] > currentLevel) return;
	const line = `[${ts()}] [${level.toUpperCase()}]`;
	if (level === "error") {
		console.error(line, ...args);
	} else if (level === "warn") {
		console.warn(line, ...args);
	} else {
		console.log(line, ...args);
	}
}

module.exports = {
	error: (...a) => log("error", ...a),
	warn: (...a) => log("warn", ...a),
	info: (...a) => log("info", ...a),
	debug: (...a) => log("debug", ...a),
};
