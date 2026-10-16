import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ErrorEvent,
  ErrorSummary,
  RunStartEvent,
  SensorEvent,
  SensorStatusBoard,
  StatusBoardEntry,
} from "./types.js";

export const SENSOR_DIR = ".agentsensor";
export const ERRORS_FILE = "errors.jsonl";
export const STATUS_FILE = "status.json";
const MAX_EVENTS = 500;

export function sensorDirPath(root: string): string {
  return path.join(root, SENSOR_DIR);
}

export function errorsFilePath(root: string): string {
  return path.join(root, SENSOR_DIR, ERRORS_FILE);
}

export function statusFilePath(root: string): string {
  return path.join(root, SENSOR_DIR, STATUS_FILE);
}

/**
 * Walk upward from `startDir` looking for an existing `.agentsensor/` or `package.json`.
 * Falls back to `startDir` if nothing is found.
 */
export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  let packageRoot: string | undefined;

  while (true) {
    if (fs.existsSync(path.join(dir, SENSOR_DIR))) {
      return dir;
    }
    if (!packageRoot && fs.existsSync(path.join(dir, "package.json"))) {
      packageRoot = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return packageRoot ?? path.resolve(startDir);
}

/**
 * Resolve project root in priority order:
 * 1. Explicit `--project` flag or `AGENTSENSOR_PROJECT` env var
 * 2. MCP client workspace roots (`file://` URIs), picking the first one with `.agentsensor/` or the first root
 * 3. Current working directory (walking up to nearest `.agentsensor/` or `package.json`)
 */
export function resolveProjectRoot(options: {
  explicitProject?: string | undefined;
  mcpRoots?: Array<{ uri: string }> | undefined;
  cwd?: string | undefined;
}): string {
  const explicit = options.explicitProject ?? process.env.AGENTSENSOR_PROJECT;
  if (explicit) {
    return path.resolve(explicit);
  }

  if (options.mcpRoots && options.mcpRoots.length > 0) {
    const candidateDirs: string[] = [];
    for (const root of options.mcpRoots) {
      if (root.uri.startsWith("file://")) {
        try {
          candidateDirs.push(fileURLToPath(root.uri));
        } catch {
          // ignore malformed URI
        }
      }
    }
    for (const dir of candidateDirs) {
      if (fs.existsSync(path.join(dir, SENSOR_DIR))) {
        return dir;
      }
    }
    if (candidateDirs[0]) {
      return findProjectRoot(candidateDirs[0]);
    }
  }

  return findProjectRoot(options.cwd ?? process.cwd());
}

/** Ensure `.agentsensor/` exists and is listed in `.gitignore` if a `.gitignore` exists. */
export function ensureSensorDir(root: string): string {
  const dir = sensorDirPath(root);
  fs.mkdirSync(dir, { recursive: true });
  ensureGitignore(root);
  return dir;
}

function ensureGitignore(root: string): void {
  const gitignorePath = path.join(root, ".gitignore");
  try {
    if (!fs.existsSync(gitignorePath)) return;
    const content = fs.readFileSync(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(".agentsensor") || lines.includes(".agentsensor/")) return;
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gitignorePath, `${prefix}.agentsensor/\n`, "utf8");
  } catch {
    // Non-fatal: never break the runner over .gitignore permissions
  }
}

/** Append an event to `.agentsensor/errors.jsonl`, prune old events if over cap, and sync `.agentsensor/status.json`. */
export function appendEvent(root: string, event: SensorEvent, maxEvents = MAX_EVENTS): void {
  ensureSensorDir(root);
  const file = errorsFilePath(root);
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  pruneIfNeeded(file, maxEvents);
  syncStatusBoard(root);
}

function pruneIfNeeded(file: string, maxEvents: number): void {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= maxEvents * 1.2) return;
    const kept = lines.slice(-maxEvents);
    fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
  } catch {
    // ignore concurrent read/write races
  }
}

/** Read all valid events from `.agentsensor/errors.jsonl`. */
export function readEvents(root: string): SensorEvent[] {
  const file = errorsFilePath(root);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const events: SensorEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SensorEvent;
      if (parsed && typeof parsed === "object" && "kind" in parsed) {
        events.push(parsed);
      }
    } catch {
      // skip partial/corrupted line
    }
  }
  return events;
}

/**
 * Aggregate error events by signature id, sorted with most recently seen first.
 * - Computes `status: "open" | "resolved"` for every error based on whether a `"resolved"` event
 *   exists with `ts >= lastSeen`. If the error occurred again after `resolved.ts`, its status flips back to `"open"`.
 * - By default (`includeResolved` false), only returns `"open"` errors.
 * - When `runId` is specified, only includes errors from that run session.
 */
