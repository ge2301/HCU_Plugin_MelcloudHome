"use strict";

const logger = require("./logger");
const { BFF_BASE, BFF_UA } = require("./melcloudAuth");

/**
 * MELCloud Home REST client with a central request pacer.
 *
 * Every outbound call to the MELCloud BFF goes through the pacer queue:
 * exactly one request at a time, separated by at least `minGapMs`. This is
 * the single most important measure against account lock-outs.
 */

class ApiError extends Error {
	constructor(message, statusCode) {
		super(message);
		this.name = "ApiError";
		this.statusCode = statusCode;
	}
}

class MelcloudClient {
	constructor({ minGapMs = 2000 } = {}) {
		this.minGapMs = Math.max(1000, minGapMs);
		this._queue = Promise.resolve();
		this._lastRequestAt = 0;
	}

	setMinGapMs(ms) {
		this.minGapMs = Math.max(1000, ms || 2000);
	}

	/** Serialize + pace a request; returns the raw Response. */
	_paced(fn) {
		const run = this._queue.then(async () => {
			const wait = this._lastRequestAt + this.minGapMs - Date.now();
			if (wait > 0) {
				logger.debug(`Pacer: waiting ${wait}ms before next MELCloud request`);
				await new Promise((r) => setTimeout(r, wait));
			}
			this._lastRequestAt = Date.now();
			return fn();
		});
		// Keep the chain alive even when a request fails.
		this._queue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	async _get(accessToken, urlPath) {
		return this._paced(async () => {
			const resp = await fetch(`${BFF_BASE}${urlPath}`, {
				headers: {
					authorization: `Bearer ${accessToken}`,
					"user-agent": BFF_UA,
					accept: "application/json",
				},
				signal: AbortSignal.timeout(30_000),
			});
			return resp;
		});
	}

	/**
	 * GET /context — one single call returning account, buildings and all
	 * units with their current settings and capabilities.
	 * Returns { account, units } (see parseContext). Throws ApiError on failure.
	 */
	async fetchContext(accessToken) {
		const resp = await this._get(accessToken, "/context");
		if (resp.status === 401) throw new ApiError("MELCloud: unauthorized (401)", 401);
		if (resp.status === 429) throw new ApiError("MELCloud: too many requests (429)", 429);
		if (!resp.ok) throw new ApiError(`MELCloud: /context HTTP ${resp.status}`, resp.status);
		return parseContext(await resp.json());
	}

	/**
	 * PUT /monitor/ataunit/{unitId} — partial update; fields set to null are
	 * left unchanged. 200 means "accepted", NOT "applied" — the new state
	 * becomes visible on the next /context poll.
	 */
	async putAtaUnit(accessToken, unitId, partial) {
		return this._paced(async () => {
			const resp = await fetch(`${BFF_BASE}/monitor/ataunit/${encodeURIComponent(unitId)}`, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${accessToken}`,
					"user-agent": BFF_UA,
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify(partial),
				signal: AbortSignal.timeout(30_000),
			});
			if (resp.status === 401) throw new ApiError("MELCloud: unauthorized (401)", 401);
			if (resp.status === 429) throw new ApiError("MELCloud: too many requests (429)", 429);
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				throw new ApiError(
					`MELCloud: PUT ataunit HTTP ${resp.status} ${text.slice(0, 150)}`,
					resp.status
				);
			}
			return true;
		});
	}
}

/* ------------------------------ parsing -------------------------------------- */

function asFloat(v) {
	const n = parseFloat(String(v).replace(",", "."));
	return Number.isFinite(n) ? n : null;
}

function asBool(v) {
	return String(v).toLowerCase() === "true";
}

/**
 * The real /context payload carries the unit state as
 *   settings: [ { name: "RoomTemperature", value: "23.5" }, ... ]
 * (PascalCase names, string values) — NOT as a state object.
 */
function settingsToState(settings) {
	const raw = {};
	for (const s of settings || []) raw[s.name] = s.value;
	return {
		roomTemperature: asFloat(raw.RoomTemperature),
		setTemperature: asFloat(raw.SetTemperature),
		power: raw.Power !== undefined ? asBool(raw.Power) : null,
		operationMode: raw.OperationMode ?? null, // "Heat"|"Cool"|"Automatic"|"Dry"|"Fan"
		setFanSpeed: raw.SetFanSpeed ?? null,
		actualFanSpeed: raw.ActualFanSpeed ?? null,
		vaneVertical: raw.VaneVerticalDirection ?? null,
		vaneHorizontal: raw.VaneHorizontalDirection ?? null,
		inStandby: raw.InStandbyMode !== undefined ? asBool(raw.InStandbyMode) : null,
		isInError: raw.IsInError !== undefined ? asBool(raw.IsInError) : null,
		errorCode: raw.ErrorCode || null,
	};
}

function parseContext(json) {
	const units = [];
	for (const b of json.buildings || []) {
		for (const u of b.airToAirUnits || []) {
			units.push({
				id: u.id,
				buildingName: b.name || "",
				name: u.givenDisplayName || u.displayIcon || `MELCloud ${u.id.slice(0, 8)}`,
				timeZone: u.timeZone || null,
				connected: u.isConnected !== false,
				isInError: u.isInError === true,
				rssi: u.rssi ?? null,
				capabilities: u.capabilities || {},
				state: settingsToState(u.settings),
			});
		}
		// ATW (Ecodan) units are ignored in V1 but counted for diagnostics.
		for (const u of b.airToWaterUnits || []) {
			units.push({
				id: u.id,
				buildingName: b.name || "",
				name: u.givenDisplayName || `ATW ${u.id.slice(0, 8)}`,
				kind: "atw",
				connected: u.isConnected !== false,
				capabilities: u.capabilities || {},
				state: null, // ATW mapping: Phase 2+
			});
		}
	}
	return {
		account: { email: json.email || null, name: json.firstname || null },
		units,
	};
}

module.exports = { MelcloudClient, ApiError, parseContext, settingsToState };
