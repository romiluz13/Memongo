import { MemongoClient } from "@romiluz/memongo-platform";
/**
 * Vercel AI SDK–compatible tool definitions that call the Memongo HTTP API
 * (same integration role as @supermemory/tools).
 */
import { tool } from "ai";
import { z } from "zod";

const searchSchema = z.object({
  query: z.string(),
  agentId: z.string().optional(),
  limit: z.number().optional(),
  minScore: z.number().optional(),
});

const searchKbSchema = z.object({
  query: z.string(),
  agentId: z.string().optional(),
  limit: z.number().optional(),
});

const readFileSchema = z.object({
  relPath: z.string(),
  agentId: z.string().optional(),
  from: z.number().optional(),
  lines: z.number().optional(),
});

const addSchema = z.object({
  content: z.string(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

const writeEventSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  body: z.string(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

const profileSchema = z.object({
  agentId: z.string().optional(),
  scopeRef: z.string().optional(),
});

const statusSchema = z.object({
  agentId: z.string().optional(),
});

export function createMemongoTools(client: MemongoClient) {
  return {
    memongo_search: tool({
      description: "Search Memongo memory (MongoDB-backed hybrid retrieval).",
      inputSchema: searchSchema,
      execute: async (input) => {
        const { results } = await client.search(input);
        return { results };
      },
    }),
    memongo_search_kb: tool({
      description: "Search Memongo knowledge base chunks only.",
      inputSchema: searchKbSchema,
      execute: async (input) => {
        const { results } = await client.searchKB({
          query: input.query,
          agentId: input.agentId,
          limit: input.limit,
        });
        return { results };
      },
    }),
    memongo_read_file: tool({
      description: "Read a memory file path or structured: URI (memory_get parity).",
      inputSchema: readFileSchema,
      execute: async (input) => client.readFile(input),
    }),
    memongo_add: tool({
      description: "Append a user message to conversational memory.",
      inputSchema: addSchema,
      execute: async (input) => client.add(input),
    }),
    memongo_write_event: tool({
      description: "Write a full conversation event (any role).",
      inputSchema: writeEventSchema,
      execute: async (input) => client.writeEvent(input),
    }),
    memongo_profile: tool({
      description: "Synthesize a profile from Memongo memory.",
      inputSchema: profileSchema,
      execute: async (input) => client.profile(input),
    }),
    memongo_status: tool({
      description: "Memory provider status (model, backend, health).",
      inputSchema: statusSchema,
      execute: async (input) => client.status(input.agentId),
    }),
  };
}