export function summarizeErrors(
  events: SensorEvent[],
  options?: { sinceMs?: number; limit?: number; includeResolved?: boolean; runId?: string },
): ErrorSummary[] {
  const cutoff = options?.sinceMs ?? 0;
  const resolvedAtById = new Map<string, string>();

  for (const ev of events) {
    if (ev.kind === "resolved") {
      const prev = resolvedAtById.get(ev.id);
      if (!prev || ev.ts >= prev) {
        resolvedAtById.set(ev.id, ev.ts);
      }
    }
  }

  const byId = new Map<string, ErrorSummary>();

  for (const ev of events) {
    if (ev.kind !== "error") continue;
    if (options?.runId && ev.runId !== options.runId) continue;

    const t = Date.parse(ev.ts);
    if (cutoff > 0 && Number.isFinite(t) && t < cutoff) continue;

    const existing = byId.get(ev.id);
    if (!existing) {
      byId.set(ev.id, {
        id: ev.id,
        status: "open",
        type: ev.type,
        message: ev.message,
        count: 1,
        firstSeen: ev.ts,
        lastSeen: ev.ts,
        latest: ev,
      });
    } else {
      existing.count += 1;
      if (ev.ts < existing.firstSeen) existing.firstSeen = ev.ts;
      if (ev.ts >= existing.lastSeen) {
        existing.lastSeen = ev.ts;
        existing.latest = ev;
      }
    }
  }

  const result: ErrorSummary[] = [];
  for (const summary of byId.values()) {
    const resolvedTs = resolvedAtById.get(summary.id);
    if (resolvedTs && summary.lastSeen <= resolvedTs) {
      summary.status = "resolved";
      summary.resolvedAt = resolvedTs;
    } else {
      summary.status = "open";
    }
    if (!options?.includeResolved && summary.status === "resolved") {
      continue;
    }
    result.push(summary);
  }

  result.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  return options?.limit ? result.slice(0, options.limit) : result;
}

function toBoardEntry(s: ErrorSummary): StatusBoardEntry {
  const top = s.latest.frames.find((f) => f.app) ?? s.latest.frames[0];
  const loc = top ? (top.line > 0 ? `${top.file}:${top.line}:${top.column}` : top.file) : "unknown";
  return {
    id: s.id,
    status: s.status,
    type: s.type,
    message: s.message.split("\n")[0] ?? s.message,
    location: loc,
    count: s.count,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    ...(s.resolvedAt ? { resolvedAt: s.resolvedAt } : {}),
    runId: s.latest.runId,
  };
}

/** Build and write `.agentsensor/status.json` with separate `open` and `resolved` lists. */
export function syncStatusBoard(root: string): SensorStatusBoard {
  const events = readEvents(root);
  const lastRun = latestRunStart(events);
  const allSummaries = summarizeErrors(events, { includeResolved: true });

  const open: StatusBoardEntry[] = [];
  const resolved: StatusBoardEntry[] = [];

  for (const s of allSummaries) {
    if (s.status === "open") {
      open.push(toBoardEntry(s));
    } else {
      resolved.push(toBoardEntry(s));
    }
  }

  const board: SensorStatusBoard = {
    updatedAt: new Date().toISOString(),
    currentRun: lastRun
      ? {
          runId: lastRun.runId,
          command: lastRun.command,
          startedAt: lastRun.ts,
          pid: lastRun.pid,
        }
      : null,
    openCount: open.length,
    resolvedCount: resolved.length,
    open,
    resolved,
  };

  try {
    ensureSensorDir(root);
    fs.writeFileSync(statusFilePath(root), `${JSON.stringify(board, null, 2)}\n`, "utf8");
  } catch {
    // non-fatal
  }

  return board;
}

/** Read `.agentsensor/status.json` (or compute it on the fly from `errors.jsonl`). */
export function readStatusBoard(root: string): SensorStatusBoard {
  return syncStatusBoard(root);
}

/** Mark one or all currently active errors as resolved so they move to `resolved` in `status.json`. */
export function markErrorsResolved(root: string, errorId?: string): string[] {
  const events = readEvents(root);
  const summaries = summarizeErrors(events, { includeResolved: true });
  const nowIso = new Date().toISOString();
  const targets = errorId
    ? summaries.filter((s) => s.id === errorId)
    : summaries.filter((s) => s.status === "open");

  const ids: string[] = [];
  for (const s of targets) {
    const resolvedTs = nowIso > s.lastSeen ? nowIso : s.lastSeen;
    appendEvent(root, { kind: "resolved", id: s.id, ts: resolvedTs });
    ids.push(s.id);
  }
  return ids;
}

/** Return the most recent `run_start` event, if any. */
export function latestRunStart(events: SensorEvent[]): RunStartEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.kind === "run_start") return ev;
  }
  return undefined;
}

/** Find all occurrences of a specific error id. */
export function findErrorOccurrences(events: SensorEvent[], errorId: string): ErrorEvent[] {
  return events.filter((e): e is ErrorEvent => e.kind === "error" && e.id === errorId);
}
