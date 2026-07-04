// A tiny read-only HTTP client for the Umami API. It knows how to authenticate
// in both modes and exposes `get()` plus a narrow `post()`. This server never
// MUTATES data: the only POSTs it issues are the self-hosted login handshake and
// Umami's compute-report endpoints (funnel/retention/journey), which are POSTs
// purely because their inputs are complex — they read analytics, they don't
// write. There is deliberately no put/delete surface.

import type { UmamiConfig } from "./config.js";

/** Values that can appear in a query string (undefined entries are dropped). */
export type Query = Record<string, string | number | undefined>;

export class UmamiClient {
	readonly #config: UmamiConfig;
	#token: string | undefined;

	constructor(config: UmamiConfig) {
		this.#config = config;
	}

	/** The auth header(s) for a request, minting a self-hosted token on demand. */
	async #authHeaders(): Promise<Record<string, string>> {
		if (this.#config.mode === "cloud") {
			return { "x-umami-api-key": this.#config.apiKey };
		}
		if (this.#token === undefined) {
			this.#token = await this.#login();
		}
		return { Authorization: `Bearer ${this.#token}` };
	}

	/** Self-hosted only: exchange username/password for a session token. */
	async #login(): Promise<string> {
		if (this.#config.mode !== "self-hosted") {
			throw new Error("login is only used in self-hosted mode");
		}
		const res = await fetch(`${this.#config.base}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ username: this.#config.username, password: this.#config.password }),
		});
		if (!res.ok) {
			throw new Error(`Umami login failed (${res.status}). Check UMAMI_USERNAME / UMAMI_PASSWORD / UMAMI_API_URL.`);
		}
		const body = (await res.json()) as { token?: string };
		if (body.token === undefined || body.token.length === 0) {
			throw new Error("Umami login succeeded but returned no token");
		}
		return body.token;
	}

	/** Issue a GET against the API and return the parsed JSON body. */
	async get(path: string, query?: Query): Promise<unknown> {
		const url = new URL(`${this.#config.base}${path}`);
		if (query !== undefined) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined) url.searchParams.set(key, String(value));
			}
		}
		const res = await fetch(url, {
			headers: { accept: "application/json", ...(await this.#authHeaders()) },
		});
		return this.#parse(res, path);
	}

	/** Issue a POST (compute-report reads only) and return the parsed JSON body. */
	async post(path: string, body: unknown): Promise<unknown> {
		const res = await fetch(`${this.#config.base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", ...(await this.#authHeaders()) },
			body: JSON.stringify(body),
		});
		return this.#parse(res, path);
	}

	/** Shared response handling: throw a legible error on non-2xx, else parse JSON. */
	async #parse(res: Response, path: string): Promise<unknown> {
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`Umami API ${res.status} for ${path}: ${text.slice(0, 300)}`);
		}
		return text.length > 0 ? JSON.parse(text) : null;
	}
}
