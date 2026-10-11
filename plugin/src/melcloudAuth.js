"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");

/**
 * MELCloud Home authentication (OAuth2 Authorization Code + PKCE via
 * IdentityServer "auth.melcloudhome.com" with federated AWS Cognito login).
 *
 * Reverse-engineered from the official mobile app flow and verified with a
 * read-only spike (see spike/spike.js). The flow:
 *
 *   1. POST /connect/par            -> request_uri
 *   2. GET  /connect/authorize      -> ... -> Cognito /login page (_csrf)
 *   3. POST Cognito /login          -> redirect chain -> /connect/authorize/callback
 *   4. GET  /connect/authorize/callback -> melcloudhome://...?code=...
 *   5. POST /connect/token          -> access_token (3600 s) + refresh_token
 *
 * Tokens are persisted so container restarts never trigger a fresh Cognito
 * login (the most expensive/auth-sensitive path). Passwords are never logged.
 */

const AUTH_BASE = "https://auth.melcloudhome.com";
const BFF_BASE = "https://mobile.bff.melcloudhome.com";
const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";
const SCOPES = "openid profile email offline_access IdentityServerApi";
const BFF_UA = "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";
const BROWSER_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76";
const FORM_TYPE = "application/x-www-form-urlencoded";
const REFRESH_BUFFER_MS = 60_000;

// /data is the plugin directory that the HCU keeps across updates/restarts.
const TOKENS_PATH = process.env.MELCLOUD_TOKENS_PATH || "/data/tokens.json";

class AuthError extends Error {
	constructor(message, kind) {
		super(message);
		this.name = "AuthError";
		this.kind = kind || "auth"; // auth | network
	}
}

/* ------------------------------ token storage -------------------------------- */

function loadTokens() {
	try {
		if (fs.existsSync(TOKENS_PATH)) {
			return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
		}
	} catch (err) {
		logger.warn(`Could not read tokens file: ${err.message}`);
	}
	return null;
}

