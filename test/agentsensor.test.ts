import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv, parseCliArgs, runCommand } from "../src/cli.js";
import {
  collapseFrames,
  evaluateCheckFix,
  formatErrorDetailReport,
  formatRuntimeErrorsReport,
} from "../src/mcp.js";
import { ErrorDetector, type ParsedError, signature } from "../src/parser.js";
import {
  appendEvent,
  ensureSensorDir,
  readEvents,
  resolveProjectRoot,
  summarizeErrors,
} from "../src/store.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsensor-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ErrorDetector & V8 stack trace parser", () => {
  it("parses a standard Node/Express TypeError with ANSI codes and preceding context", () => {
    const root = "/workspace/my-app";
    const detected: ParsedError[] = [];
    const detector = new ErrorDetector({
      root,
      onError: (err) => detected.push(err),
    });

    const sample = [
      "\u001b[32m[INFO]\u001b[39m Server listening on :3000",
      "GET /users/42",
      "Fetching user record from cache...",
      "TypeError: Cannot read properties of undefined (reading 'email')",
      "    at getUserEmail (/workspace/my-app/src/routes/users.ts:24:17)",
      "    at Layer.handle [as handle_request] (/workspace/my-app/node_modules/express/lib/router/layer.js:95:5)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "Request failed with status 500",
      "",
    ].join("\n");

    detector.write(sample);
    detector.end();

    expect(detected).toHaveLength(1);
    const err = detected[0]!;
    expect(err.type).toBe("TypeError");
    expect(err.message).toBe("Cannot read properties of undefined (reading 'email')");
    expect(err.context).toEqual([
      "[INFO] Server listening on :3000",
      "GET /users/42",
      "Fetching user record from cache...",
    ]);
    expect(err.frames).toHaveLength(3);
    expect(err.frames[0]).toEqual({
      fn: "getUserEmail",
      file: "src/routes/users.ts",
      line: 24,
      column: 17,
      app: true,
    });
    expect(err.frames[1]?.app).toBe(false);
    expect(err.frames[2]?.app).toBe(false);
  });

  it("produces the same signature ID when line numbers shift or numeric IDs in message change", () => {
    const framesBefore = [
      { fn: "chargeCard", file: "src/billing.ts", line: 10, column: 5, app: true },
    ];
    const framesAfterEdit = [
      { fn: "chargeCard", file: "src/billing.ts", line: 18, column: 5, app: true },
    ];

    const id1 = signature("Error", "Order 1042 failed for user 99", framesBefore);
    const id2 = signature("Error", "Order 8888 failed for user 12", framesAfterEdit);
    expect(id1).toBe(id2);
  });

  it("handles Next.js webpack-internal:// URLs and file:// URLs", () => {
    const root = "/Users/dev/next-app";
    const detected: ParsedError[] = [];
    const detector = new ErrorDetector({
      root,
      onError: (err) => detected.push(err),
    });

    const output = [
      " ⨯ ReferenceError: window is not defined",
      "    at Page (webpack-internal:///(rsc)/./app/dashboard/page.tsx:14:3)",
      "    at render (file:///Users/dev/next-app/src/render.ts:9:11)",
      "",
    ].join("\n");

    detector.write(output);
    detector.end();

    expect(detected).toHaveLength(1);
    expect(detected[0]?.frames[0]).toMatchObject({
      fn: "Page",
      file: "app/dashboard/page.tsx",
      line: 14,
      app: true,
    });
    expect(detected[0]?.frames[1]).toMatchObject({
      fn: "render",
      file: "src/render.ts",
      line: 9,
      app: true,
    });
  });

  it("parses pnpm/turborepo prefixed Storybook errors and extracts inline file paths", () => {
    const root = "/workspace/acme-ui";
    const detected: ParsedError[] = [];
    const detector = new ErrorDetector({
      root,
      onError: (err) => detected.push(err),
    });

    const storybookOutput = [
      "dev: 3:30:30 pm [vite] page reload src/utils/cn.ts",
      "packages/ui dev: WARN 🚨 Unable to index ./src/stories/button.stories.tsx:",
      "packages/ui dev: WARN   NoMetaError: CSF: missing default export /workspace/acme-ui/packages/ui/src/stories/button.stories.tsx (line 1, col 0)",
      "packages/ui dev: WARN ",
      "packages/ui dev: WARN More info: https://storybook.js.org/docs/writing-stories#default-export",
      "packages/ui dev: WARN     at X.parse (/workspace/acme-ui/node_modules/.pnpm/@storybook+core@8.6.14/node_modules/@storybook/core/dist/csf-tools/index.cjs:494:13)",
      "packages/ui dev: WARN     at async Promise.all (index 30)",
      "packages/ui dev: 3:31:30 pm [vite] page reload virtual:/@storybook/builder-vite/storybook-stories.js",
      "",
    ].join("\n");

    detector.write(storybookOutput);
    detector.end();

    expect(detected).toHaveLength(1);
    const err = detected[0]!;
    expect(err.type).toBe("NoMetaError");
    expect(err.message).toContain("CSF: missing default export");
    // Top frame extracted from the inline file path inside the message!
    expect(err.frames[0]).toEqual({
      file: "packages/ui/src/stories/button.stories.tsx",
      line: 1,
      column: 0,
      app: true,
    });
  });

  it("parses Vite / Remix internal server & pre-transform errors without V8 stack frames", () => {
    const root = "/Users/dev/remix-app";
    const detected: ParsedError[] = [];
    const detector = new ErrorDetector({
      root,
      onError: (err) => detected.push(err),
    });

    const viteOutput = [
      '3:33:31 pm [vite] Internal server error: Failed to resolve import "./missing-icon" from "src/components/accordion.tsx". Does the file exist?',
      "  Plugin: vite:import-analysis",
      "  File: /Users/dev/remix-app/src/components/accordion.tsx:4:24",
      "  2  |  import * as React from 'react';",
      "  3  |  import { ChevronDown } from './missing-icon';",
      "     |                               ^",
      "3:33:35 pm [vite] page reload src/components/accordion.tsx",
      "",
    ].join("\n");

    detector.write(viteOutput);
    detector.end();

    expect(detected).toHaveLength(1);
    const err = detected[0]!;
    expect(err.type).toBe("ViteError");
    expect(err.message).toContain("Failed to resolve import");
    expect(err.frames[0]).toEqual({
      file: "src/components/accordion.tsx",
      line: 4,
      column: 24,
      app: true,
    });
  });

  it("parses Next.js compile errors and TypeScript compiler errors", () => {
    const root = "/Users/dev/next-app";
    const detected: ParsedError[] = [];
    const detector = new ErrorDetector({
      root,
      onError: (err) => detected.push(err),
    });

    const nextAndTsOutput = [
      " ⨯ ./src/components/Accordion.tsx:18:12",
      "ReferenceError: AccordionHeader is not defined",
      "  16 |   return (",
      "  17 |     <div>",
      "> 18 |       <AccordionHeader />",
      "",
      "src/components/Accordion.tsx(22,7): error TS2304: Cannot find name 'AccordionContent'.",
      "",
    ].join("\n");

    detector.write(nextAndTsOutput);
    detector.end();

    expect(detected).toHaveLength(2);
    expect(detected[0]?.type).toBe("CompileError");
    expect(detected[0]?.frames[0]).toEqual({
      file: "src/components/Accordion.tsx",
      line: 18,
      column: 12,
      app: true,
    });
    expect(detected[0]?.message).toContain("ReferenceError: AccordionHeader is not defined");

    expect(detected[1]?.type).toBe("TypeScriptError[TS2304]");
    expect(detected[1]?.frames[0]).toEqual({
      file: "src/components/Accordion.tsx",
      line: 22,
      column: 7,
      app: true,
    });
  });
});

