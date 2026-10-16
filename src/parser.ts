import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame } from "./types.js";

/** An error extracted from output, before it's stamped with time/run info. */
export interface ParsedError {
  id: string;
  type: string;
  message: string;
  frames: Frame[];
  context: string[];
}

export interface DetectorOptions {
  /** Project root; app frames inside it are made relative. */
  root: string;
  /** How many log lines before the error to keep as context. */
  contextLines?: number;
  /** Finalize a trace after this many ms with no new frame/detail lines. */
  flushMs?: number;
  onError: (error: ParsedError) => void;
}

const ANSI_RE = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC sequences (hyperlinks, titles)
    "\\u001b\\[[0-?]*[ -/]*[@-~]", // CSI sequences (colors, cursor)
    "\\u001b[@-Z\\\\-_]", // 2-char escapes
  ].join("|"),
  "g",
);

/**
 * Strip common monorepo task runner & logger prefixes from the start of a line:
 * - pnpm / turbo / lerna: `packages/ui dev: `, `@scope/web:dev: `, `dev: `, `web | `
 * - log level tags after prefix: `WARN `, `ERROR `, `ERR! ` (preserving trailing indentation!)
 * Explicitly avoids stripping `XxxError:` or `XxxException:`.
 */
const RUNNER_PREFIX_RE =
  /^(?:(?!(?:[A-Z][\w$]*)?(?:Error|Exception):)(?:[@\w./-]+\s+(?:dev|start|build|serve|watch|test|storybook)\s*:\s?|(?:dev|start|build|serve|watch|storybook)\s*:\s?|@[a-z0-9_.-]+\/[a-z0-9_.-]+(?::[\w-]+)?:\s?|[\w./-]+:(?:dev|start|build|serve|watch|storybook):\s?|[\w./-]+\s+\|\s?))?(?:(?:WARN|WARNING|ERROR|ERR!)(?:\s|$))?/;

/** `    at fn (file:1:2)` | `    at file:1:2` | `    at async Promise.all (index 0)` */
const FRAME_LINE_RE = /^\s+at\s+.*(?:\(.*\)|:\d+:\d+|<anonymous>|native)\s*$/;
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\((.+)\)|(.+?))\s*$/;
const LOCATION_RE = /^(.*):(\d+):(\d+)$/;

/** Standard V8 / JS Error header: `TypeError: msg`, `NoMetaError: msg`, ` ⨯ Uncaught RangeError: msg` */
const HEADER_RE =
  /(?:^|[\s:⨯✖×>|\]])((?:[A-Z][\w$]*)?(?:Error|Exception))(?: \[[^\]]+\])?:\s+(.*)$/;

/** Vite / Rollup / Remix internal or pre-transform error header */
const VITE_HEADER_RE =
  /(?:\[vite\]\s*(?:Internal server error|Pre-transform error):\s*(.+)|\[plugin:([\w:/-]+)\]\s*(.+))/i;

/** Vite / Rollup `File: /path/to/file.tsx:12:5` or `File: /path/to/file.tsx` */
const VITE_FILE_RE = /^\s*File:\s+(.+?)(?::(\d+):(\d+))?\s*$/;

/** esbuild header: `✘ [ERROR] Could not resolve "..."` or `X [ERROR] ...` */
const ESBUILD_HEADER_RE = /(?:✘|✖|X)\s*\[ERROR\]\s*(.+)$/;

