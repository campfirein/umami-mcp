// The read-only tool surface. Each tool is a plain descriptor — name, model-
// facing description, JSON-Schema input, and a `run` that maps arguments onto
// Umami request(s). No write/delete tools exist here BY DESIGN: this server is
// the trustworthy, reviewable path to READ analytics, nothing more. The three
// report tools issue POSTs, but those are compute-reads (their inputs are just
// too complex for a query string), never mutations.
//
// This is the full target surface (~13 tools) covering essentially all of
// Umami's analytics reads — but consolidated: `metrics` folds ~10 dimensions
// behind one `type`, `explore_event_data` folds five event-data endpoints
// behind one `mode`, `session_detail` merges three per-session endpoints. We
// deliberately DON'T mirror all ~46 endpoints as ~46 tools — every tool is
// context the model re-reads each turn.
//
// Two date conventions, matching Umami's own split:
//   - stats / sessions / events    → startAt / endAt as unix-MILLISECOND numbers
//   - reports (funnel/retention/…)  → startDate / endDate as ISO DATE strings
// Agents reason in dates, so every tool accepts ISO strings (or omits them for a
// "last 7 days" default) and we convert to whichever the endpoint wants.

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

/** Resolve optional `startDate`/`endDate` args into ISO date strings (default: last 7 days). */
function resolveDateStrings(args: Record<string, unknown>): { startDate: string; endDate: string } {
	const endMs = args.endDate !== undefined ? Date.parse(String(args.endDate)) : Date.now();
	const startMs = args.startDate !== undefined ? Date.parse(String(args.startDate)) : endMs - 7 * DAY_MS;
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		throw new Error("startDate/endDate must be ISO dates (e.g. 2026-07-01)");
	}
	return { startDate: toISODate(startMs), endDate: toISODate(endMs) };
}

/** unix-ms → YYYY-MM-DD. */
function toISODate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Read `websiteId` (required) as a string, with a clear error when missing. */
function websiteId(args: Record<string, unknown>): string {
	const id = args.websiteId;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("websiteId is required (get it from list_websites)");
	}
	return id;
}