describe("Store & Project Root Resolution", () => {
  it("auto-adds .agentsensor/ to existing .gitignore and deduplicates error summaries", () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
    ensureSensorDir(root);

    const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".agentsensor/");

    appendEvent(root, {
      kind: "error",
      id: "abc1234567",
      ts: "2026-10-16T10:00:00.000Z",
      type: "TypeError",
      message: "boom",
      frames: [{ fn: "handler", file: "src/index.ts", line: 12, column: 3, app: true }],
      context: ["GET /test"],
      command: "npm run dev",
      runId: "r1",
    });

    appendEvent(root, {
      kind: "error",
      id: "abc1234567",
      ts: "2026-10-16T10:01:00.000Z",
      type: "TypeError",
      message: "boom",
      frames: [{ fn: "handler", file: "src/index.ts", line: 12, column: 3, app: true }],
      context: ["GET /test?retry=1"],
      command: "npm run dev",
      runId: "r1",
    });

    const events = readEvents(root);
    const summaries = summarizeErrors(events);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.count).toBe(2);
    expect(summaries[0]?.firstSeen).toBe("2026-10-16T10:00:00.000Z");
    expect(summaries[0]?.lastSeen).toBe("2026-10-16T10:01:00.000Z");
  });

  it("resolves project root via MCP roots, explicit path, and upward directory walk", () => {
    const root = makeTmpDir();
    ensureSensorDir(root);
    const nested = path.join(root, "src", "controllers");
    fs.mkdirSync(nested, { recursive: true });

    // Upward walk from nested dir finds root with .agentsensor
    expect(resolveProjectRoot({ cwd: nested })).toBe(root);

    // MCP roots URI resolution
    expect(
      resolveProjectRoot({
        mcpRoots: [{ uri: `file://${root}` }],
        cwd: os.tmpdir(),
      }),
    ).toBe(root);

    // Explicit project overrides all
    const other = makeTmpDir();
    expect(
      resolveProjectRoot({
        explicitProject: other,
        mcpRoots: [{ uri: `file://${root}` }],
      }),
    ).toBe(other);
  });
});

