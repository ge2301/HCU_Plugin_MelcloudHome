"use strict";

/**
 * Read-only API spike against MELCloud Home (mobile BFF).
 *
 * Purpose (concept verification only):
 *   1. Login via OAuth2 PKCE (PAR -> authorize -> Cognito -> callback -> token)
 *   2. GET /context  -> account/device inventory (ATA / ATW units, capabilities)
 *
 * Sends ~5 requests total. Never sends any control/PUT request.
 * Credentials come from environment variables MEL_EMAIL / MEL_PASS.
 *
 * Flow reverse-engineered from the open-source HA integration
 * "andrew-blake/melcloudhome" (api/auth.py, api/const_shared.py).
 */

const AUTH_BASE = "https://auth.melcloudhome.com";
const COGNITO_SUFFIX = ".amazoncognito.com";
const BFF_BASE = "https://mobile.bff.melcloudhome.com";
const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";
const SCOPES = "openid profile email offline_access IdentityServerApi";
const BFF_UA =
	"MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";
const BROWSER_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76";

const EMAIL = process.env.MEL_EMAIL;
const PASS = process.env.MEL_PASS;
if (!EMAIL || !PASS) {
	console.error("Set MEL_EMAIL and MEL_PASS environment variables.");
	process.exit(2);
}

const crypto = require("crypto");

/* ------------------------------ tiny cookie jar ------------------------------ */

const jar = new Map(); // name -> value

function absorbCookies(resp) {
	const raw =
		typeof resp.headers.getSetCookie === "function"
			? resp.headers.getSetCookie()
			: [];
	for (const line of raw) {
		const pair = line.split(";")[0];
		const idx = pair.indexOf("=");
		if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
	}
}

function cookieHeader() {
	return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/* ------------------------------ fetch helpers -------------------------------- */

async function req(url, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (jar.size) headers["cookie"] = cookieHeader();
	const t0 = Date.now();
	const resp = await fetch(url, {
		method: opts.method || "GET",
		headers,
		body: opts.body,
		redirect: "manual",
		signal: AbortSignal.timeout(30000),
	});
	absorbCookies(resp);
	console.log(
		`-> ${opts.method || "GET"} ${redact(url)} [${resp.status}] ${Date.now() - t0}ms`
	);
	return resp;
}

function redact(url) {
	return String(url)
		.replace(/([?&])(code|state|request_uri)=([^&]*)/g, `$1$2=***`)
		.slice(0, 140);
}

function formBody(obj) {
	return new URLSearchParams(obj).toString();
}
const FORM_TYPE = "application/x-www-form-urlencoded";

function pkce() {
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto
		.createHash("sha256")
		.update(verifier)
		.digest("base64url");
	return { verifier, challenge };
}

function extractCsrf(html) {
	const m =
		html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/) ||
		html.match(/name="_csrf"\s+value="([^"]+)"/) ||
		html.match(/<input[^>]+value="([^"]+)"[^>]+name="_csrf"/);
	return m ? m[1] : null;
}

/* ------------------------------ step 1: PAR ---------------------------------- */

async function par(challenge, state) {
	const resp = await req(`${AUTH_BASE}/connect/par`, {
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
	});
	if (resp.status !== 201) {
		throw new Error(`PAR failed: HTTP ${resp.status} ${await resp.text()}`);
	}
	return (await resp.json()).request_uri;
}

/* ---------------- step 2+3+4: authorize -> cognito login -> code ------------- */

async function followUntilCode(startUrl, opts = {}, maxHops = 8) {
	// Follows http(s) redirects manually; returns auth code when a
	// melcloudhome://...?code= URL appears, else returns { html, url } of last page.
	let url = startUrl;
	for (let i = 0; i < maxHops; i++) {
		const resp = await req(url, opts);
		const loc =
			resp.headers.get("location") || resp.headers.get("x-idp-redirect") || "";
		if (resp.status >= 300 && resp.status < 400 && !loc) {
			console.log("   (3xx without Location, headers:", JSON.stringify([...resp.headers]), ")");
		}
		if (loc && loc.startsWith(REDIRECT_URI)) {
			const m = loc.match(/[?&]code=([^&]+)/);
			if (!m) throw new Error(`redirect without code: ${redact(loc)}`);
			return { code: m[1] };
		}
		if (loc && (/^https?:/i.test(loc) || loc.startsWith("//") || loc.startsWith("/"))) {
			url = new URL(loc, url).toString();
			opts = { ...opts, method: "GET", body: undefined };
			continue;
		}
		if (loc) console.log(`   (non-http Location: ${redact(loc)})`);
		const body = await resp.text();
		return { html: body, url, status: resp.status, loc };
	}
	throw new Error("too many redirects");
}

