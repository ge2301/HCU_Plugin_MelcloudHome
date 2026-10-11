"use strict";

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");

/**
 * Manages the WebSocket connection to the HCU Connect API.
 *
 * The class is intentionally passive about business logic: it delegates to the
 * callbacks provided in the constructor.
 *
 * Callbacks:
 *   - getReadiness()            -> "READY" | "CONFIG_REQUIRED" | "ERROR"
 *   - getDevices()              -> array of Device objects (full status)
 *   - getConfigTemplate()       -> { groups, properties }
 *   - onConfigUpdate(props)     -> Promise<{ status, message }>
 *   - onControlRequest(body)    -> Promise<{ success, error? }>  (optional)
 */
class HcuClient {
	constructor({ pluginId, host, authToken, callbacks }) {
		this.pluginId = pluginId;
		this.host = host;
		this.authToken = authToken;
		this.callbacks = callbacks;
		this.ws = null;
		this.connected = false;
		this.reconnectDelayMs = 2000;
		this.maxReconnectDelayMs = 30000;
		this.shouldRun = true;
		// Device IDs that HCU has confirmed via STATUS_REQUEST.
		// STATUS_EVENT is only sent for these devices to avoid "Device not found".
		this.knownDeviceIds = new Set();
	}

	connect() {
		const url = `wss://${this.host}:9001`;
		logger.info(`Connecting to HCU Connect API at ${url} (plugin ${this.pluginId})`);

		// Reset known devices on each fresh connection — HCU may have reset state.
		this.knownDeviceIds.clear();

		this.ws = new WebSocket(url, {
			rejectUnauthorized: false,
			headers: {
				authtoken: this.authToken,
				"plugin-id": this.pluginId,
			},
		});

		this.ws.on("open", () => {
			this.connected = true;
			this.reconnectDelayMs = 2000;
			logger.info("Connected to HCU WebSocket");
			this._sendPluginState(uuidv4());
		});

		this.ws.on("message", (data) => this._handleMessage(data));

		this.ws.on("close", (code, reason) => {
			this.connected = false;
			logger.warn(`HCU WebSocket closed (code ${code}${reason ? `, ${reason}` : ""})`);
			this._scheduleReconnect();
		});

		this.ws.on("error", (err) => {
			logger.error(`HCU WebSocket error: ${err.code || ""} ${err.message || err}`);
		});
	}

