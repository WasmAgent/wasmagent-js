import { z } from "zod";
import type { ToolDefinition } from "../tools/types.js";
import type { KvBackend } from "../checkpoint/index.js";

/**
 * L2-2: File-backed Memory Tool for cross-session learning.
 *
 * Provides read/write/list/delete operations backed by any KvBackend
 * (InMemory, Cloudflare KV, Redis, etc.). The agent can persist facts,
 * preferences, and partial results across separate run() calls.
 *
 * All write operations key off a namespace prefix to avoid collisions
 * with checkpoint data using the same KvBackend.
 *
 * Usage:
 *   const kv = new Map<string, string>();
 *   const memoryTool = createMemoryTool({ backend: { ... } });
 *   const agent = new ToolCallingAgent({ tools: [memoryTool], ... });
 */

const MEMORY_PREFIX = "memory:";

/** Operations supported by the memory tool. */
const MemoryOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("read"),
    key: z.string().min(1).describe("The key to read from memory"),
  }),
  z.object({
    op: z.literal("write"),
    key: z.string().min(1).describe("The key to write to memory"),
    value: z.string().describe("The value to store (string — serialise objects before writing)"),
  }),
  z.object({
    op: z.literal("list"),
    prefix: z.string().optional().describe("Optional prefix to filter keys"),
  }),
  z.object({
    op: z.literal("delete"),
    key: z.string().min(1).describe("The key to delete from memory"),
  }),
]);

type MemoryOperation = z.infer<typeof MemoryOperationSchema>;

export interface MemoryToolOptions {
  /** KV backend for persistence. Use KvCheckpointer's KvBackend or any Map-like store. */
  backend: KvBackend & { list?: (prefix: string) => Promise<string[]> };
  /** Whether write/delete operations require human approval. Default: false. */
  needsApproval?: boolean;
}

/**
 * Create a MemoryTool instance backed by the provided KvBackend.
 *
 * The tool exposes four operations to the agent:
 *  - read(key)         → returns the stored value or null
 *  - write(key, value) → stores a value persistently
 *  - list(prefix?)     → lists all keys (optionally filtered by prefix)
 *  - delete(key)       → removes a key
 */
export function createMemoryTool(opts: MemoryToolOptions): ToolDefinition<MemoryOperation, string> {
  const { backend, needsApproval = false } = opts;

  const tool: ToolDefinition<MemoryOperation, string> = {
    name: "memory",
    description:
      "Persist and retrieve facts across agent runs. Use write() to save information for later, read() to retrieve it, list() to see what's stored, and delete() to remove entries.",
    inputSchema: MemoryOperationSchema,
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    async forward(input: MemoryOperation): Promise<string> {
      switch (input.op) {
        case "read": {
          const value = await backend.get(MEMORY_PREFIX + input.key);
          return value !== null ? value : `(no value stored for key: ${input.key})`;
        }
        case "write": {
          await backend.put(MEMORY_PREFIX + input.key, input.value);
          return `Stored: ${input.key}`;
        }
        case "list": {
          if (backend.list) {
            const prefix = input.prefix ?? "";
            const keys = await backend.list(MEMORY_PREFIX + prefix);
            const stripped = keys.map((k) => k.slice(MEMORY_PREFIX.length));
            return stripped.length > 0 ? stripped.join("\n") : "(no keys found)";
          }
          return "(list not supported by this backend)";
        }
        case "delete": {
          await backend.delete(MEMORY_PREFIX + input.key);
          return `Deleted: ${input.key}`;
        }
      }
    },
  };
  if (needsApproval) tool.needsApproval = true;
  return tool;
}

/**
 * In-memory KV backend for testing and single-process use.
 * Supports the optional list() operation.
 */
export class MapKvBackend implements KvBackend {
  readonly #store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.#store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.#store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#store.keys()].filter((k) => k.startsWith(prefix));
  }

  get size(): number {
    return this.#store.size;
  }
}
