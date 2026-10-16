import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseFrame, signature } from "./parser.js";
import { appendEvent } from "./store.js";
import type { Frame } from "./types.js";

/**
 * Injected into child Node processes via `NODE_OPTIONS="--import .../register.js"`.
 * Does two zero-config things:
 * 1. Intercepts `/@vite/client` (Vite / Storybook / Remix) and HTML dev responses
 *    to attach a tiny browser error listener (`window.onerror`, `unhandledrejection`,
 *    and React `console.error(err)`).
 * 2. Handles `POST /__agentsensor` on the dev server's own HTTP server, maps
 *    browser stack URLs (`http://localhost:6006/src/...`) back to real files in the
 *    workspace/monorepo, and appends them to `.agentsensor/errors.jsonl`.
 */

const root = process.env.AGENTSENSOR_ROOT || process.cwd();
const runId = process.env.AGENTSENSOR_RUN_ID || "browser";
const command = process.env.AGENTSENSOR_COMMAND || "dev";

const BROWSER_SNIPPET = `
;(function(){
  if (typeof window === "undefined" || window.__agentsensorInstalled) return;
  window.__agentsensorInstalled = true;
  var seen = {};
  function send(type, message, stack, context) {
    try {
      var key = type + "|" + message + "|" + (stack || "").slice(0, 120);
      var now = Date.now();
      if (seen[key] && now - seen[key] < 1500) return;
      seen[key] = now;
      var payload = JSON.stringify({
        type: type || "Error",
        message: String(message || ""),
        stack: String(stack || ""),
        url: String(location.href || ""),
        context: context || []
      });
      fetch("/__agentsensor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(function(){});
    } catch (_) {}
  }
  window.addEventListener("error", function(ev) {
    var err = ev && ev.error;
    var type = (err && err.name) || "Error";
    var msg = (err && err.message) || (ev && ev.message) || "Uncaught browser error";
    var stack = (err && err.stack) || (ev && ev.filename ? "    at " + ev.filename + ":" + (ev.lineno || 1) + ":" + (ev.colno || 1) : "");
    send(type, msg, stack, ["Browser URL: " + location.href]);
  });
  window.addEventListener("unhandledrejection", function(ev) {
    var r = ev && ev.reason;
    var type = (r && r.name) || "UnhandledRejection";
    var msg = (r && r.message) || String(r || "Unhandled promise rejection");
    var stack = (r && r.stack) || "";
    send(type, msg, stack, ["Browser URL: " + location.href]);
  });
  var origError = console.error;
  console.error = function() {
    try {
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (a && typeof a === "object" && typeof a.stack === "string" && typeof a.message === "string") {
          if (/^The above error occurred in/i.test(a.message)) break;
          send(a.name || "Error", a.message, a.stack, ["Browser URL: " + location.href]);
          break;
        }
      }
      if (
        arguments.length > 0 &&
        typeof arguments[0] === "string" &&
        /^Uncaught /i.test(arguments[0]) &&
        !/The above error occurred in/i.test(arguments[0])
      ) {
        var lines = arguments[0].split("\\n");
        var first = lines[0] || "";
        if (lines.some(function(l){ return /^\\s+at\\s+/.test(l); })) {
          send("Error", first, arguments[0], ["Browser URL: " + location.href]);
        }
      }
    } catch (_) {}
    return origError.apply(this, arguments);
  };
})();
`;

/**
 * In a monorepo (where workspace root is `/workspace/app` and Storybook/Vite runs in
 * `packages/ui`), a browser URL like `http://localhost:6006/src/stories/foo.tsx` resolves
 * to `src/stories/foo.tsx` relative to `process.cwd()` (`packages/ui`).
 * Make sure the path is relative to `root` so the agent can open the exact file from workspace root.
 */