	_scheduleReconnect() {
		if (!this.shouldRun) return;
		const delay = this.reconnectDelayMs;
		this.reconnectDelayMs = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * 2);
		logger.info(`Reconnecting to HCU in ${Math.round(delay / 1000)}s`);
		setTimeout(() => this.connect(), delay);
	}

	stop() {
		this.shouldRun = false;
		if (this.ws) this.ws.close();
	}

	_send(message) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			logger.debug(`Skipped sending ${message.type}: socket not open`);
			return false;
		}
		this.ws.send(JSON.stringify(message));
		logger.debug(`Sent ${message.type}`);
		return true;
	}

	_envelope(id, type, body, requestId) {
		const msg = { id: id || uuidv4(), pluginId: this.pluginId, type, body };
		// The rollladen reference plugin echoes the request id in an extra
		// "requestId" field (and the HCU accepts it) — send both forms.
		if (requestId) msg.requestId = requestId;
		return msg;
	}

	/** Device objects as sent to the HCU (reference plugin adds reachable). */
	static _wireDevices(devices) {
		return (devices || []).map((d) => ({ reachable: true, ...d }));
	}

	_sendPluginState(id) {
		const readiness = this.callbacks.getReadiness();
		this._send(this._envelope(id, "PLUGIN_STATE_RESPONSE", { pluginReadinessStatus: readiness }));
		logger.info(`Reported plugin readiness: ${readiness}`);
	}

	_sendDiscover(id) {
		const devices = HcuClient._wireDevices(this.callbacks.getDevices());
		this._send(this._envelope(id, "DISCOVER_RESPONSE", { success: true, devices }, id));
		logger.info(`Answered DISCOVER_REQUEST with ${devices.length} device(s)`);
	}

	/**
	 * Proactively (re-)announce the current device list. Needed because the
	 * HCU sends DISCOVER_REQUEST immediately on connect — possibly before our
	 * first cloud poll has delivered devices. Harmless if the HCU ignores it.
	 */
	announceDevices() {
		if (!this.connected) return;
		this._sendDiscover(uuidv4());
	}

	_sendStatusResponse(id, requestedIds) {
		let devices = HcuClient._wireDevices(this.callbacks.getDevices());
		if (Array.isArray(requestedIds) && requestedIds.length > 0) {
			const set = new Set(requestedIds);
			devices = devices.filter((d) => set.has(d.deviceId));
			for (const did of requestedIds) this.knownDeviceIds.add(did);
		} else {
			for (const d of devices) this.knownDeviceIds.add(d.deviceId);
		}
		this._send(this._envelope(id, "STATUS_RESPONSE", { success: true, devices }, id));
		logger.info(`Answered STATUS_REQUEST with ${devices.length} device(s), known=${this.knownDeviceIds.size}`);
	}

	_sendConfigTemplate(id) {
		const body = this.callbacks.getConfigTemplate();
		this._send(this._envelope(id, "CONFIG_TEMPLATE_RESPONSE", body, id));
		logger.info("Answered CONFIG_TEMPLATE_REQUEST");
	}

	async _handleConfigUpdate(id, body) {
		try {
			const result = await this.callbacks.onConfigUpdate(body ? body.properties : {});
			this._send(
				this._envelope(
					id,
					"CONFIG_UPDATE_RESPONSE",
					{ status: result.status || "APPLIED", message: result.message || "" },
					id
				)
			);
			logger.info(`Answered CONFIG_UPDATE_REQUEST: ${result.status}`);
			// Reflect any readiness change immediately.
			this._sendPluginState(uuidv4());
		} catch (err) {
			logger.error(`Config update failed: ${err.message}`);
			this._send(
				this._envelope(id, "CONFIG_UPDATE_RESPONSE", { status: "FAILED", message: err.message }, id)
			);
		}
	}

	async _handleControlRequest(id, body) {
		const respond = (result) => {
			const msgBody = { deviceId: body ? body.deviceId : undefined, success: !!result.success };
			if (!result.success && result.error) msgBody.error = result.error;
			this._send(this._envelope(id, "CONTROL_RESPONSE", msgBody, id));
		};
		if (!this.callbacks.onControlRequest) {
			respond({
				success: false,
				error: { code: "FEATURE_NOT_SUPPORTED", message: "control not supported" },
			});
			return;
		}
		try {
			respond(await this.callbacks.onControlRequest(body));
		} catch (err) {
			logger.error(`Control request failed: ${err.message}`);
			respond({ success: false, error: { code: "CONTROL_FAILED", message: err.message } });
		}
	}

	_handleMessage(data) {
		let message;
		try {
			message = JSON.parse(data);
		} catch (err) {
			logger.error(`Failed to parse incoming message: ${err.message}`);
			return;
		}
		logger.debug(`Received ${message.type}`);

		switch (message.type) {
			case "PLUGIN_STATE_REQUEST":
				this._sendPluginState(message.id);
				break;
			case "DISCOVER_REQUEST":
				this._sendDiscover(message.id);
				break;
			case "STATUS_REQUEST":
				this._sendStatusResponse(message.id, message.body ? message.body.deviceIds : null);
				break;
			case "CONFIG_TEMPLATE_REQUEST":
				this._sendConfigTemplate(message.id);
				break;
			case "CONFIG_UPDATE_REQUEST":
				this._handleConfigUpdate(message.id, message.body);
				break;
			case "CONTROL_REQUEST":
				this._handleControlRequest(message.id, message.body);
				break;
			case "INCLUSION_EVENT": {
				// The HCU reports which plugin devices were included into the
				// home. Push their current values immediately (the reference
				// plugin likewise forces STATUS_EVENT right after discover).
				const ids = (message.body && message.body.deviceIds) || [];
				logger.info(`INCLUSION_EVENT for ${ids.length} device(s): ${ids.join(", ") || "-"}`);
				for (const id of ids) this.knownDeviceIds.add(id);
				const byId = new Map(this.callbacks.getDevices().map((d) => [d.deviceId, d]));
				const events = [];
				for (const id of ids) {
					const d = byId.get(id);
					if (d) events.push({ deviceId: id, features: d.features });
				}
				if (events.length) this.sendStatusEvents(events);
				break;
			}
			case "ERROR_RESPONSE":
				logger.warn(`HCU reported an error: ${JSON.stringify(message.body)}`);
				break;
			default:
				logger.debug(`Ignoring unhandled message type: ${message.type}`);
		}
	}

	/**
	 * Pushes a partial status update for the given devices.
	 * STATUS_EVENT is sent unconditionally — the rollladen reference plugin
	 * does the same, the HCU simply ignores events for unknown devices.
	 * @param {Array<{deviceId: string, features: Array}>} deviceUpdates
	 */
	sendStatusEvents(deviceUpdates) {
		let sent = 0;
		for (const update of deviceUpdates) {
			this._send(this._envelope(uuidv4(), "STATUS_EVENT", update));
			sent++;
		}
		if (sent > 0) logger.debug(`Pushed status events for ${sent} device(s)`);
	}

	/** Sends the current plugin readiness proactively (e.g. after a poll failure). */
	pushReadiness() {
		if (this.connected) this._sendPluginState(uuidv4());
	}
}

module.exports = HcuClient;
