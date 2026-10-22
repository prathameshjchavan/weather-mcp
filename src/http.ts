import crypto from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1"; // set HOST=0.0.0.0 to expose

// ---------- Auth config ----------
// MCP_API_KEYS: one or more keys, comma-separated (allows rotation without downtime)
const API_KEYS = (process.env.MCP_API_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

if (API_KEYS.length === 0) {
  console.error("MCP_API_KEYS is not set. Refusing to start without authentication.");
  console.error('Generate a key with: openssl rand -hex 32');
  process.exit(1);
}

// Optional: comma-separated list of allowed browser origins (e.g. https://app.example.com).
// Requests without an Origin header (curl, mcp-remote, server-to-server) are unaffected.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Hash to fixed length so timingSafeEqual works regardless of key length
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();
const KEY_HASHES = API_KEYS.map(sha256);

function isValidKey(candidate: string): boolean {
  const hash = sha256(candidate);
  let valid = false;
  for (const known of KEY_HASHES) {
    if (crypto.timingSafeEqual(hash, known)) valid = true; // no early exit
  }
  return valid;
}

// ---------- Middleware ----------
function checkOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const origin = req.header("origin");
  if (origin && ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Origin not allowed" },
      id: null,
    });
    return;
  }
  next();
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
  if (!match || !isValidKey(match[1])) {
    console.error(
      `[${new Date().toISOString()}] 401 ${req.method} ${req.originalUrl} ` +
        `tokenLength=${match ? match[1].length : "n/a"} ` +
        `ua="${req.header("user-agent") ?? "none"}"`
    );
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="weather-mcp"')
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

// ---------- App ----------
const app = express();

// Unauthenticated health check (for load balancers / uptime monitors)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Everything under /mcp: origin check -> auth -> JSON parsing
app.use("/mcp", checkOrigin, requireAuth, express.json());

// Stateless mode: a fresh server + transport per request, no session tracking.
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless servers don't support server-initiated streams or session teardown.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, HOST, () => {
  console.error(`Weather MCP server (Streamable HTTP, auth enabled) listening on http://${HOST}:${PORT}/mcp`);
});