/** esbuild / bundler location line: `    src/file.tsx:12:5:` */
const COLON_LOC_LINE_RE = /^\s*([^\s:]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(.*)$/;

/** Next.js / Webpack / Turbopack file header: `⨯ ./src/app/page.tsx:14:5` or `./src/file.tsx:14:5` */
const NEXT_FILE_HEADER_RE = /^(?:[⨯✖×]\s+)?(\.?\/?[^\s:]+\.[jt]sx?):(\d+)(?::(\d+))?\s*$/;

/** TypeScript compiler single-line error: `src/file.tsx(12,5): error TS2304: msg` or `src/file.tsx:12:5 - error TS2304: msg` */
const TS_ERROR_RE =
  /^\s*([^\s(:]+\.[jt]sx?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*(?:-|:)\s*error\s+(TS\d+):\s*(.+)$/;

/** Inline file location inside an error message: `/path/to/file.tsx (line 1, col 0)` or `/path/to/file.tsx:12:5` */
const INLINE_PAREN_LOC_RE =
  /((?:\/|\.\.?\/|[a-zA-Z]:\\|[\w.-]+\/)[^\s()]+?\.[a-zA-Z0-9]+)\s*\(line\s+(\d+),\s*col(?:umn)?\s+(\d+)\)/i;
const INLINE_COLON_LOC_RE =
  /((?:\/|\.\.?\/|[a-zA-Z]:\\|[\w.-]+\/)[^\s:()]+\.[a-zA-Z0-9]+):(\d+):(\d+)/;

/** Node's `... 3 lines matching cause stack trace ...` */
const ELLIPSIS_RE = /^\s+\.\.\. \d+ lines? matching/;

/** Code-frame lines printed by Babel / Vite / Next.js / esbuild: `  12 | const x = 1;` or `   | ^` */
const CODE_FRAME_RE = /^\s*(?:>\s*)?(?:\d+\s*\||\|)\s?/;

const MAX_HEADER_LOOKBACK = 8;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Strip monorepo/logger prefix while preserving indentation after the prefix. */
export function stripRunnerPrefix(line: string): string {
  return line.replace(RUNNER_PREFIX_RE, "");
}

export function isFrameLine(line: string): boolean {
  return FRAME_LINE_RE.test(stripRunnerPrefix(line));
}

/** Turn whatever V8 or a bundler printed as a location into a clean, project-relative path. */
export function normalizeFile(raw: string, root: string): string {
  let file = raw.trim();
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      // keep as-is
    }
  }
  // Browser dev-server URLs: http://localhost:6006/src/stories/foo.tsx?t=123 or http://localhost:6006/@fs/Users/...
  if (
    /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.\d+\.\d+)(?::\d+)?\//i.test(
      file,
    )
  ) {
    try {
      const u = new URL(file);
      let p = decodeURIComponent(u.pathname);
      if (p.startsWith("/@fs/")) {
        p = p.slice("/@fs".length);
        // Windows `/@fs/C:/...` -> `C:/...`
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
      } else if (
        !p.startsWith("/node_modules/") &&
        !p.startsWith("/@id/") &&
        !p.startsWith("/@vite/") &&
        !p.startsWith("/_next/") &&
        !p.startsWith("/sb-")
      ) {
        p = p.replace(/^\/+/, "");
      }
      file = p;
    } catch {
      // keep as-is
    }
  }
  // Next.js / webpack dev: webpack-internal:///(rsc)/./app/page.tsx
  file = file.replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, "");
  // Vite / turbopack style query strings: /src/app.ts?t=123
  file = file.replace(/\?[^/\\]*$/, "");

  if (path.isAbsolute(file)) {
    const cleanRoot = root.replace(/^\/private\/(var|tmp)\//, "/$1/");
    const cleanFile = file.replace(/^\/private\/(var|tmp)\//, "/$1/");
    const rel = path.relative(cleanRoot, cleanFile);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      file = rel;
    }
  }
  file = file.replace(/^\.\//, "");
  return file.split(path.sep).join("/");
}

function isAppFile(file: string, line: number): boolean {
  if (line <= 0) return false;
  if (file.startsWith("node:") || file.startsWith("internal/")) return false;
  if (file.includes("node_modules/") || file.includes("node_modules\\")) return false;
  if (file.startsWith("/@") || file.startsWith("/_next/") || file.startsWith("/sb-")) return false;
  if (file === "<anonymous>" || file === "native") return false;
  if (/^https?:/.test(file)) return false;
  // Absolute path still here => outside the project root (global tools, etc.)
  if (path.isAbsolute(file)) return false;
  return true;
}

export function parseFrame(line: string, root: string): Frame | undefined {
  const cleaned = stripRunnerPrefix(line);
  const m = FRAME_RE.exec(cleaned);
  if (!m) return undefined;
  const fn = m[1]?.trim();
  const location = (m[2] ?? m[3] ?? "").trim();
  const loc = LOCATION_RE.exec(location);
  if (!loc) {
    return { fn: fn ?? location, file: location, line: 0, column: 0, app: false };
  }
  const file = normalizeFile(loc[1] ?? "", root);
  const lineNo = Number(loc[2]);
  return {
    ...(fn ? { fn } : {}),
    file,
    line: lineNo,
    column: Number(loc[3]),
    app: isAppFile(file, lineNo),
  };
}

/** Extract an inline file frame from an error message or surrounding lines if present. */
export function extractInlineFrame(text: string, root: string): Frame | undefined {
  const paren = INLINE_PAREN_LOC_RE.exec(text);
  if (paren) {
    const file = normalizeFile(paren[1] ?? "", root);
    const line = Math.max(1, Number(paren[2]));
    const column = Number(paren[3]);
    return { file, line, column, app: isAppFile(file, line) };
  }
  const colon = INLINE_COLON_LOC_RE.exec(text);
  if (colon) {
    const file = normalizeFile(colon[1] ?? "", root);
    const line = Math.max(1, Number(colon[2]));
    const column = Number(colon[3]);
    return { file, line, column, app: isAppFile(file, line) };
  }
  return undefined;
}

/** Remove volatile bits (numbers, ids) so the same bug keeps the same signature. */
function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .trim();
}