function saveTokens(tokens) {
	try {
		fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
		fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch (err) {
		logger.warn(`Could not persist tokens: ${err.message}`);
	}
}

function clearTokens() {
	try {
		if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
		logger.info("Cleared stored MELCloud tokens");
	} catch (err) {
		logger.warn(`Could not delete tokens file: ${err.message}`);
	}
}

function tokenExpiryMs(tokens) {
	return (tokens.expiresAt || 0) - REFRESH_BUFFER_MS;
}

/* ------------------------------ HTTP plumbing -------------------------------- */

function createJar() {
	const jar = new Map();
	return {
		absorb(resp) {
			const raw =
				typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
			for (const line of raw) {
				const pair = line.split(";")[0];
				const idx = pair.indexOf("=");
				if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
			}
		},
		header() {
			return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
		},
	};
}

function redact(url) {
	return String(url)
		.replace(/([?&])(code|state|request_uri)=([^&]*)/g, "$1$2=***")
		.slice(0, 160);
}

async function req(url, opts = {}, jar = createJar()) {
	const headers = { ...(opts.headers || {}) };
	const cookie = jar.header();
	if (cookie) headers["cookie"] = cookie;
	let resp;
	try {
		resp = await fetch(url, {
			method: opts.method || "GET",
			headers,
			body: opts.body,
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw new AuthError(`Network error calling ${redact(url)}: ${err.message}`, "network");
	}
	jar.absorb(resp);
	logger.debug(`MELCLOUD ${opts.method || "GET"} ${redact(url)} -> ${resp.status}`);
	return resp;
}

function formBody(obj) {
	return new URLSearchParams(obj).toString();
}

function pkce() {
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function extractCsrf(html) {
	const m =
		html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/) ||
		html.match(/name="_csrf"\s+value="([^"]+)"/) ||
		html.match(/<input[^>]+value="([^"]+)"[^>]+name="_csrf"/);
	return m ? m[1] : null;
}

/** Follows manual redirects until a melcloudhome://...?code= URL appears. */
async function followUntilCode(startUrl, jar, opts = {}, maxHops = 10) {
	let url = startUrl;
	for (let i = 0; i < maxHops; i++) {
		const resp = await req(url, opts, jar);
		const loc = resp.headers.get("location") || "";
		if (loc.startsWith(REDIRECT_URI)) {
			const m = loc.match(/[?&]code=([^&]+)/);
			if (!m) throw new AuthError("Redirect without authorization code");
			return { code: m[1] };
		}
		if (loc && (/^https?:/i.test(loc) || loc.startsWith("//") || loc.startsWith("/"))) {
			url = new URL(loc, url).toString();
			opts = { ...opts, method: "GET", body: undefined };
			continue;
		}
		const body = await resp.text();
		return { html: body, url, status: resp.status };
	}
	throw new AuthError("Too many redirects during login");
}

/* ------------------------------ full login ----------------------------------- */

async function fullLogin(email, password) {
	logger.info("Performing full MELCloud Home login");
	const jar = createJar();
	const { verifier, challenge } = pkce();
	const state = crypto.randomBytes(16).toString("base64url");

	// 1. PAR
	const parResp = await req(
		`${AUTH_BASE}/connect/par`,
		{
			method: "POST",
			body: formBody({
				response_type: "code",
				state,
				code_challenge: challenge,
				code_challenge_method: "S256",
				client_id: CLIENT_ID,
				scope: SCOPES,
				redirect_uri: REDIRECT_URI,
			}),
			headers: { "user-agent": BFF_UA, "content-type": FORM_TYPE },
		},
		jar
	);
	if (parResp.status !== 201) {
		throw new AuthError(`PAR failed (HTTP ${parResp.status})`);
	}
	const { request_uri } = await parResp.json();

	// 2. authorize -> either an existing session yields the code, or we land on Cognito
	let url = `${AUTH_BASE}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(request_uri)}`;
	let authCode = null;
	let loginPage = null;
	for (let i = 0; i < 8 && !authCode && !loginPage; i++) {
		const r = await followUntilCode(url, jar, { headers: { "user-agent": BROWSER_UA } });
		if (r.code) {
			authCode = r.code;
			break;
		}
		if (/\.amazoncognito\.com\/login/.test(r.url)) {
			loginPage = r;
			break;
		}
		const cb = r.html && r.html.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
		if (cb) {
			url = `${AUTH_BASE}/connect/authorize/callback?${cb[1].replace(/&amp;/g, "&")}`;
			continue;
		}
		throw new AuthError(`Unexpected login landing: ${redact(r.url)} (HTTP ${r.status})`);
	}

	// 3./4. Cognito credential POST -> code
	if (loginPage) {
		const csrf = extractCsrf(loginPage.html);
		if (!csrf) throw new AuthError("No CSRF token on Cognito login page");
		const host = new URL(loginPage.url).hostname;
		const r = await followUntilCode(
			loginPage.url,
			jar,
			{
				method: "POST",
				body: formBody({ _csrf: csrf, username: email, password, cognitoAsfData: "" }),
				headers: {
					"content-type": FORM_TYPE,
					origin: `https://${host}`,
					referer: loginPage.url,
					"user-agent": BROWSER_UA,
				},
			}
		);
		if (r.code) {
			authCode = r.code;
		} else {
			const cb = r.html && r.html.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
			if (!cb) {
				if (r.url.includes("amazoncognito.com")) {
					throw new AuthError(
						"Login von MELCloud abgelehnt (E-Mail/Passwort falsch oder kein MELCloud-Home-Konto?)"
					);
				}
				throw new AuthError(`No callback in login response (HTTP ${r.status})`);
			}
			const qs = cb[1].replace(/&amp;/g, "&");
			const r2 = await followUntilCode(
				`${AUTH_BASE}/connect/authorize/callback?${qs}`,
				jar,
				{ headers: { "user-agent": BROWSER_UA } }
			);
			if (!r2.code) throw new AuthError("Authorize callback did not yield a code");
			authCode = r2.code;
		}
	}
	if (!authCode) throw new AuthError("Login produced no authorization code");

	// 5. token exchange
	return exchangeCode(jar, authCode, verifier);
}

async function exchangeCode(jar, code, codeVerifier) {
	const resp = await req(
		`${AUTH_BASE}/connect/token`,
		{
			method: "POST",
			body: formBody({
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: codeVerifier,
				client_id: CLIENT_ID,
			}),
			headers: { "user-agent": BFF_UA, "content-type": FORM_TYPE },
		},
		jar
	);
	if (resp.status !== 200) {
		throw new AuthError(`Token exchange failed (HTTP ${resp.status})`);
	}
	return toTokenSet(await resp.json());
}

async function refreshTokens(refreshToken) {
	logger.info("Refreshing MELCloud access token");
	const jar = createJar();
	const resp = await req(
		`${AUTH_BASE}/connect/token`,
		{
			method: "POST",
			body: formBody({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
			headers: { "user-agent": BFF_UA, "content-type": FORM_TYPE },
		},
		jar
	);
	if (resp.status !== 200) {
		throw new AuthError(`Token refresh failed (HTTP ${resp.status})`);
	}
	return toTokenSet(await resp.json());
}

function toTokenSet(tok) {
	if (!tok.access_token) throw new AuthError("Token response without access_token");
	return {
		accessToken: tok.access_token,
		refreshToken: tok.refresh_token || null,
		expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
	};
}

/* ------------------------------ public API ----------------------------------- */

/**
 * Returns a valid access token, using (in this order):
 *   stored non-expired token -> stored refresh token -> full Cognito login.
 * Persists any new token set. Throws AuthError when credentials are wrong.
 */
async function getAccessToken(email, password) {
	let tokens = loadTokens();
	if (tokens && tokens.accessToken && Date.now() < tokenExpiryMs(tokens)) {
		return tokens.accessToken;
	}
	if (tokens && tokens.refreshToken) {
		try {
			tokens = await refreshTokens(tokens.refreshToken);
			saveTokens(tokens);
			return tokens.accessToken;
		} catch (err) {
			logger.warn(`Refresh failed (${err.message}), trying full login`);
			clearTokens();
		}
	}
	if (!email || !password) throw new AuthError("MELCloud credentials not configured");
	tokens = await fullLogin(email, password);
	saveTokens(tokens);
	logger.info("MELCloud login successful, token stored");
	return tokens.accessToken;
}

/** Force re-authentication (after a 401 or credential change). */
async function relogin(email, password) {
	clearTokens();
	return getAccessToken(email, password);
}

module.exports = {
	AUTH_BASE,
	BFF_BASE,
	BFF_UA,
	AuthError,
	getAccessToken,
	relogin,
	loadTokens,
	clearTokens,
};