function resolveMonorepoFile(file: string): string {
  if (!file || file.startsWith("node:") || file.includes("node_modules/")) return file;
  const fullInRoot = path.join(root, file);
  if (fs.existsSync(fullInRoot)) return file;

  const fullInCwd = path.join(process.cwd(), file);
  if (fs.existsSync(fullInCwd)) {
    const cleanRoot = root.replace(/^\/private\/(var|tmp)\//, "/$1/");
    const cleanFull = fullInCwd.replace(/^\/private\/(var|tmp)\//, "/$1/");
    const rel = path.relative(cleanRoot, cleanFull).split(path.sep).join("/");
    if (rel && !rel.startsWith("..")) return rel;
  }
  return file;
}

const FIREFOX_SAFARI_FRAME_RE = /^\s*(?:([^@]*)@)?(https?:\/\/[^\s]+):(\d+):(\d+)\s*$/;

function parseBrowserStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("at ")) {
      const f = parseFrame(`    ${line}`, root);
      if (f) {
        f.file = resolveMonorepoFile(f.file);
        frames.push(f);
      }
      continue;
    }
    const ff = FIREFOX_SAFARI_FRAME_RE.exec(line);
    if (ff) {
      const fn = ff[1]?.trim();
      const synthetic = fn
        ? `    at ${fn} (${ff[2]}:${ff[3]}:${ff[4]})`
        : `    at ${ff[2]}:${ff[3]}:${ff[4]}`;
      const f = parseFrame(synthetic, root);
      if (f) {
        f.file = resolveMonorepoFile(f.file);
        frames.push(f);
      }
    }
  }
  return frames;
}

function handleIngestRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        type?: string;
        message?: string;
        stack?: string;
        url?: string;
        context?: string[];
      };
      const type = (body.type || "Error").replace(/:$/, "");
      const message = (body.message || "Browser runtime error").trim();
      if (/^The above error occurred in/i.test(message)) {
        res.statusCode = 204;
        res.end();
        return;
      }
      let frames = parseBrowserStack(body.stack || "");
      if (frames.length === 0) {
        frames = [{ file: body.url || "browser", line: 1, column: 1, app: false }];
      }
      appendEvent(root, {
        kind: "error",
        id: signature(type, message, frames),
        ts: new Date().toISOString(),
        type,
        message,
        frames,
        context: Array.isArray(body.context) ? body.context : [],
        command: `${command} [browser]`,
        runId,
      });
    } catch {
      // ignore malformed payload
    }
    res.statusCode = 204;
    res.end();
  });
}

function shouldInjectViteClient(url: string | undefined): boolean {
  if (!url) return false;
  return (
    url.startsWith("/@vite/client") ||
    url.includes("/@vite/client?") ||
    url.startsWith("/_next/static/chunks/main-app") ||
    url.startsWith("/_next/static/chunks/webpack")
  );
}

function installHttpHook(): void {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (
    this: http.Server,
    event: string,
    ...args: unknown[]
  ): boolean {
    if (event === "request") {
      const req = args[0] as http.IncomingMessage | undefined;
      const res = args[1] as http.ServerResponse | undefined;
      if (req && res) {
        if (req.url === "/__agentsensor" && req.method === "POST") {
          handleIngestRequest(req, res);
          return true;
        }
        if (req.url === "/__agentsensor.js" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(BROWSER_SNIPPET);
          return true;
        }
        if (req.method === "GET" && shouldInjectViteClient(req.url)) {
          // Disable compression for this single dev client script so we can append our listener cleanly
          delete req.headers["accept-encoding"];
          const origEnd = res.end.bind(res);
          const origSetHeader = res.setHeader.bind(res);
          res.setHeader = ((name: string, value: number | string | readonly string[]) => {
            if (name.toLowerCase() === "content-length") return res;
            if (name.toLowerCase() === "etag") return res;
            return origSetHeader(name, value);
          }) as typeof res.setHeader;

          res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
            try {
              res.removeHeader("content-length");
              res.removeHeader("etag");
              if (chunk && typeof chunk !== "function") {
                res.write(chunk as string | Buffer, encoding as BufferEncoding);
              }
              res.write(`\n${BROWSER_SNIPPET}\n`);
              return (origEnd as (cb?: () => void) => http.ServerResponse)(
                typeof chunk === "function"
                  ? (chunk as () => void)
                  : typeof encoding === "function"
                    ? (encoding as () => void)
                    : (cb as (() => void) | undefined),
              );
            } catch {
              return (origEnd as (...a: unknown[]) => http.ServerResponse)(chunk, encoding, cb);
            }
          }) as typeof res.end;
        }
      }
    }
    return origEmit.apply(this, [event, ...args]);
  };
}

try {
  installHttpHook();
} catch {
  // Never break the user's dev server
}
