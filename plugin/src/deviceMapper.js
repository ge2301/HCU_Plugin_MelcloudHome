"use strict";

const configModule = require("./config");

/**
 * Maps parsed MELCloud Home units into Homematic IP Connect API devices.
 *
 * Each ATA air-conditioner unit becomes TWO plugin devices, because the
 * Connect API device archetypes each cover only part of an AC's surface:
 *
 *   <Name> Klima    THERMOSTAT  -> setPointTemperature (W), actualTemperature (R)
 *   <Name> An/Aus  SWITCH      -> switchState (W)
 *
 * The operating mode is deliberately NOT exposed to the HCU: the HEAT_PUMP
 * archetype always demands two fixed partner connections (heat source /
 * heating surface) in the Homematic app and is unusable as a standalone
 * mode selector. Mode changes stay available in the plugin WebUI only.
 * A CONTROL_REQUEST carrying climateOperationMode (e.g. from a stale
 * inclusion) is still honoured via CONNECT_TO_MODE.
 */

const MODEL_TYPE = "MLC-AIRCON";
const FIRMWARE_VERSION = "1.0.0";

/** MELCloud OperationMode -> Connect API ClimateOperationType */
const MODE_TO_CONNECT = {
	Heat: "HEATING",
	Cool: "COOLING",
	Automatic: "AUTO",
	Dry: "AUTO", // not expressible; closest honest value
	Fan: "AUTO",
};

/** Connect API ClimateOperationType -> MELCloud OperationMode (for CONTROL) */
const CONNECT_TO_MODE = {
	HEATING: "Heat",
	COOLING: "Cool",
	AUTO: "Automatic",
};

function climateDeviceId(unitId) {
	return `mc-${unitId}`;
}
function powerDeviceId(unitId) {
	return `mc-${unitId}-power`;
}
function modeDeviceId(unitId) {
	return `mc-${unitId}-mode`;
}

function baseName(unit) {
	return unit.name || `MELCloud ${String(unit.id).slice(0, 8)}`;
}

function round1(v) {
	return v == null ? null : Math.round(v * 2) / 2; // 0.5 steps
}

function thermostatFeatures(unit) {
	const features = [];
	const st = unit.state || {};
	if (st.setTemperature != null) {
		features.push({ type: "setPointTemperature", setPointTemperature: st.setTemperature });
	}
	if (st.roomTemperature != null) {
		features.push({ type: "actualTemperature", actualTemperature: st.roomTemperature });
	}
	return features;
}

function switchFeatures(unit) {
	const st = unit.state || {};
	if (st.power == null) return [];
	return [{ type: "switchState", on: st.power }];
}

/** All devices for one unit (respects the per-device expose switch). */
function unitDevices(unit, config) {
	if (!configModule.isUnitExposed(config, unit.id) || unit.kind === "atw" || !unit.state) {
		return [];
	}
	const devices = [];
	const climate = thermostatFeatures(unit);
	if (climate.length && configModule.isDeviceExposed(config, climateDeviceId(unit.id))) {
		devices.push({
			deviceId: climateDeviceId(unit.id),
			deviceType: "THERMOSTAT",
			modelType: MODEL_TYPE,
			firmwareVersion: FIRMWARE_VERSION,
			friendlyName: `${baseName(unit)} Klima`,
			features: climate,
		});
	}
	const sw = switchFeatures(unit);
	if (sw.length && configModule.isDeviceExposed(config, powerDeviceId(unit.id))) {
		devices.push({
			deviceId: powerDeviceId(unit.id),
			deviceType: "SWITCH",
			modelType: MODEL_TYPE,
			firmwareVersion: FIRMWARE_VERSION,
			friendlyName: `${baseName(unit)} An/Aus`,
			features: sw,
		});
	}
	// No HEAT_PUMP device — see file header: the archetype requires fixed
	// connections in the Homematic app and is unusable for a mode selector.
	return devices;
}

/** DISCOVER_RESPONSE / STATUS_RESPONSE device list. */
function buildDevices(units, config) {
	const devices = [];
	for (const unit of units || []) devices.push(...unitDevices(unit, config));
	return devices;
}

/**
 * Delta detection: compares the feature sets of the new device list against
 * the previous one and returns only changed devices as STATUS_EVENT payloads.
 *
 * @param {Array} units     - freshly parsed units
 * @param {object} config   - plugin config
 * @param {Map} prevById    - Map<deviceId, features[]> of the last sent state
 * @returns {{ events: Array, nextById: Map }}
 */
function buildStatusEvents(units, config, prevById) {
	const nextById = new Map();
	const events = [];
	const devices = buildDevices(units, config);
	for (const device of devices) {
		nextById.set(
			device.deviceId,
			device.features.map((f) => JSON.stringify(f))
		);
	}
	const prev = prevById || new Map();
	for (const device of devices) {
		const now = nextById.get(device.deviceId);
		const before = prev.get(device.deviceId);
		if (before && JSON.stringify(now) === JSON.stringify(before)) continue;
		events.push({ deviceId: device.deviceId, features: device.features });
	}
	return { events, nextById };
}

/**
 * Converts the features of a CONTROL_REQUEST into the MELCloud Home partial
 * update payload (camelCase). Unknown feature types are ignored; if nothing
 * is supported the result has no keys.
 * @param {Array} features - body.features of the CONTROL_REQUEST
 */
function controlFeaturesToPartial(features) {
	const partial = {};
	for (const f of features || []) {
		if (f.type === "switchState") partial.power = f.on === true;
		else if (f.type === "setPointTemperature") partial.setTemperature = Number(f.setPointTemperature);
		else if (f.type === "climateOperationMode") {
			const mode = CONNECT_TO_MODE[f.climateOperationMode];
			if (mode) partial.operationMode = mode;
		}
	}
	return partial;
}

/** Resolve a deviceId back to its MELCloud unit + feature semantics. */
function resolveControlTarget(deviceId) {
	if (deviceId.endsWith("-power")) {
		return { unitId: deviceId.slice(3, -"-power".length), kind: "power" };
	}
	if (deviceId.endsWith("-mode")) {
		return { unitId: deviceId.slice(3, -"-mode".length), kind: "mode" };
	}
	if (deviceId.startsWith("mc-")) {
		return { unitId: deviceId.slice(3), kind: "temperature" };
	}
	return null;
}

module.exports = {
	MODEL_TYPE,
	MODE_TO_CONNECT,
	CONNECT_TO_MODE,
	climateDeviceId,
	powerDeviceId,
	modeDeviceId,
	buildDevices,
	buildStatusEvents,
	resolveControlTarget,
	controlFeaturesToPartial,
	round1,
};
