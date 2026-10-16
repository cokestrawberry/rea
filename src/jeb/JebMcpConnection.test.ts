import { createServer, type ServerResponse } from "node:http";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  classifyJebCallFailure,
  decodeJebToolResult,
  createStreamableHttpJebMcpConnection,
  JEB_CALL_TIMEOUT_MS,
  type JebMcpConnection,
} from "./JebMcpConnection.js";
import {
  AnalysisProtocolError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";

describe("decodeJebToolResult", () => {
  it("passes refusal envelopes through so the provider preserves the engine reason", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        structuredContent: {
          success: false,
          message: "The decompilation failed because the item is missing",
        },
      }),
    ).toEqual({
      success: false,
      message: "The decompilation failed because the item is missing",
    });
  });

  it.each([
    [
      "structured content",
      {
        isError: true,
        structuredContent: {
          success: true,
          input_files: [],
          units: [],
        },
      },
    ],
    [
      "JSON text",
      {
        isError: true,
        content: [{ type: "text", text: '{"success":true}' }],
      },
    ],
  ] as const)("rejects error-marked success in %s", (_source, result) => {
    expect(() => decodeJebToolResult(result)).toThrow(AnalysisProtocolError);
  });

  it("preserves an explicit JEB failure envelope returned as JSON text", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"success":false,"message":"missing"}' },
        ],
      }),
    ).toEqual({ success: false, message: "missing" });
  });

  it("decodes a single JSON text block", () => {
    expect(
      decodeJebToolResult({
        content: [
          { type: "text", text: '{"success":true,"text":"int x(){}"}' },
        ],
      }),
    ).toEqual({ success: true, text: "int x(){}" });
  });

  it("keeps non-JSON success text as an observed string", () => {
    expect(
      decodeJebToolResult({
        content: [{ type: "text", text: "plain observation" }],
      }),
    ).toBe("plain observation");
  });

  it("rejects unparseable error text as a protocol failure with the engine text", () => {
    expect(() =>
      decodeJebToolResult({
        isError: true,
        content: [{ type: "text", text: "engine exploded" }],
      }),
    ).toThrow(/engine exploded/);
  });

  it("rejects contentless results instead of inventing an observation", () => {
    expect(() => decodeJebToolResult({ content: [] })).toThrow(
      AnalysisProtocolError,
    );
  });
});

it("refuses HTTP redirects before sending requests to another endpoint", async () => {
  let followed = false;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") followed = true;
    request.resume();
    response.writeHead(307, { Location: "/redirected" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  const connection = createStreamableHttpJebMcpConnection(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  try {
    await expect(connection.connect()).rejects.toThrow();
    expect(followed).toBe(false);
  } finally {
    await connection.close();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) =>
        cause === undefined ? resolve() : reject(cause),
      ),
    );
  }
});

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({ protocolVersion: z.string().optional() })
    .passthrough()
    .optional(),
});

/** Serve a JEB MCP endpoint that answers every tools/call through `answerCall`. */
const withJebEndpoint = async (
  answerCall: (response: ServerResponse, id: string | number) => void,
  run: (connection: JebMcpConnection) => Promise<void>,
): Promise<void> => {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = rpcRequest.parse(JSON.parse(body));
    if (input.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (input.method === "tools/call") {
      answerCall(response, input.id);
      return;
    }
    const result =
      input.method === "initialize"
        ? {
            protocolVersion: input.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "jeb-fixture", version: "0" },
          }
        : {
            tools: [
              {
                name: "list_units",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  const connection = createStreamableHttpJebMcpConnection(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  try {
    await run(connection);
  } finally {
    await connection.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) =>
        cause === undefined ? resolve() : reject(cause),
      ),
    );
  }
};

describe("JEB tool call failures", () => {
  it("reports an HTTP error from a connected endpoint as a protocol failure", async () => {
    await withJebEndpoint(
      (response) => {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("engine fault");
      },
      async (connection) => {
        const failure = await connection
          .call("list_units", {})
          .catch((cause: unknown) => cause);
        if (!(failure instanceof AnalysisProtocolError))
          throw new Error("Expected a protocol failure");
        expect(failure.message).toContain("engine fault");
      },
    );
  });

  it("reports a JSON-RPC error from a connected endpoint as a protocol failure", async () => {
    await withJebEndpoint(
      (response, id) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: "engine fault" },
          }),
        );
      },
      async (connection) => {
        const failure = await connection
          .call("list_units", {})
          .catch((cause: unknown) => cause);
        if (!(failure instanceof AnalysisProtocolError))
          throw new Error("Expected a protocol failure");
        expect(failure.message).toContain("engine fault");
      },
    );
  });

  it("reports an SDK request timeout as an analysis timeout", () => {
    const cause = new SdkError(
      SdkErrorCode.RequestTimeout,
      "Request timed out",
      { timeout: JEB_CALL_TIMEOUT_MS },
    );
    const failure = classifyJebCallFailure("open_project", cause);
    if (!(failure instanceof AnalysisTimeoutError))
      throw new Error("Expected a timeout failure");
    expect(failure.operation).toBe("jeb_mcp:open_project");
    expect(failure.timeoutMs).toBe(JEB_CALL_TIMEOUT_MS);
    expect(failure.cause).toBe(cause);
  });

  it("leaves an unreachable endpoint unclassified for the provider", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8425");
    expect(classifyJebCallFailure("list_units", cause)).toBe(cause);
  });
});
