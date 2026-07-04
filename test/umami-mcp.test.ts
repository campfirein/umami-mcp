// Keyless, network-free tests: config resolution is pure, and the tools are
// exercised against a fake client that records the GET each one issues — proving
// the argument→endpoint mapping without touching a real Umami.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TOOLS } from "../src/tools.js";
import type { Query, UmamiClient } from "../src/umami-client.js";

/** A UmamiClient stand-in that records the last GET and returns a canned body. */
function fakeClient(): UmamiClient & { last: { path: string; query?: Query } | undefined } {
	const state: { last: { path: string; query?: Query } | undefined } = { last: undefined };
	const client = {
		last: state.last,
		async get(path: string, query?: Query) {
			state.last = { path, query };
			// biome-ignore lint/suspicious/noExplicitAny: test shim exposing the recorded call
			(client as any).last = state.last;
			return { ok: true };
		},
	};
	return client as unknown as UmamiClient & { last: { path: string; query?: Query } | undefined };
}

function tool(name: string) {
	const found = TOOLS.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`no such tool: ${name}`);
	return found;
}

describe("loadConfig", () => {
	it("resolves Cloud mode from an API key (default host + /v1)", () => {
		const config = loadConfig({ UMAMI_API_KEY: "key_abc" } as NodeJS.ProcessEnv);
		expect(config).toEqual({ mode: "cloud", base: "https://api.umami.is/v1", apiKey: "key_abc" });
	});

	it("resolves self-hosted mode from username/password + URL (/api prefix)", () => {
		const config = loadConfig({
			UMAMI_API_URL: "https://umami.example.com/",
			UMAMI_USERNAME: "admin",
			UMAMI_PASSWORD: "secret",
		} as NodeJS.ProcessEnv);
		expect(config).toEqual({
			mode: "self-hosted",
			base: "https://umami.example.com/api",
			username: "admin",
			password: "secret",
		});
	});

	it("does not double the prefix when the host already carries it", () => {
		const config = loadConfig({ UMAMI_API_KEY: "k", UMAMI_API_URL: "https://api.umami.is/v1" } as NodeJS.ProcessEnv);
		expect(config).toMatchObject({ base: "https://api.umami.is/v1" });
	});

	it("throws when nothing is configured", () => {
		expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/unconfigured/i);
	});

	it("throws for self-hosted creds without a URL", () => {
		expect(() => loadConfig({ UMAMI_USERNAME: "a", UMAMI_PASSWORD: "b" } as NodeJS.ProcessEnv)).toThrow(
			/UMAMI_API_URL/,
		);
	});
});

describe("tools → endpoint mapping", () => {
	it("list_websites hits /websites with no query", async () => {
		const client = fakeClient();
		await tool("list_websites").run(client, {});
		expect(client.last).toEqual({ path: "/websites", query: undefined });
	});

	it("website_stats passes an explicit range through as ms", async () => {
		const client = fakeClient();
		await tool("website_stats").run(client, {
			websiteId: "w1",
			startAt: "2026-07-01T00:00:00Z",
			endAt: "2026-07-08T00:00:00Z",
		});
		expect(client.last?.path).toBe("/websites/w1/stats");
		expect(client.last?.query).toEqual({
			startAt: Date.parse("2026-07-01T00:00:00Z"),
			endAt: Date.parse("2026-07-08T00:00:00Z"),
		});
	});

	it("defaults an omitted range to a 7-day window", async () => {
		const client = fakeClient();
		await tool("website_stats").run(client, { websiteId: "w1" });
		const { startAt, endAt } = client.last?.query as { startAt: number; endAt: number };
		expect(endAt - startAt).toBe(7 * 86_400_000);
	});

	it("metrics requires a type and defaults limit to 20", async () => {
		const client = fakeClient();
		await tool("metrics").run(client, { websiteId: "w1", type: "url", startAt: "2026-07-01", endAt: "2026-07-02" });
		expect(client.last?.path).toBe("/websites/w1/metrics");
		expect(client.last?.query).toMatchObject({ type: "url", limit: 20 });
	});

	it("metrics throws without a type", async () => {
		const client = fakeClient();
		await expect(tool("metrics").run(client, { websiteId: "w1" })).rejects.toThrow(/type is required/);
	});

	it("tools that need a website throw a clear error when it is missing", async () => {
		const client = fakeClient();
		await expect(tool("website_stats").run(client, {})).rejects.toThrow(/websiteId is required/);
	});

	it("pageviews_series defaults unit to day", async () => {
		const client = fakeClient();
		await tool("pageviews_series").run(client, { websiteId: "w1", startAt: "2026-07-01", endAt: "2026-07-02" });
		expect(client.last?.path).toBe("/websites/w1/pageviews");
		expect(client.last?.query).toMatchObject({ unit: "day" });
	});

	it("active_visitors hits /active with no query", async () => {
		const client = fakeClient();
		await tool("active_visitors").run(client, { websiteId: "w1" });
		expect(client.last).toEqual({ path: "/websites/w1/active", query: undefined });
	});
});
