#!/usr/bin/env node
// @byterover/umami-mcp — a read-only MCP server for Umami analytics.
//
// It speaks the Model Context Protocol over stdio (the transport an MCP client
// like Grove spawns and talks to). On start it resolves its Umami credentials
// from the environment, advertises the read-only TOOLS, and proxies each
// tools/call onto one Umami GET. stdout is the protocol channel, so all logging
// goes to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { TOOLS } from "./tools.js";
import { UmamiClient } from "./umami-client.js";

async function main(): Promise<void> {
	// Fail fast (before we advertise a single tool) if the environment is not
	// configured — the message tells the operator exactly what to set.
	const client = new UmamiClient(loadConfig());

	const server = new Server({ name: "umami-mcp", version: "0.2.2" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOLS.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
		if (tool === undefined) {
			return { isError: true, content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }] };
		}
		try {
			const result = await tool.run(client, request.params.arguments ?? {});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { isError: true, content: [{ type: "text", text: message }] };
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write("umami-mcp: ready\n");
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`umami-mcp: fatal: ${message}\n`);
	process.exit(1);
});
