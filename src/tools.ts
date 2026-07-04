// The read-only tool surface. Each tool is a plain descriptor — name, model-
// facing description, JSON-Schema input, and a `run` that maps arguments onto
// one Umami GET. No write/delete tools exist here BY DESIGN: this server is the
// trustworthy, reviewable path to read analytics, nothing more.
//
// Umami's time-bounded endpoints take `startAt`/`endAt` as unix-millisecond
// timestamps. Agents reason in dates, so every such tool accepts ISO date
// strings (or omits them for a sensible "last 7 days" default) and we convert.

import type { Query, UmamiClient } from "./umami-client.js";

/** One read-only Umami tool. */
export interface UmamiTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	run(client: UmamiClient, args: Record<string, unknown>): Promise<unknown>;
}

const DAY_MS = 86_400_000;

/** Resolve optional ISO `startAt`/`endAt` args into a unix-ms range (default: last 7 days). */
function resolveRange(args: Record<string, unknown>): { startAt: number; endAt: number } {
	const endAt = args.endAt !== undefined ? Date.parse(String(args.endAt)) : Date.now();
	const startAt = args.startAt !== undefined ? Date.parse(String(args.startAt)) : endAt - 7 * DAY_MS;
	if (Number.isNaN(startAt) || Number.isNaN(endAt)) {
		throw new Error("startAt/endAt must be ISO dates (e.g. 2026-07-01 or 2026-07-01T00:00:00Z)");
	}
	return { startAt, endAt };
}

/** Read `websiteId` (required) as a string, with a clear error when missing. */
function websiteId(args: Record<string, unknown>): string {
	const id = args.websiteId;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("websiteId is required (get it from list_websites)");
	}
	return id;
}

/** Reusable schema fragments for the date-range tools. */
const RANGE_PROPS = {
	startAt: { type: "string", description: "Range start, ISO date. Optional; defaults to 7 days ago." },
	endAt: { type: "string", description: "Range end, ISO date. Optional; defaults to now." },
} as const;

const WEBSITE_PROP = {
	websiteId: { type: "string", description: "The website id, from list_websites." },
} as const;

export const TOOLS: readonly UmamiTool[] = [
	{
		name: "list_websites",
		description: "List the websites (id, name, domain) visible to these credentials. Start here to get a websiteId.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (client) => client.get("/websites"),
	},
	{
		name: "website_stats",
		description:
			"Summary metrics for one website over a date range: pageviews, visitors, visits, bounces, total time " +
			"(each with the prior-period value for comparison).",
		inputSchema: {
			type: "object",
			properties: { ...WEBSITE_PROP, ...RANGE_PROPS },
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const { startAt, endAt } = resolveRange(args);
			return client.get(`/websites/${websiteId(args)}/stats`, { startAt, endAt });
		},
	},
	{
		name: "pageviews_series",
		description: "Time series of pageviews and sessions for a website over a date range, bucketed by unit.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				unit: { type: "string", enum: ["hour", "day", "month", "year"], description: "Bucket size (default day)." },
				timezone: { type: "string", description: "IANA timezone, e.g. America/New_York (default UTC)." },
			},
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const { startAt, endAt } = resolveRange(args);
			const query: Query = { startAt, endAt, unit: asString(args.unit) ?? "day", timezone: asString(args.timezone) };
			return client.get(`/websites/${websiteId(args)}/pageviews`, query);
		},
	},
	{
		name: "metrics",
		description:
			"Top values for one dimension of a website's traffic over a date range — e.g. type=url for top pages, " +
			"type=referrer for top referrers, type=browser / os / device / country / event.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				type: {
					type: "string",
					enum: ["url", "referrer", "title", "query", "browser", "os", "device", "country", "region", "city", "event"],
					description: "Which dimension to rank.",
				},
				limit: { type: "number", description: "Max rows (default 20)." },
			},
			required: ["websiteId", "type"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const type = asString(args.type);
			if (type === undefined) throw new Error("type is required (e.g. url, referrer, browser, country, event)");
			const { startAt, endAt } = resolveRange(args);
			const query: Query = { startAt, endAt, type, limit: typeof args.limit === "number" ? args.limit : 20 };
			return client.get(`/websites/${websiteId(args)}/metrics`, query);
		},
	},
	{
		name: "events_series",
		description: "Time series of tracked custom events for a website over a date range, bucketed by unit.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				unit: { type: "string", enum: ["hour", "day", "month", "year"], description: "Bucket size (default day)." },
				timezone: { type: "string", description: "IANA timezone (default UTC)." },
			},
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const { startAt, endAt } = resolveRange(args);
			const query: Query = { startAt, endAt, unit: asString(args.unit) ?? "day", timezone: asString(args.timezone) };
			return client.get(`/websites/${websiteId(args)}/events/series`, query);
		},
	},
	{
		name: "active_visitors",
		description: "The number of visitors currently active on a website (last ~5 minutes).",
		inputSchema: {
			type: "object",
			properties: { ...WEBSITE_PROP },
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => client.get(`/websites/${websiteId(args)}/active`),
	},
];

/** Narrow an unknown arg to a non-empty string, else undefined. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