describe("MCP tool formatters & check_fix verdicts", () => {
  it("formats get_runtime_errors, get_error_detail, and check_fix accurately", () => {
    const root = makeTmpDir();
    appendEvent(root, {
      kind: "run_start",
      ts: "2026-10-16T12:00:00.000Z",
      runId: "run1",
      command: "node server.js",
      pid: 1234,
      cwd: root,
    });
    appendEvent(root, {
      kind: "error",
      id: "err001",
      ts: "2026-10-16T12:01:00.000Z",
      type: "RangeError",
      message: "Invalid status code: 999",
      frames: [
        { fn: "sendResponse", file: "src/http.ts", line: 44, column: 9, app: true },
        { fn: "Server.emit", file: "node:events", line: 514, column: 28, app: false },
        { fn: "parserOnIncoming", file: "node:_http_server", line: 1100, column: 12, app: false },
      ],
      context: ["Incoming POST /checkout"],
      command: "node server.js",
      runId: "run1",
    });

    const summaryText = formatRuntimeErrorsReport(root);
    expect(summaryText).toContain("[err001] (OPEN) RangeError: Invalid status code: 999");
    expect(summaryText).toContain("src/http.ts:44:9");

    // Verify .agentsensor/status.json has 1 open, 0 resolved
    const statusBefore = JSON.parse(
      fs.readFileSync(path.join(root, ".agentsensor", "status.json"), "utf8"),
    );
    expect(statusBefore.openCount).toBe(1);
    expect(statusBefore.resolvedCount).toBe(0);
    expect(statusBefore.open[0]?.id).toBe("err001");

    const detailText = formatErrorDetailReport(root, "err001");
    expect(detailText).toContain("at sendResponse (src/http.ts:44:9) [app]");
    expect(detailText).toContain("(2 library/internal frames collapsed)");
    expect(detailText).toContain("Incoming POST /checkout");

    // Not seen since the error's timestamp -> marks it resolved and moves it to status.json resolved!
    const check1 = evaluateCheckFix(root, "err001");
    expect(check1.status).toBe("not_seen");

    const statusResolved = JSON.parse(
      fs.readFileSync(path.join(root, ".agentsensor", "status.json"), "utf8"),
    );
    expect(statusResolved.openCount).toBe(0);
    expect(statusResolved.resolvedCount).toBe(1);
    expect(statusResolved.resolved[0]?.id).toBe("err001");

    // Once resolved, get_runtime_errors hides it unless it reoccurs after the resolved timestamp
    expect(formatRuntimeErrorsReport(root)).toContain("No active runtime errors found.");

    // If the error happens again later, it automatically moves back to OPEN in status.json
    const reoccurTs = new Date(Date.now() + 5000).toISOString();
    appendEvent(root, {
      kind: "error",
      id: "err001",
      ts: reoccurTs,
      type: "RangeError",
      message: "Invalid status code: 999",
      frames: [{ fn: "sendResponse", file: "src/http.ts", line: 46, column: 9, app: true }],
      context: ["Incoming POST /checkout"],
      command: "node server.js",
      runId: "run1",
    });

    const check2 = evaluateCheckFix(root, "err001", "2026-10-16T12:02:00.000Z");
    expect(check2.status).toBe("still_failing");
    expect(check2.reoccurrences).toBe(1);
    expect(formatRuntimeErrorsReport(root)).toContain("[err001] (OPEN) RangeError");

    const statusReopened = JSON.parse(
      fs.readFileSync(path.join(root, ".agentsensor", "status.json"), "utf8"),
    );
    expect(statusReopened.openCount).toBe(1);
    expect(statusReopened.resolvedCount).toBe(0);
  });

  it("hides 7-day-old errors from previous runs and returns all multiple active errors from today", () => {
    const root = makeTmpDir();
    // 7 days ago run + error
    appendEvent(root, {
      kind: "run_start",
      ts: "2026-10-09T10:00:00.000Z",
      runId: "old_run",
      command: "npm run dev",
      pid: 100,
      cwd: root,
    });
    appendEvent(root, {
      kind: "error",
      id: "old_err",
      ts: "2026-10-09T10:05:00.000Z",
      type: "Error",
      message: "7-day-old error",
      frames: [{ fn: "oldFn", file: "src/old.ts", line: 1, column: 1, app: true }],
      context: [],
      command: "npm run dev",
      runId: "old_run",
    });

    // Today's run with 2 different errors
    appendEvent(root, {
      kind: "run_start",
      ts: "2026-10-16T15:00:00.000Z",
      runId: "today_run",
      command: "npm run dev",
      pid: 200,
      cwd: root,
    });
    appendEvent(root, {
      kind: "error",
      id: "today_1",
      ts: "2026-10-16T15:01:00.000Z",
      type: "TypeError",
      message: "First error today",
      frames: [{ fn: "fn1", file: "src/one.ts", line: 10, column: 2, app: true }],
      context: [],
      command: "npm run dev",
      runId: "today_run",
    });
    appendEvent(root, {
      kind: "error",
      id: "today_2",
      ts: "2026-10-16T15:02:00.000Z",
      type: "ReferenceError",
      message: "Second error today",
      frames: [{ fn: "fn2", file: "src/two.ts", line: 20, column: 4, app: true }],
      context: [],
      command: "npm run dev",
      runId: "today_run",
    });

    const report = formatRuntimeErrorsReport(root);
    expect(report).toContain("Found 2 active unique runtime error(s) (current dev session)");
    expect(report).toContain("[today_1] (OPEN) TypeError: First error today");
    expect(report).toContain("[today_2] (OPEN) ReferenceError: Second error today");
    expect(report).not.toContain("old_err");
  });

  it("collapses non-app frames while keeping app frames visible", () => {
    const lines = collapseFrames([
      { fn: "a", file: "src/a.ts", line: 1, column: 1, app: true },
      { fn: "b", file: "node_modules/pkg/index.js", line: 10, column: 2, app: false },
      { fn: "c", file: "node:internal/timers", line: 50, column: 3, app: false },
      { fn: "d", file: "src/d.ts", line: 9, column: 4, app: true },
    ]);
    expect(lines).toEqual([
      "  at a (src/a.ts:1:1) [app]",
      "  ... (2 library/internal frames collapsed)",
      "  at d (src/d.ts:9:4) [app]",
    ]);
  });
});

