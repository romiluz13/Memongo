import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MemongoClient } from "@romiluz/memongo-platform";

const memongo = new MemongoClient({
  baseUrl: process.env.MEMONGO_API_URL,
  apiKey: process.env.MEMONGO_API_KEY,
});

const toolList = [
  {
    name: "memongo_search",
    description: "Search Memongo memory",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agentId: { type: "string" },
        limit: { type: "number" },
        minScore: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "memongo_search_kb",
    description: "Search Memongo knowledge base",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agentId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "memongo_read_file",
    description: "Read memory file by path (memory_get parity)",
    inputSchema: {
      type: "object",
      properties: {
        relPath: { type: "string" },
        agentId: { type: "string" },
        from: { type: "number" },
        lines: { type: "number" },
      },
      required: ["relPath"],
    },
  },
  {
    name: "memongo_add",
    description: "Add user message to memory",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        agentId: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "memongo_write_event",
    description: "Write conversation event (any role)",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
        body: { type: "string" },
        agentId: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["role", "body"],
    },
  },
  {
    name: "memongo_profile",
    description: "Synthesize profile from Memongo memory",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        scopeRef: { type: "string" },
      },
    },
  },
  {
    name: "memongo_status",
    description: "Memory provider status",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
    },
  },
] as const;

const server = new Server(
  {
    name: "memongo",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...toolList],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  try {
    if (name === "memongo_search") {
      const out = await memongo.search({
        query: typeof args.query === "string" ? args.query : "",
        agentId: typeof args.agentId === "string" ? args.agentId : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        minScore: typeof args.minScore === "number" ? args.minScore : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "memongo_search_kb") {
      const out = await memongo.searchKB({
        query: typeof args.query === "string" ? args.query : "",
        agentId: typeof args.agentId === "string" ? args.agentId : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "memongo_read_file") {
      const out = await memongo.readFile({
        relPath: typeof args.relPath === "string" ? args.relPath : "",
        agentId: typeof args.agentId === "string" ? args.agentId : undefined,
        from: typeof args.from === "number" ? args.from : undefined,
        lines: typeof args.lines === "number" ? args.lines : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "memongo_add") {
      const out = await memongo.add({
        content: typeof args.content === "string" ? args.content : "",
        agentId: typeof args.agentId === "string" ? args.agentId : undefined,
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "memongo_write_event") {
      const role = args.role;
      if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
        throw new Error("invalid role");
      }
      const out = await memongo.writeEvent({
        role,
        body: typeof args.body === "string" ? args.body : "",
        agentId: typeof args.agentId === "string" ? args.agentId : undefined,
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "memongo_profile") {
      const out = await memongo.profile({
        agentId: typeof args.agentId === "string" ? args.agentId : undefined,
        scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "memongo_status") {
      const out = await memongo.status(
        typeof args.agentId === "string" ? args.agentId : undefined,
      );
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