/**
 * Stable id for an error. Uses type + message + top app frame's file & function,
 * but NOT line numbers — those shift when the agent edits the file.
 */
export function signature(type: string, message: string, frames: Frame[]): string {
  const top = frames.find((f) => f.app) ?? frames[0];
  const firstLine = message.split("\n")[0] ?? message;
  const key = [type, normalizeMessage(firstLine), top?.file ?? "", top?.fn ?? ""].join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

interface Pending {
  kind: "v8" | "bundler";
  type: string;
  message: string;
  extraLines: string[];
  frames: Frame[];
  context: string[];
  bundlerLinesRemaining: number;
}

/**
 * Streaming error detector for Node/V8 stack traces AND Vite, Next.js, Remix,
 * Storybook, esbuild, and TypeScript dev-server errors.
 */
export class ErrorDetector {
  private readonly root: string;
  private readonly contextLines: number;
  private readonly flushMs: number;
  private readonly onError: (error: ParsedError) => void;

  private partial = "";
  /** Recent non-frame lines (with runner prefixes stripped), newest last. */
  private history: string[] = [];
  /** How many lines at the end of `history` were seen since the last error. */
  private freshLines = 0;
  private pending: Pending | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: DetectorOptions) {
    this.root = options.root;
    this.contextLines = options.contextLines ?? 30;
    this.flushMs = options.flushMs ?? 150;
    this.onError = options.onError;
  }

  write(chunk: string | Buffer): void {
    const text = this.partial + stripAnsi(chunk.toString());
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.processLine(line.replace(/\r/g, ""));
    if (this.pending) this.scheduleFlush();
  }

  /** Flush everything (call when the stream ends). */
  end(): void {
    if (this.partial) {
      this.processLine(this.partial);
      this.partial = "";
    }
    this.finalize();
  }

  private processLine(rawLine: string): void {
    const line = stripRunnerPrefix(rawLine);

    // 1. V8 `  at ...` frame line
    if (FRAME_LINE_RE.test(line)) {
      if (!this.pending) this.startV8Error();
      const frame = parseFrame(line, this.root);
      if (frame && this.pending) this.pending.frames.push(frame);
      return;
    }

    if (this.pending && ELLIPSIS_RE.test(line)) return;

    // 2. Single-line TypeScript compiler error (`src/a.tsx(1,2): error TS2304: ...`)
    const tsMatch = TS_ERROR_RE.exec(line);
    if (tsMatch) {
      if (this.pending) this.finalize();
      const file = normalizeFile(tsMatch[1] ?? "", this.root);
      const lineNo = Number(tsMatch[2] ?? tsMatch[4] ?? 1);
      const colNo = Number(tsMatch[3] ?? tsMatch[5] ?? 1);
      const code = tsMatch[6] ?? "TS";
      const msg = tsMatch[7]?.trim() ?? "";
      const frame: Frame = { file, line: lineNo, column: colNo, app: isAppFile(file, lineNo) };
      const context = this.recentContext(this.history.length);
      this.emit({
        type: `TypeScriptError[${code}]`,
        message: msg,
        frames: [frame],
        context,
      });
      this.remember(line);
      return;
    }

    // 3. If we are currently collecting a bundler error block (Vite / Next.js / esbuild),
    //    consume metadata lines (`File:`, `Plugin:`, code frames, colon locations).
    if (this.pending?.kind === "bundler") {
      if (this.consumeBundlerDetailLine(line)) {
        return;
      }
      this.finalize();
    } else if (this.pending?.kind === "v8") {
      this.finalize();
    }

    // 4. Check for Vite / Rollup / Remix / esbuild / Next.js bundler error start
    if (this.tryStartBundlerError(line)) {
      return;
    }

    this.remember(line);
  }

  private tryStartBundlerError(line: string): boolean {
    // Vite / Rollup: `[vite] Internal server error: ...` or `[plugin:vite:...] ...`
    const viteMatch = VITE_HEADER_RE.exec(line);
    if (viteMatch) {
      const msg = (viteMatch[1] ?? viteMatch[3] ?? line).trim();
      const plugin = viteMatch[2];
      const type = plugin ? `ViteError[${plugin}]` : "ViteError";
      const inlineFrame = extractInlineFrame(msg, this.root);
      this.pending = {
        kind: "bundler",
        type,
        message: msg,
        extraLines: [],
        frames: inlineFrame ? [inlineFrame] : [],
        context: this.recentContext(this.history.length),
        bundlerLinesRemaining: 16,
      };
      return true;
    }

    // esbuild: `✘ [ERROR] ...`
    const esbuildMatch = ESBUILD_HEADER_RE.exec(line);
    if (esbuildMatch) {
      const msg = (esbuildMatch[1] ?? line).trim();
      const inlineFrame = extractInlineFrame(msg, this.root);
      this.pending = {
        kind: "bundler",
        type: "BuildError",
        message: msg,
        extraLines: [],
        frames: inlineFrame ? [inlineFrame] : [],
        context: this.recentContext(this.history.length),
        bundlerLinesRemaining: 12,
      };
      return true;
    }

    // Next.js / Webpack / Turbopack file header: `⨯ ./src/components/Accordion.tsx:14:5`
    const nextFileMatch = NEXT_FILE_HEADER_RE.exec(line.trim());
    if (
      nextFileMatch &&
      (line.includes("⨯") || line.includes("✖") || this.hasRecentCompileErrorBanner())
    ) {
      const file = normalizeFile(nextFileMatch[1] ?? "", this.root);
      const lineNo = Number(nextFileMatch[2] ?? 1);
      const colNo = Number(nextFileMatch[3] ?? 1);
      this.pending = {
        kind: "bundler",
        type: "CompileError",
        message: `${file}:${lineNo}:${colNo}`,
        extraLines: [],
        frames: [{ file, line: lineNo, column: colNo, app: isAppFile(file, lineNo) }],
        context: this.recentContext(this.history.length),
        bundlerLinesRemaining: 16,
      };
      return true;
    }

    return false;
  }

  private hasRecentCompileErrorBanner(): boolean {
    const tail = this.history.slice(-4);
    return tail.some((l) => /Failed to compile|Module not found|SyntaxError|Error:/i.test(l));
  }

  private consumeBundlerDetailLine(line: string): boolean {
    const p = this.pending;
    if (!p || p.bundlerLinesRemaining <= 0) return false;
    const trimmed = line.trim();

    if (trimmed === "") {
      p.bundlerLinesRemaining--;
      return true;
    }

    // Stop if a new normal timestamped log line appears (e.g. `3:31:30 pm [vite] page reload`)
    if (
      /^\d{1,2}:\d{2}:\d{2}(?:\s?[ap]m)?\s+\[vite\]\s+(?:page reload|hmr update)/i.test(trimmed)
    ) {
      return false;
    }

    // Vite `File: /path/to/file.tsx:12:5`
    const viteFile = VITE_FILE_RE.exec(line);
    if (viteFile) {
      const file = normalizeFile(viteFile[1] ?? "", this.root);
      const lineNo = Number(viteFile[2] ?? 1);
      const colNo = Number(viteFile[3] ?? 1);
      p.frames.unshift({ file, line: lineNo, column: colNo, app: isAppFile(file, lineNo) });
      p.bundlerLinesRemaining--;
      return true;
    }

    // esbuild / bundler location: `src/file.tsx:12:5: ...`
    const colonLoc = COLON_LOC_LINE_RE.exec(line);
    if (colonLoc) {
      const file = normalizeFile(colonLoc[1] ?? "", this.root);
      const lineNo = Number(colonLoc[2] ?? 1);
      const colNo = Number(colonLoc[3] ?? 1);
      p.frames.unshift({ file, line: lineNo, column: colNo, app: isAppFile(file, lineNo) });
      if (colonLoc[4]?.trim()) {
        p.extraLines.push(colonLoc[4].trim());
      }
      p.bundlerLinesRemaining--;
      return true;
    }

    // Inline location inside detail line
    const inline = extractInlineFrame(line, this.root);
    if (inline && p.frames.length === 0) {
      p.frames.push(inline);
    }

    // Keep Plugin / Error / code-frame lines
    if (
      CODE_FRAME_RE.test(line) ||
      /^(?:Plugin|Error|Module not found|SyntaxError|ReferenceError|TypeError|Cannot find|Import|Export)/i.test(
        trimmed,
      ) ||
      p.extraLines.length < 6
    ) {
      p.extraLines.push(trimmed);
      p.bundlerLinesRemaining--;
      return true;
    }

    return false;
  }

  private remember(line: string): void {
    this.history.push(line);
    this.freshLines++;
    const max = this.contextLines + MAX_HEADER_LOOKBACK + 5;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
    this.freshLines = Math.min(this.freshLines, this.history.length);
  }

  private recentContext(endIdx: number): string[] {
    return this.history
      .slice(Math.max(0, endIdx - this.contextLines), endIdx)
      .filter((l, i, arr) => l.trim() !== "" || (i > 0 && arr[i - 1]?.trim() !== ""));
  }

  private startV8Error(): void {
    const start = Math.max(0, this.history.length - Math.min(this.freshLines, MAX_HEADER_LOOKBACK));
    let headerIdx = -1;
    let match: RegExpExecArray | null = null;
    for (let i = this.history.length - 1; i >= start; i--) {
      match = HEADER_RE.exec(this.history[i] ?? "");
      if (match) {
        headerIdx = i;
        break;
      }
    }

    if (headerIdx === -1 || !match) {
      // Frames without an Error header (console.trace, warnings) — ignore them.
      this.pending = {
        kind: "v8",
        type: "",
        message: "",
        extraLines: [],
        frames: [],
        context: [],
        bundlerLinesRemaining: 0,
      };
      return;
    }

    const extra = this.history
      .slice(headerIdx + 1)
      .map((l) => l.trim())
      .filter(Boolean);
    const message = [match[2]?.trim() ?? "", ...extra].filter(Boolean).join("\n");
    const context = this.recentContext(headerIdx);

    // If the error message itself embeds an app file path (e.g. Storybook's
    // `NoMetaError: CSF: missing default export /path/to/story.tsx (line 1, col 0)`),
    // extract it as the top app frame so the agent gets the exact file:line!
    const inlineFrame = extractInlineFrame(message, this.root);

    this.pending = {
      kind: "v8",
      type: match[1] ?? "Error",
      message,
      extraLines: [],
      frames: inlineFrame ? [inlineFrame] : [],
      context,
      bundlerLinesRemaining: 0,
    };
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finalize(), this.flushMs);
    this.timer.unref?.();
  }

  private finalize(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const p = this.pending;
    this.pending = undefined;
    this.freshLines = 0;
    if (!p?.type || p.frames.length === 0) return;

    const fullMessage =
      p.extraLines.length > 0 ? [p.message, ...p.extraLines].filter(Boolean).join("\n") : p.message;

    this.emit({
      type: p.type,
      message: fullMessage,
      frames: p.frames,
      context: p.context,
    });
  }

  private emit(err: { type: string; message: string; frames: Frame[]; context: string[] }): void {
    this.onError({
      id: signature(err.type, err.message, err.frames),
      type: err.type,
      message: err.message,
      frames: err.frames,
      context: err.context,
    });
  }
}
