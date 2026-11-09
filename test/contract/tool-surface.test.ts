import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../src/container.ts";
import { connectClient, tempDir, testContainer } from "../helpers.ts";

// tools/list, prompts and instructions are the contract the model sees. They are
// snapshotted so every change to a name, description or schema shows up in review;
// update with `pnpm test -u` and read the diff.

type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const MAX_TOOLS = 14; // UX-01
const MAX_DESCRIPTION = 2048;
const MAX_INSTRUCTIONS = 1500;
const SNAKE = /^[a-z][a-z0-9_]*$/;

// Tools that change local state (sign-in records, export jobs). They never write to Yandex.
const LOCAL_STATE_TOOLS: Readonly<Record<string, string>> = {
  metrika_connect: "creates a pending sign-in and, after consent, a stored connection",
  metrika_disconnect: "deletes a stored connection and its token",
  metrika_export_report: "creates a background export job and files",
  metrika_cancel_job: "cancels a background export job",
};
const DESTRUCTIVE_TOOLS: Readonly<Record<string, string>> = {
  metrika_disconnect: "the stored token is deleted and cannot be recovered",
  metrika_cancel_job: "the job's temporary files are removed",
};

let client: Client;
let container: Container;
let dir: ReturnType<typeof tempDir>;
let tools: Tool[];
let nextCursor: string | undefined;

beforeAll(async () => {
  dir = tempDir();
  container = await testContainer(dir.path);
  client = await connectClient(container);
  const listed = await client.listTools();
  tools = listed.tools;
  nextCursor = listed.nextCursor;
});

afterAll(async () => {
  await client.close();
  await container.close();
  dir.remove();
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

const pretty = (value: unknown): string => `${JSON.stringify(sortKeys(value), null, 2)}\n`;

/** Every property at any depth, with its JSON path, for description and naming checks. */
function properties(schema: JsonSchema, path = ""): { path: string; schema: JsonSchema }[] {
  const found: { path: string; schema: JsonSchema }[] = [];
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const childPath = path ? `${path}.${name}` : name;
    found.push({ path: childPath, schema: child });
    found.push(...nested(child, childPath));
  }
  return found;
}

function nested(schema: JsonSchema, path: string): { path: string; schema: JsonSchema }[] {
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  const found = properties(schema, path);
  if (schema.items) found.push(...nested(schema.items, `${path}[]`));
  for (const branch of branches) found.push(...nested(branch, path));
  return found;
}

/** The shape of a shared parameter without its per-tool description. */
function shape(schema: JsonSchema): unknown {
  const { description: _description, ...rest } = schema;
  return sortKeys(rest);
}

describe("tools/list snapshots", () => {
  it("matches the snapshot of every tool", async () => {
    for (const tool of tools) {
      await expect(pretty(tool)).toMatchFileSnapshot(`__toolsnaps__/${tool.name}.json`);
    }
  });

  it("matches the snapshot of per-tool sizes", async () => {
    const round = (bytes: number) => Math.round(bytes / 100) * 100;
    const sizes = Object.fromEntries(
      tools.map((t) => [t.name, round(Buffer.byteLength(JSON.stringify(t), "utf8"))]),
    );
    const total = round(Buffer.byteLength(JSON.stringify(tools), "utf8"));
    await expect(pretty({ tools: sizes, total })).toMatchFileSnapshot("__toolsnaps__/_sizes.json");
  });

  it("matches the snapshot of prompts and instructions", async () => {
    const { prompts } = await client.listPrompts();
    await expect(pretty(prompts)).toMatchFileSnapshot("__toolsnaps__/_prompts.json");
    await expect(`${client.getInstructions() ?? ""}\n`).toMatchFileSnapshot(
      "__toolsnaps__/_instructions.txt",
    );
  });
});

describe("tools/list invariants", () => {
  it("fits in one page and within the tool budget", () => {
    // Some clients read only the first page of tools/list.
    expect(nextCursor).toBeUndefined();
    expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS);
    // Tool definitions are loaded into every conversation: keep them compact.
    expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThan(96 * 1024);
  });

  it("uses prefixed snake_case names and unique titles", () => {
    for (const tool of tools) expect(tool.name).toMatch(/^metrika_[a-z0-9_]+$/);
    const titles = tools.map((t) => t.title);
    expect(titles.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("sets every annotation explicitly and honestly", () => {
    for (const tool of tools) {
      const a = tool.annotations ?? {};
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof a[hint as keyof typeof a], `${tool.name}.${hint}`).toBe("boolean");
      }
      expect(a.readOnlyHint, tool.name).toBe(!(tool.name in LOCAL_STATE_TOOLS));
      expect(a.destructiveHint, tool.name).toBe(tool.name in DESTRUCTIVE_TOOLS);
    }
    const names = new Set(tools.map((t) => t.name));
    for (const name of [...Object.keys(LOCAL_STATE_TOOLS), ...Object.keys(DESTRUCTIVE_TOOLS)]) {
      expect(names.has(name), `stale entry ${name}`).toBe(true);
    }
  });

  it("keeps descriptions and instructions within client limits", () => {
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
      expect(tool.description?.length ?? 0, tool.name).toBeLessThanOrEqual(MAX_DESCRIPTION);
    }
    expect(client.getInstructions()?.length ?? 0).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
  });

  it("declares an output schema for every tool", () => {
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });

  it("has object input schemas without top-level combinators", () => {
    // Some providers reject the whole tools/list when one input schema is a union.
    for (const tool of tools) {
      const schema = tool.inputSchema as JsonSchema;
      expect(schema.type, tool.name).toBe("object");
      expect(schema.anyOf ?? schema.oneOf ?? schema.allOf, tool.name).toBeUndefined();
    }
  });

  it("describes and snake_cases every input property, rejecting unknown keys", () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as JsonSchema;
      expect(schema.additionalProperties, tool.name).toBe(false);
      for (const { path, schema: prop } of properties(schema)) {
        const name = path.split(".").pop()?.replace("[]", "") ?? "";
        expect(name, `${tool.name}.${path}`).toMatch(SNAKE);
        expect(prop.description, `${tool.name}.${path} has no description`).toBeTruthy();
      }
    }
  });

  it("gives shared parameters the same shape in every tool", () => {
    for (const param of ["connection_id", "counter_id", "cursor"]) {
      const shapes = tools
        .map((t) => (t.inputSchema as JsonSchema).properties?.[param])
        .filter((p): p is JsonSchema => p !== undefined)
        .map((p) => JSON.stringify(shape(p)));
      expect(shapes.length, param).toBeGreaterThan(1);
      expect(new Set(shapes).size, param).toBe(1);
    }
  });
});

describe("input strictness", () => {
  it("rejects a misspelled argument instead of silently ignoring it", async () => {
    const result = await client.callTool({
      name: "metrika_list_counters",
      arguments: { connection_id: "conn_demo", serach: "shop" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects a misspelled key inside a nested period", async () => {
    const result = await client.callTool({
      name: "metrika_run_report",
      arguments: {
        connection_id: "conn_demo",
        counter_id: "10000001",
        period: { strat: "2026-10-01", end: "2026-10-07" },
      },
    });
    expect(result.isError).toBe(true);
  });
});