/** Read a required string arg or throw. */
function requireString(args: Record<string, unknown>, key: string, hint: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required (${hint})`);
	return value;
}

/** Narrow an unknown arg to a non-empty string, else undefined. */
function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Umami list responses come back as a bare array OR `{ data: [...] }` — normalize. */
function itemsOf(response: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(response)) return response as Array<Record<string, unknown>>;
	if (response !== null && typeof response === "object" && Array.isArray((response as { data?: unknown }).data)) {
		return (response as { data: Array<Record<string, unknown>> }).data;
	}
	return [];
}

/** Reusable schema fragments. */
const RANGE_PROPS = {
	startAt: { type: "string", description: "Range start, ISO date. Optional; defaults to 7 days ago." },
	endAt: { type: "string", description: "Range end, ISO date. Optional; defaults to now." },
} as const;

const DATE_PROPS = {
	startDate: { type: "string", description: "Report start, ISO date. Optional; defaults to 7 days ago." },
	endDate: { type: "string", description: "Report end, ISO date. Optional; defaults to today." },
} as const;

const WEBSITE_PROP = {
	websiteId: { type: "string", description: "The website id, from list_websites." },
} as const;

export const TOOLS: readonly UmamiTool[] = [
	// ── Discovery ────────────────────────────────────────────────────────────
	{
		name: "list_websites",
		description:
			"List every website these credentials can reach (id, name, domain) — both personally-owned sites AND " +
			"sites shared through a team. Start here to get a websiteId. Team sites carry a `team` tag.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (client) => {
			// Umami's GET /websites returns ONLY personally-owned sites. A very common
			// setup (a service account added to a team that owns the site) surfaces
			// nothing there — the site lives under GET /teams/:id/websites. So we
			// aggregate both and dedupe by id, tagging team-sourced rows.
			const byId = new Map<string, Record<string, unknown>>();
			const add = (site: Record<string, unknown>, team?: { id: string; name: unknown }) => {
				const id = site.id;
				if (typeof id !== "string" || byId.has(id)) return;
				byId.set(id, team !== undefined ? { ...site, team } : site);
			};

			for (const site of itemsOf(await client.get("/websites"))) add(site);

			// Team enumeration is best-effort: on an instance where it's unavailable,
			// personally-owned sites still list.
			const teams = await client.get("/teams").catch(() => null);
			for (const team of itemsOf(teams)) {
				const id = team.id;
				if (typeof id !== "string") continue;
				const teamSites = await client.get(`/teams/${id}/websites`).catch(() => null);
				for (const site of itemsOf(teamSites)) add(site, { id, name: team.name });
			}

			const websites = [...byId.values()];
			return { websites, count: websites.length };
		},
	},
	{
		name: "data_range",
		description:
			"The earliest and latest timestamps with collected data for a website. Call this before querying ranges " +
			"so you don't ask for windows that have no data.",
		inputSchema: {
			type: "object",
			properties: { ...WEBSITE_PROP },
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => client.get(`/websites/${websiteId(args)}/daterange`),
	},

	// ── Traffic & trends ─────────────────────────────────────────────────────
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
			const query: Query = {
				startAt,
				endAt,
				unit: asString(args.unit) ?? "day",
				timezone: asString(args.timezone) ?? "UTC",
			};
			return client.get(`/websites/${websiteId(args)}/pageviews`, query);
		},
	},
	{
		name: "realtime",
		description: "Live activity for a website over the last ~30 minutes: active visitors, recent views and events.",
		inputSchema: {
			type: "object",
			properties: { ...WEBSITE_PROP },
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => client.get(`/realtime/${websiteId(args)}`),
	},

	// ── Breakdowns ───────────────────────────────────────────────────────────
	{
		name: "metrics",
		description:
			"Top values for one dimension of a website's traffic over a date range — e.g. type=path for top pages, " +
			"type=referrer for top referrers, type=browser / os / device / country / event. Set expanded=true for " +
			"engagement detail (visitors, visits, bounce, duration per row).",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				type: {
					type: "string",
					enum: [
						"path",
						"referrer",
						"title",
						"query",
						"browser",
						"os",
						"device",
						"screen",
						"country",
						"region",
						"city",
						"language",
						"event",
						"tag",
					],
					description: "Which dimension to rank (path = top pages).",
				},
				limit: { type: "number", description: "Max rows (default 20)." },
				expanded: { type: "boolean", description: "Return engagement-rich rows (default false)." },
			},
			required: ["websiteId", "type"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const raw = asString(args.type);
			if (raw === undefined) throw new Error("type is required (e.g. path, referrer, browser, country, event)");
			// Older Umami named the top-pages dimension `url`; current versions use
			// `path` (and reject `url` with a 400). Accept the legacy name either way.
			const type = raw === "url" ? "path" : raw;
			const { startAt, endAt } = resolveRange(args);
			const query: Query = { startAt, endAt, type, limit: typeof args.limit === "number" ? args.limit : 20 };
			const path = args.expanded === true ? "metrics/expanded" : "metrics";
			return client.get(`/websites/${websiteId(args)}/${path}`, query);
		},
	},

	// ── Events ───────────────────────────────────────────────────────────────
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
			const query: Query = {
				startAt,
				endAt,
				unit: asString(args.unit) ?? "day",
				timezone: asString(args.timezone) ?? "UTC",
			};
			return client.get(`/websites/${websiteId(args)}/events/series`, query);
		},
	},
	{
		name: "explore_event_data",
		description:
			"Drill into custom-event PROPERTIES (not just counts over time). Modes: events = event names + counts; " +
			"properties = property names per event; fields = property/value counts; stats = totals; values = counts " +
			"for one event+property (both required for this mode).",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				mode: {
					type: "string",
					enum: ["events", "properties", "fields", "stats", "values"],
					description: "Which event-data view (default events).",
				},
				event: {
					type: "string",
					description: "Event name (required for mode=values; optional filter for mode=events).",
				},
				propertyName: { type: "string", description: "Property name (required for mode=values)." },
			},
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const { startAt, endAt } = resolveRange(args);
			const mode = asString(args.mode) ?? "events";
			const id = websiteId(args);
			const base: Query = { startAt, endAt };
			switch (mode) {
				case "events":
					return client.get(`/websites/${id}/event-data/events`, { ...base, event: asString(args.event) });
				case "properties":
					return client.get(`/websites/${id}/event-data/properties`, base);
				case "fields":
					return client.get(`/websites/${id}/event-data/fields`, base);
				case "stats":
					return client.get(`/websites/${id}/event-data/stats`, base);
				case "values": {
					const event = requireString(args, "event", "the event name");
					const propertyName = requireString(args, "propertyName", "the property name");
					return client.get(`/websites/${id}/event-data/values`, { ...base, event, propertyName });
				}
				default:
					throw new Error(`unknown mode "${mode}" (use events, properties, fields, stats, or values)`);
			}
		},
	},

	// ── Sessions & journeys ──────────────────────────────────────────────────
	{
		name: "list_sessions",
		description:
			"List individual visitor sessions for a website over a date range (paginated). Each session carries " +
			"browser/OS/device, geo, and visit/view/event counts. Use it to answer per-visitor questions.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				search: { type: "string", description: "Free-text search over sessions." },
				page: { type: "number", description: "Page number (default 1)." },
				pageSize: { type: "number", description: "Results per page (default 20)." },
			},
			required: ["websiteId"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const { startAt, endAt } = resolveRange(args);
			const query: Query = {
				startAt,
				endAt,
				search: asString(args.search),
				page: typeof args.page === "number" ? args.page : undefined,
				pageSize: typeof args.pageSize === "number" ? args.pageSize : undefined,
			};
			return client.get(`/websites/${websiteId(args)}/sessions`, query);
		},
	},
	{
		name: "session_detail",
		description:
			"Everything about one session: its summary, its activity log (the pages/events in order), and its custom " +
			"properties — fetched together. Get a sessionId from list_sessions first.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...RANGE_PROPS,
				sessionId: { type: "string", description: "The session id, from list_sessions." },
			},
			required: ["websiteId", "sessionId"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const id = websiteId(args);
			const sessionId = requireString(args, "sessionId", "get it from list_sessions");
			const { startAt, endAt } = resolveRange(args);
			const base = `/websites/${id}/sessions/${sessionId}`;
			// The activity/properties sub-resources are best-effort — a session
			// with no custom properties (or an older server) shouldn't fail the tool.
			const [session, activity, properties] = await Promise.all([
				client.get(base),
				client.get(`${base}/activity`, { startAt, endAt }).catch(() => null),
				client.get(`${base}/properties`).catch(() => null),
			]);
			return { session, activity, properties };
		},
	},

	// ── Analyses (compute-reads) ─────────────────────────────────────────────
	{
		name: "funnel_report",
		description:
			"Conversion funnel: given an ordered list of steps (each a page path or an event), how many visitors " +
			"reach each step and where they drop off. Minimum two steps.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...DATE_PROPS,
				steps: {
					type: "array",
					description: "Ordered funnel steps (>= 2).",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["path", "event"], description: "path (URL) or event." },
							value: { type: "string", description: "The URL path or event name." },
						},
						required: ["type", "value"],
					},
				},
				window: { type: "number", description: "Days allowed between steps to count as a conversion." },
			},
			required: ["websiteId", "steps"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const rawSteps = Array.isArray(args.steps) ? args.steps : [];
			if (rawSteps.length < 2) throw new Error("funnel needs at least two steps (each { type: path|event, value })");
			// Umami step types are path|event; tolerate the legacy `url` alias.
			const steps = rawSteps.map((step) => {
				const s = step as { type?: unknown; value?: unknown };
				return { type: s.type === "url" ? "path" : s.type, value: s.value };
			});
			const { startDate, endDate } = resolveDateStrings(args);
			// `window` (days allowed between steps to count as a conversion) is
			// REQUIRED by Umami. Default it to the span of the range so any ordered
			// completion within the window counts.
			const spanDays = Math.max(1, Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS));
			const window = typeof args.window === "number" ? args.window : spanDays;
			return client.post("/reports/funnel", {
				websiteId: websiteId(args),
				type: "funnel",
				filters: {},
				parameters: { startDate, endDate, steps, window },
			});
		},
	},
	{
		name: "retention_report",
		description:
			"Retention: of the visitors first seen in the range, what fraction return on each subsequent day. " +
			"Requires a timezone.",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...DATE_PROPS,
				timezone: { type: "string", description: "IANA timezone, e.g. America/New_York." },
			},
			required: ["websiteId", "timezone"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const timezone = requireString(args, "timezone", "e.g. America/New_York");
			const { startDate, endDate } = resolveDateStrings(args);
			return client.post("/reports/retention", {
				websiteId: websiteId(args),
				type: "retention",
				filters: {},
				parameters: { startDate, endDate, timezone },
			});
		},
	},
	{
		name: "journey_report",
		description:
			"User journeys: the common navigation paths between a starting step and an (optional) ending step, over " +
			"a chosen number of steps (3–7).",
		inputSchema: {
			type: "object",
			properties: {
				...WEBSITE_PROP,
				...DATE_PROPS,
				steps: { type: "number", description: "Number of journey steps, 3 to 7." },
				startStep: { type: "string", description: "Starting step: a URL path or event name." },
				endStep: { type: "string", description: "Optional ending step: a URL path or event name." },
			},
			required: ["websiteId", "startStep"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const startStep = requireString(args, "startStep", "a URL path or event name");
			const steps = typeof args.steps === "number" ? args.steps : 5;
			if (steps < 3 || steps > 7) throw new Error("steps must be between 3 and 7");
			const { startDate, endDate } = resolveDateStrings(args);
			return client.post("/reports/journey", {
				websiteId: websiteId(args),
				type: "journey",
				filters: {},
				parameters: {
					startDate,
					endDate,
					steps,
					startStep,
					...(asString(args.endStep) !== undefined ? { endStep: args.endStep } : {}),
				},
			});
		},
	},
];