async function login() {
	const { verifier, challenge } = pkce();
	const state = crypto.randomBytes(16).toString("base64url");
	const request_uri = await par(challenge, state);

	// Step 2: authorize -> expect Cognito login page (or existing session)
	let url = `${AUTH_BASE}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(
		request_uri
	)}`;
	let loginPage = null;
	let authCode = null;
	for (let i = 0; i < 8 && !loginPage && !authCode; i++) {
		const r = await followUntilCode(url, { headers: { "user-agent": BROWSER_UA } });
		if (r.code) {
			authCode = r.code;
			break;
		}
		const isCognito =
			/\.amazoncognito\.com\/login/.test(r.url) ||
			(r.url.includes(COGNITO_SUFFIX) && r.url.includes("login"));
		if (isCognito) {
			loginPage = r;
			break;
		}
		// Maybe the body carries a callback link (existing session variant)
		const cb = r.html && r.html.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
		if (cb) {
			url = `${AUTH_BASE}/connect/authorize/callback?${cb[1].replace(/&amp;/g, "&")}`;
			continue;
		}
		throw new Error(`Unexpected authorize landing: ${redact(r.url)} (${r.status})`);
	}

	if (loginPage) {
		const csrf = extractCsrf(loginPage.html);
		if (!csrf) throw new Error("no CSRF token on Cognito login page");
		const host = new URL(loginPage.url).hostname;
		// Step 3: submit credentials
		const r = await followUntilCode(loginPage.url, {
			method: "POST",
			body: new URLSearchParams({
				_csrf: csrf,
				username: EMAIL,
				password: PASS,
				cognitoAsfData: "",
			}).toString(),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: `https://${host}`,
				referer: loginPage.url,
				"user-agent": BROWSER_UA,
			},
		});
		if (r.code) {
			authCode = r.code;
		} else {
			// Step 4: callback link inside the HTML page
			const cb =
				r.html &&
				(r.html.match(/\/connect\/authorize\/callback\?([^"' ]+)/) ||
					r.html.match(/code=([^&"' ]+)/));
			if (!cb) {
				if (r.url.includes(COGNITO_SUFFIX))
					throw new Error("login rejected (back on cognito page) - wrong credentials?");
				throw new Error(`no callback/code in POST response (${r.status}) ${redact(r.url)}`);
			}
			if (cb[0].startsWith("code=")) {
				authCode = cb[1];
			} else {
				// Step 5: follow the callback for the code
				const qs = cb[1].replace(/&amp;/g, "&");
				const r2 = await followUntilCode(
					`${AUTH_BASE}/connect/authorize/callback?${qs}`,
					{ headers: { "user-agent": BROWSER_UA } }
				);
				if (!r2.code) throw new Error("callback did not yield a code");
				authCode = r2.code;
			}
		}
	}
	if (!authCode) throw new Error("no auth code obtained");

	// Step 6: token exchange
	const resp = await req(`${AUTH_BASE}/connect/token`, {
		method: "POST",
		body: formBody({
			grant_type: "authorization_code",
			code: authCode,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			client_id: CLIENT_ID,
		}),
		headers: { "user-agent": BFF_UA, "content-type": FORM_TYPE },
	});
	if (resp.status !== 200) {
		throw new Error(`token exchange failed: HTTP ${resp.status} ${await resp.text()}`);
	}
	const tok = await resp.json();
	console.log(
		`AUTH OK  access_token=${(tok.access_token || "").slice(0, 12)}...  expires_in=${tok.expires_in}s  refresh_token=${tok.refresh_token ? "yes" : "NO"}`
	);
	// Persist nothing in the spike; tokens die with the process.
	return tok;
}

/* ------------------------------ step 7: /context ----------------------------- */

async function context(token) {
	const resp = await req(`${BFF_BASE}/context`, {
		headers: {
			authorization: `Bearer ${token.access_token}`,
			"user-agent": BFF_UA,
			accept: "application/json",
		},
	});
	if (resp.status !== 200) {
		throw new Error(`GET /context -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
	}
	return resp.json();
}

function summarize(ctx) {
	console.log("\n===== CONTEXT SUMMARY =====");
	const top = Object.keys(ctx);
	console.log("top-level keys:", top.join(", "));
	const buildings = ctx.buildings || [];
	console.log(`buildings: ${buildings.length}`);
	for (const b of buildings) {
		const ata = b.airToAirUnits || [];
		const atw = b.airToWaterUnits || b.atwUnits || [];
		console.log(
			`\n- building "${b.name}"  (ATA: ${ata.length}, ATW: ${atw.length}, keys: ${Object.keys(
				b
			).join(",")})`
		);
		for (const u of ata) {
			console.log(`  * ATA id=${u.id}`);
			console.log(`    unit keys  : ${Object.keys(u).join(",")}`);
			console.log(`    FULL       : ${JSON.stringify(u, null, 1).slice(0, 4000)}`);
		}
		for (const u of atw) {
			console.log(`  * ATW "${u.name}"  id=${u.id}`);
			console.log(`    state      : ${JSON.stringify(u.state || {}).slice(0, 400)}`);
		}
	}
}

(async () => {
	const tok = await login();
	const ctx = await context(tok);
	summarize(ctx);
	console.log("\nSPIKE DONE (no control commands were sent).");
})().catch((e) => {
	console.error("SPIKE FAILED:", e.message);
	process.exit(1);
});
