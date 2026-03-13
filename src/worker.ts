/**
 * Cloudflare Workers entry point for BookStack MCP Server.
 *
 * Endpoints:
 *   GET  /sse               – SSE transport for Claude Desktop (requires Durable Objects / paid CF plan)
 *   POST /messages          – MCP message delivery for SSE sessions (?sessionId=…)
 *   POST /mcp               – Direct JSON-RPC for testing
 *   GET  /health            – Health check
 *
 * Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "bookstack": { "url": "https://<your-worker>.workers.dev/sse" }
 *     }
 *   }
 *
 * Required env vars (set in CF dashboard):
 *   BOOKSTACK_BASE_URL  – e.g. https://bookstack.example.com/api
 *   BOOKSTACK_API_TOKEN – set as a Secret
 */

import { BookStackMCPServer } from './server';

// Minimal Cloudflare Workers type declarations — avoids requiring @cloudflare/workers-types as a devDependency
interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(request: Request): Promise<Response> }
interface DurableObjectNamespace {
  newUniqueId(): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectState {
  id: DurableObjectId;
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  BOOKSTACK_BASE_URL: string;
  BOOKSTACK_API_TOKEN: string;
  BOOKSTACK_TIMEOUT?: string;
  SERVER_NAME?: string;
  SERVER_VERSION?: string;
  RATE_LIMIT_REQUESTS_PER_MINUTE?: string;
  RATE_LIMIT_BURST_LIMIT?: string;
  LOG_LEVEL?: string;
  // Durable Object binding (declared in wrangler.toml)
  MCP_SESSIONS: DurableObjectNamespace;
}

type JSONRPCMessage = Record<string, unknown>;

// ─── Transports ──────────────────────────────────────────────────────────────

/**
 * Request/response transport for POST /mcp (stateless, one request = one response).
 */
class RequestTransport {
  private queue: JSONRPCMessage[] = [];
  private waiters: Array<(m: JSONRPCMessage) => void> = [];
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async send(m: JSONRPCMessage): Promise<void> {
    const w = this.waiters.shift();
    if (w) w(m); else this.queue.push(m);
  }
  inject(m: JSONRPCMessage): void { this.onmessage?.(m as any); }
  receive(): Promise<JSONRPCMessage> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise(r => this.waiters.push(r));
  }
}

/**
 * SSE transport: MCP responses are written as `event: message` SSE events.
 * Lives inside a Durable Object so the stream writer persists across requests.
 */
class SSETransport {
  private enc = new TextEncoder();
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  constructor(private writer: WritableStreamDefaultWriter<Uint8Array>) {}
  async start(): Promise<void> {}
  async send(m: JSONRPCMessage): Promise<void> {
    try {
      await this.writer.write(
        this.enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`)
      );
    } catch { this.onclose?.(); }
  }
  async close(): Promise<void> { try { await this.writer.close(); } catch {} }
  inject(m: JSONRPCMessage): void { this.onmessage?.(m as any); }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setProcessEnv(env: Omit<Env, 'MCP_SESSIONS'>): void {
  // Guard every assignment — assigning undefined writes the string "undefined" to process.env
  if (env.BOOKSTACK_BASE_URL) process.env.BOOKSTACK_BASE_URL = env.BOOKSTACK_BASE_URL;
  if (env.BOOKSTACK_API_TOKEN) process.env.BOOKSTACK_API_TOKEN = env.BOOKSTACK_API_TOKEN;
  if (env.BOOKSTACK_TIMEOUT) process.env.BOOKSTACK_TIMEOUT = env.BOOKSTACK_TIMEOUT;
  if (env.SERVER_NAME) process.env.SERVER_NAME = env.SERVER_NAME;
  if (env.SERVER_VERSION) process.env.SERVER_VERSION = env.SERVER_VERSION;
  if (env.RATE_LIMIT_REQUESTS_PER_MINUTE) process.env.RATE_LIMIT_REQUESTS_PER_MINUTE = env.RATE_LIMIT_REQUESTS_PER_MINUTE;
  if (env.RATE_LIMIT_BURST_LIMIT) process.env.RATE_LIMIT_BURST_LIMIT = env.RATE_LIMIT_BURST_LIMIT;
  if (env.LOG_LEVEL) process.env.LOG_LEVEL = env.LOG_LEVEL;
}

// ─── Durable Object: one instance per SSE session ────────────────────────────

/**
 * MCPSession holds an open SSE stream and the MCP server for one client connection.
 * A new DO instance is created for every GET /sse request.
 *
 * NOTE: Durable Objects require a Cloudflare Workers Paid plan.
 */
export class MCPSession {
  private transport: SSETransport | null = null;
  private mcpServer: BookStackMCPServer | null = null;
  private enc = new TextEncoder();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return this.handleSSE();
    }
    if (request.method === 'POST') {
      return this.handleMessage(request);
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  private handleSSE(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    this.transport = new SSETransport(writer);
    setProcessEnv(this.env);
    this.mcpServer = new BookStackMCPServer();

    this.mcpServer.connectTransport(this.transport)
      .then(async () => {
        // Tell the client where to POST messages
        const sessionId = this.state.id.toString();
        await writer.write(
          this.enc.encode(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`)
        );
        // Send periodic pings to keep the connection alive
        this.schedulePing(writer);
      })
      .catch((err: Error) => writer.abort(err));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        ...CORS_HEADERS,
      },
    });
  }

  private schedulePing(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    const ping = async (): Promise<void> => {
      try {
        await writer.write(this.enc.encode(': ping\n\n'));
        // Schedule next ping after 20s
        await new Promise(r => setTimeout(r, 20_000));
        ping();
      } catch { /* stream closed */ }
    };
    ping();
  }

  private async handleMessage(request: Request): Promise<Response> {
    if (!this.transport) {
      return new Response('Session not ready', { status: 400, headers: CORS_HEADERS });
    }
    const body = await request.json() as JSONRPCMessage;
    this.transport.inject(body);
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
}

// ─── Main Worker ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: CORS_HEADERS });
    }

    // ── SSE transport (Claude Desktop) ─────────────────────────────────────
    if (url.pathname === '/sse' && request.method === 'GET') {
      const id = env.MCP_SESSIONS.newUniqueId();
      return env.MCP_SESSIONS.get(id).fetch(request);
    }

    if (url.pathname === '/messages' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response('Missing sessionId', { status: 400, headers: CORS_HEADERS });
      }
      try {
        const id = env.MCP_SESSIONS.idFromString(sessionId);
        return env.MCP_SESSIONS.get(id).fetch(request);
      } catch {
        return new Response('Invalid sessionId', { status: 400, headers: CORS_HEADERS });
      }
    }

    // ── Direct JSON-RPC (for testing with curl) ───────────────────────────
    if (url.pathname === '/mcp' && request.method === 'POST') {
      let body: JSONRPCMessage | undefined;
      try {
        body = await request.json() as JSONRPCMessage;
      } catch {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      try {
        setProcessEnv(env);
        const transport = new RequestTransport();
        const server = new BookStackMCPServer();
        await server.connectTransport(transport);
        transport.inject(body!);
        const response = await Promise.race([
          transport.receive(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 30_000)
          ),
        ]);
        return Response.json(response, { headers: CORS_HEADERS });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Internal server error';
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32603, message: msg }, id: body?.id ?? null },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
