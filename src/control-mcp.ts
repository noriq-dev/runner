#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const tools = [
  {
    name: "get_job_state",
    description: "Read the compact durable state for this job and task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "record_task_plan",
    description: "Record the bounded execution plan for the current task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["plan"],
      properties: { plan: { type: "string", maxLength: 20000 } },
    },
  },
  {
    name: "delegate",
    description:
      "Request one fresh builder, reviewer, or repairer invocation. The deterministic supervisor decides whether it is permitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["role", "instructions"],
      properties: {
        role: { enum: ["builder", "reviewer", "repairer"] },
        instructions: { type: "string", maxLength: 20000 },
      },
    },
  },
  {
    name: "run_checks",
    description: "Request the configured deterministic project checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "inspect_diff",
    description: "Request the bounded final diff and changed paths.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "ask_human",
    description:
      "Publish one durable blocking question and wait for its answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: { question: { type: "string", maxLength: 20000 } },
    },
  },
  {
    name: "request_completion",
    description:
      "Ask the supervisor to validate and complete the current task or job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string", maxLength: 20000 } },
    },
  },
] as const;

async function callTool(name: string, args: unknown): Promise<unknown> {
  const statePath = process.env.NORIQ_CONTROL_STATE;
  const actionsPath = process.env.NORIQ_CONTROL_ACTIONS;
  if (!statePath || !actionsPath)
    throw new Error("Runner Control MCP is missing its confined state paths");
  if (name === "get_job_state")
    return JSON.parse(await readFile(statePath, "utf8"));
  if (!tools.some((tool) => tool.name === name))
    throw new Error(`unknown Runner Control tool ${name}`);
  await appendFile(
    actionsPath,
    `${JSON.stringify({ at: new Date().toISOString(), name, args })}\n`,
    { mode: 0o600 },
  );
  return {
    recorded: true,
    note: "The deterministic supervisor will validate this request.",
  };
}

function respond(
  id: string | number | undefined,
  result?: unknown,
  error?: unknown,
): void {
  if (id === undefined) return;
  const message = error
    ? {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
input.on("line", async (line) => {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.method === "initialize")
      respond(request.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "noriq-runner-control", version: "1.0.0" },
      });
    else if (request.method === "notifications/initialized") return;
    else if (request.method === "ping") respond(request.id, {});
    else if (request.method === "tools/list") respond(request.id, { tools });
    else if (request.method === "tools/call") {
      const params = request.params ?? {};
      const value = await callTool(String(params.name), params.arguments ?? {});
      respond(request.id, {
        content: [{ type: "text", text: JSON.stringify(value) }],
      });
    } else
      respond(
        request.id,
        undefined,
        new Error(`unsupported method ${request.method}`),
      );
  } catch (error) {
    respond(undefined, undefined, error);
  }
});