describe("End-to-end CLI runner (`agentsensor run`)", () => {
  it("spawns a throwing Node script, captures the error into .agentsensor/errors.jsonl, and forwards the exit code", async () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    const crashScript = path.join(root, "crash.mjs");
    fs.writeFileSync(
      crashScript,
      [
        'console.log("Booting test server...");',
        "function brokenHelper() {",
        '  throw new TypeError("user.profile is undefined");',
        "}",
        "brokenHelper();",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseCliArgs(["run", "--project", root, "--", process.execPath, crashScript]);
    expect(parsed.project).toBe(root);
    expect(buildChildEnv({}).NODE_OPTIONS).toContain("--enable-source-maps");

    const exitCode = await runCommand(parsed.command, { project: root, cwd: root });
    expect(exitCode).not.toBe(0);

    const events = readEvents(root);
    const summaries = summarizeErrors(events);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.type).toBe("TypeError");
    expect(summaries[0]?.message).toContain("user.profile is undefined");
    expect(summaries[0]?.latest.frames[0]?.file).toBe("crash.mjs");
    expect(summaries[0]?.latest.context).toContain("Booting test server...");
  });

  it("auto-injects the browser sensor into /@vite/client and captures browser/Storybook runtime errors via POST /__agentsensor", async () => {
    const root = makeTmpDir();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "vite-demo" }),
      "utf8",
    );
    const subPkg = path.join(root, "packages", "ui", "src", "stories");
    fs.mkdirSync(subPkg, { recursive: true });
    fs.writeFileSync(path.join(subPkg, "runtime-error.stories.tsx"), "// story\n", "utf8");

    const simServer = path.join(root, "sim-vite.mjs");
    fs.writeFileSync(
      simServer,
      [
        'import http from "node:http";',
        'import { EventEmitter } from "node:events";',
        "const srv = http.createServer((req, res) => {",
        '  if (req.url === "/@vite/client") {',
        '    res.writeHead(200, { "Content-Type": "application/javascript" });',
        '    res.end("console.log(\\"vite client\\");");',
        "    return;",
        "  }",
        "  res.writeHead(404); res.end();",
        "});",
        "let clientBody = '';",
        "const getReq = Object.assign(new EventEmitter(), { method: 'GET', url: '/@vite/client', headers: {} });",
        "const getRes = {",
        "  writeHead() {}, setHeader() { return this; }, removeHeader() {},",
        "  write(c) { clientBody += c.toString(); return true; },",
        "  end(c) { if (c) clientBody += c.toString(); return this; }",
        "};",
        "srv.emit('request', getReq, getRes);",
        "if (!clientBody.includes('__agentsensorInstalled')) process.exit(2);",
        "const postReq = Object.assign(new EventEmitter(), { method: 'POST', url: '/__agentsensor', headers: {} });",
        "const postRes = { statusCode: 200, end() {} };",
        "srv.emit('request', postReq, postRes);",
        "postReq.emit('data', Buffer.from(JSON.stringify({",
        '  type: "Error",',
        '  message: "Intentional runtime error for testing",',
        '  stack: "Error: Intentional runtime error for testing\\n    at Object.render (http://localhost:6006/src/stories/runtime-error.stories.tsx?t=123:13:11)\\n    at renderWithHooks (http://localhost:6006/node_modules/.vite/deps/chunk-ABC.js:100:2)",',
        '  url: "http://localhost:6006/iframe.html?id=testing-runtime-error--trigger",',
        '  context: ["Browser URL: http://localhost:6006/iframe.html?id=testing-runtime-error--trigger"]',
        "})));",
        "postReq.emit('end');",
      ].join("\n"),
      "utf8",
    );

    const exitCode = await runCommand([process.execPath, simServer], {
      project: root,
      cwd: path.join(root, "packages", "ui"),
    });
    expect(exitCode).toBe(0);

    const events = readEvents(root);
    const summaries = summarizeErrors(events);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.type).toBe("Error");
    expect(summaries[0]?.message).toBe("Intentional runtime error for testing");
    expect(summaries[0]?.latest.frames[0]).toEqual({
      fn: "Object.render",
      file: "packages/ui/src/stories/runtime-error.stories.tsx",
      line: 13,
      column: 11,
      app: true,
    });
  });
});
