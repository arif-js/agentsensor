/** A single parsed stack frame. */
export interface Frame {
  /** Function name, if V8 printed one (e.g. `getUser`, `async Promise.all`). */
  fn?: string;
  /** File path (relative to project root when inside it) or `node:` / URL specifier. */
  file: string;
  line: number;
  column: number;
  /** True when the frame is the user's own code (not node_modules / node internals). */
  app: boolean;
}

/** A runtime error detected in the dev server output. */
export interface ErrorEvent {
  kind: "error";
  /** Stable signature: same bug => same id, even if line numbers shift after edits. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Error class, e.g. `TypeError`. */
  type: string;
  message: string;
  frames: Frame[];
  /** Log lines printed right before the error (ANSI stripped). */
  context: string[];
  /** The command being run, e.g. `npm run dev`. */
  command: string;
  runId: string;
}

export interface RunStartEvent {
  kind: "run_start";
  ts: string;
  runId: string;
  command: string;
  pid: number;
  cwd: string;
}

export interface RunEndEvent {
  kind: "run_end";
  ts: string;
  runId: string;
  exitCode: number | null;
}

/** Marks an error signature as resolved at `ts`. Hidden unless it occurs again after `ts`. */
export interface ErrorResolvedEvent {
  kind: "resolved";
  id: string;
  ts: string;
}

export type SensorEvent = ErrorEvent | RunStartEvent | RunEndEvent | ErrorResolvedEvent;

/** An error signature aggregated over all its occurrences. */
export interface ErrorSummary {
  id: string;
  status: "open" | "resolved";
  type: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  resolvedAt?: string;
  /** The most recent occurrence (full detail). */
  latest: ErrorEvent;
}

/** Clean status entry written to `.agentsensor/status.json`. */
export interface StatusBoardEntry {
  id: string;
  status: "open" | "resolved";
  type: string;
  message: string;
  location: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  resolvedAt?: string;
  runId: string;
}

/** Live status board maintained at `.agentsensor/status.json`. */
export interface SensorStatusBoard {
  updatedAt: string;
  currentRun: {
    runId: string;
    command: string;
    startedAt: string;
    pid: number;
  } | null;
  openCount: number;
  resolvedCount: number;
  open: StatusBoardEntry[];
  resolved: StatusBoardEntry[];
}
