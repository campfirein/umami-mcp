// Keyless, network-free tests: config resolution is pure, and the tools are
// exercised against a fake client that records the GET each one issues — proving
// the argument→endpoint mapping without touching a real Umami.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TOOLS } from "../src/tools.js";
import type { Query, UmamiClient } from "../src/umami-client.js";

interface Recorded {
	method: "GET" | "POST";
	path: string;
	query?: Query;
	body?: unknown;
}

/** A UmamiClient stand-in that records every call and returns a canned body. */
function fakeClient(): UmamiClient & { calls: Recorded[]; last: Recorded | undefined } {
	const calls: Recorded[] = [];
	const client = {
		calls,
		get last(): Recorded | undefined {
			return calls[calls.length - 1];
		},
		async get(path: string, query?: Query) {
			calls.push({ method: "GET", path, query });
			return { ok: true };
		},
		async post(path: string, body: unknown) {
			calls.push({ method: "POST", path, body });
			return { ok: true };
		},
	};
	return client as unknown as UmamiClient & { calls: Recorded[]; last: Recorded | undefined };
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
	it("list_websites aggregates personal + team websites and dedupes by id", async () => {
		// Path-aware fake: personal is empty (the team-only setup), the site lives
		// under the team — and also appears personally to prove de-duplication.
		const bodies: Record<string, unknown> = {
			"/websites": { data: [{ id: "shared", name: "Shared", domain: "s.com" }], count: 1 },
			"/teams": { data: [{ id: "t1", name: "byterover" }], count: 1 },
			"/teams/t1/websites": {
				data: [
					{ id: "shared", name: "Shared", domain: "s.com" },
					{ id: "w1", name: "Site", domain: "x.com" },
				],
				count: 2,
			},
		};
		const client = {
			async get(path: string) {
				return bodies[path] ?? { data: [] };
			},
		} as unknown as UmamiClient;

		const result = (await tool("list_websites").run(client, {})) as {
			websites: Array<Record<string, unknown>>;
			count: number;
		};
		expect(result.count).toBe(2);
		const ids = result.websites.map((w) => w.id).sort();
		expect(ids).toEqual(["shared", "w1"]);
		// The team-only site is tagged with its team; the personally-owned one is not.
		expect(result.websites.find((w) => w.id === "w1")?.team).toMatchObject({ id: "t1", name: "byterover" });
		expect(result.websites.find((w) => w.id === "shared")?.team).toBeUndefined();
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

	it("metrics defaults limit to 20 and aliases legacy url→path", async () => {
		const client = fakeClient();
		await tool("metrics").run(client, { websiteId: "w1", type: "url", startAt: "2026-07-01", endAt: "2026-07-02" });
		expect(client.last?.path).toBe("/websites/w1/metrics");
		expect(client.last?.query).toMatchObject({ type: "path", limit: 20 });
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

	it("events_series hits /events/series", async () => {
		const client = fakeClient();
		await tool("events_series").run(client, { websiteId: "w1", startAt: "2026-07-01", endAt: "2026-07-02" });
		expect(client.last?.path).toBe("/websites/w1/events/series");
	});

	it("realtime hits /realtime/:id (not under /websites)", async () => {
		const client = fakeClient();
		await tool("realtime").run(client, { websiteId: "w1" });
		expect(client.last).toMatchObject({ method: "GET", path: "/realtime/w1" });
	});

	it("data_range hits /daterange", async () => {
		const client = fakeClient();
		await tool("data_range").run(client, { websiteId: "w1" });
		expect(client.last?.path).toBe("/websites/w1/daterange");
	});

	it("metrics expanded=true routes to /metrics/expanded", async () => {
		const client = fakeClient();
		await tool("metrics").run(client, { websiteId: "w1", type: "url", expanded: true });
		expect(client.last?.path).toBe("/websites/w1/metrics/expanded");
	});
});

describe("event-data exploration", () => {
	it("mode=events hits /event-data/events with an optional event filter", async () => {
		const client = fakeClient();
		await tool("explore_event_data").run(client, { websiteId: "w1", event: "signup" });
		expect(client.last?.path).toBe("/websites/w1/event-data/events");
		expect(client.last?.query).toMatchObject({ event: "signup" });
	});

	it("mode=values requires event AND propertyName", async () => {
		const client = fakeClient();
		await expect(
			tool("explore_event_data").run(client, { websiteId: "w1", mode: "values", event: "signup" }),
		).rejects.toThrow(/propertyName is required/);
	});

	it("mode=values hits /event-data/values when both are present", async () => {
		const client = fakeClient();
		await tool("explore_event_data").run(client, {
			websiteId: "w1",
			mode: "values",
			event: "signup",
			propertyName: "plan",
		});
		expect(client.last?.path).toBe("/websites/w1/event-data/values");
		expect(client.last?.query).toMatchObject({ event: "signup", propertyName: "plan" });
	});
});

describe("sessions", () => {
	it("list_sessions passes pagination + search", async () => {
		const client = fakeClient();
		await tool("list_sessions").run(client, { websiteId: "w1", search: "chrome", page: 2, pageSize: 50 });
		expect(client.last?.path).toBe("/websites/w1/sessions");
		expect(client.last?.query).toMatchObject({ search: "chrome", page: 2, pageSize: 50 });
	});

	it("session_detail fetches summary + activity + properties", async () => {
		const client = fakeClient();
		await tool("session_detail").run(client, { websiteId: "w1", sessionId: "s9" });
		const paths = client.calls.map((c) => c.path);
		expect(paths).toContain("/websites/w1/sessions/s9");
		expect(paths).toContain("/websites/w1/sessions/s9/activity");
		expect(paths).toContain("/websites/w1/sessions/s9/properties");
	});
});

describe("reports (compute-reads via POST)", () => {
	it("funnel_report POSTs steps and requires >= 2", async () => {
		const client = fakeClient();
		await expect(
			tool("funnel_report").run(client, { websiteId: "w1", steps: [{ type: "path", value: "/" }] }),
		).rejects.toThrow(/at least two steps/);

		await tool("funnel_report").run(client, {
			websiteId: "w1",
			steps: [
				{ type: "path", value: "/" },
				{ type: "event", value: "signup" },
			],
			startDate: "2026-06-01",
			endDate: "2026-06-30",
		});
		expect(client.last).toMatchObject({
			method: "POST",
			path: "/reports/funnel",
			body: { type: "funnel", websiteId: "w1", startDate: "2026-06-01", endDate: "2026-06-30" },
		});
	});

	it("retention_report requires a timezone and POSTs it", async () => {
		const client = fakeClient();
		await expect(tool("retention_report").run(client, { websiteId: "w1" })).rejects.toThrow(/timezone is required/);
		await tool("retention_report").run(client, { websiteId: "w1", timezone: "America/New_York" });
		expect(client.last).toMatchObject({
			method: "POST",
			path: "/reports/retention",
			body: { type: "retention", timezone: "America/New_York" },
		});
	});

	it("journey_report enforces 3–7 steps and POSTs startStep", async () => {
		const client = fakeClient();
		await expect(tool("journey_report").run(client, { websiteId: "w1", startStep: "/", steps: 9 })).rejects.toThrow(
			/between 3 and 7/,
		);
		await tool("journey_report").run(client, { websiteId: "w1", startStep: "/", steps: 4 });
		expect(client.last).toMatchObject({
			method: "POST",
			path: "/reports/journey",
			body: { type: "journey", startStep: "/", steps: 4 },
		});
	});
});
