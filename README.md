# @byterover/umami-mcp

A minimal, **read-only** [Model Context Protocol](https://modelcontextprotocol.io)
server for [Umami](https://umami.is) analytics — Cloud or self-hosted.

It exposes a small set of read tools (list sites, stats, time series, top
metrics, live visitors) over stdio, so an MCP client such as
[Grove](https://github.com/campfirein/grove) can let an agent answer questions
about your web analytics. It issues **no writes** — there are no create/update/
delete tools, by design.

## Why this exists

Community Umami MCP servers exist but have little usage and aren't reviewed by
anyone we trust with an analytics credential. This is byterover's first-party,
source-available wrapper: small enough to read end-to-end, read-only, and
published with provenance. We dogfood it on our own landing-page analytics.

## Install

```sh
npx @byterover/umami-mcp
```

## Configure

Pick **one** mode via environment variables.

**Umami Cloud** — create a read-only API key at
[cloud.umami.is](https://cloud.umami.is) (Settings → API keys):

```sh
UMAMI_API_KEY=your_api_key
```

**Self-hosted** — point at your instance and provide a login:

```sh
UMAMI_API_URL=https://umami.example.com
UMAMI_USERNAME=your_username
UMAMI_PASSWORD=your_password
```

Advanced: `UMAMI_API_URL` overrides the base host (Cloud default
`https://api.umami.is`) and `UMAMI_API_PATH` overrides the path prefix (Cloud
`/v1`, self-hosted `/api`).

## Use with Grove

Add it to your `mcp.json` as a stdio server (pin the version; keep the key in
`.env` via a `${VAR}` ref):

```json
{
  "mcpServers": {
    "umami": {
      "command": "npx",
      "args": ["-y", "@byterover/umami-mcp@0.1.0"],
      "env": { "UMAMI_API_KEY": "${UMAMI_API_KEY}" }
    }
  }
}
```

Tools surface in Grove as `umami__list_websites`, `umami__website_stats`, etc.

## Tools

| Tool | What it returns |
| --- | --- |
| `list_websites` | Websites (id, name, domain) these credentials can see. Start here. |
| `website_stats` | Pageviews, visitors, visits, bounces, total time over a range. |
| `pageviews_series` | Pageviews/sessions time series, bucketed by hour/day/month/year. |
| `metrics` | Top values for one dimension (url, referrer, browser, country, event, …). |
| `events_series` | Custom-event time series over a range. |
| `active_visitors` | Visitors active right now. |

Date-ranged tools accept ISO `startAt`/`endAt` (e.g. `2026-07-01`); omit them
for the last 7 days.

## Develop

```sh
pnpm install
pnpm build       # tsc → dist/
pnpm typecheck
pnpm test        # keyless, network-free
pnpm lint
```

## License

[Elastic License 2.0](./LICENSE) — © byterover.
