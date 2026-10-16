import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ErrorDetector } from "./parser.js";
import { appendEvent, ensureSensorDir, findProjectRoot } from "./store.js";

function printHelp(): void {
  const help = `agentsensor — capture dev-server runtime errors for AI coding agents

Usage:
  agentsensor run -- <command> [args...]
  agentsensor run <command> [args...]

Options:
  --project <path>   Project root where .agentsensor/errors.jsonl is written
  -h, --help         Show this help message

Examples:
  npx agentsensor run -- npm run dev
  npx agentsensor run -- node server.js
`;
  process.stdout.write(help);
}

interface ParsedCliArgs {
  help: boolean;
  project?: string;
  command: string[];
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const args = [...argv];
  let project: string | undefined;
  let help = false;

  if (args[0] === "run") {
    args.shift();
  }

  while (args.length > 0) {
    const cur = args[0];
    if (cur === "--") {
      args.shift();
      break;
    }
    if (cur === "-h" || cur === "--help") {
      help = true;
      args.shift();
      continue;
    }
    if (cur === "--project") {
      args.shift();
      project = args.shift();
      continue;
    }
    if (cur?.startsWith("--project=")) {
      project = cur.slice("--project=".length);
      args.shift();
      continue;
    }
    break;
  }

  return { help, ...(project ? { project } : {}), command: args };
}

function resolveRegisterHookUrl(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [path.join(here, "register.js"), path.resolve(here, "../dist/register.js")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  context?: { root?: string; runId?: string; command?: string },
): NodeJS.ProcessEnv {
  const existingNodeOpts = baseEnv.NODE_OPTIONS ?? "";
  const parts: string[] = existingNodeOpts ? [existingNodeOpts] : [];
  if (!existingNodeOpts.includes("--enable-source-maps")) {
    parts.push("--enable-source-maps");
  }
  const hookUrl = resolveRegisterHookUrl();
  if (hookUrl && !existingNodeOpts.includes(hookUrl)) {
    parts.push(`--import=${hookUrl}`);
  }

  return {
    ...baseEnv,
    NODE_OPTIONS: parts.join(" ").trim(),
    FORCE_COLOR: baseEnv.FORCE_COLOR ?? "1",
    ...(context?.root ? { AGENTSENSOR_ROOT: context.root } : {}),
    ...(context?.runId ? { AGENTSENSOR_RUN_ID: context.runId } : {}),
    ...(context?.command ? { AGENTSENSOR_COMMAND: context.command } : {}),
  };
}

export async function runCommand(
  commandArgs: string[],
  options?: { project?: string; cwd?: string },
): Promise<number> {
  const cwd = options?.cwd ?? process.cwd();
  const root = options?.project ? findProjectRoot(options.project) : findProjectRoot(cwd);
  ensureSensorDir(root);

  const runId = randomBytes(4).toString("hex");
  const commandStr = commandArgs.join(" ");

  const detector = new ErrorDetector({
    root,
    onError: (parsed) => {
      appendEvent(root, {
        kind: "error",
        id: parsed.id,
        ts: new Date().toISOString(),
        type: parsed.type,
        message: parsed.message,
        frames: parsed.frames,
        context: parsed.context,
        command: commandStr,
        runId,
      });
    },
  });

  const isSingleCommandString = commandArgs.length === 1 && commandArgs[0]?.includes(" ");
  const cmd = commandArgs[0] ?? "";
  const cmdRest = commandArgs.slice(1);
  const childEnv = buildChildEnv(process.env, { root, runId, command: commandStr });

  const child = isSingleCommandString
    ? spawn(cmd, {
        cwd,
        env: childEnv,
        stdio: ["inherit", "pipe", "pipe"],
        shell: true,
      })
    : spawn(cmd, cmdRest, {
        cwd,
        env: childEnv,
        stdio: ["inherit", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

  appendEvent(root, {
    kind: "run_start",
    ts: new Date().toISOString(),
    runId,
    command: commandStr,
    pid: child.pid ?? 0,
    cwd: root,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    detector.write(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    detector.write(chunk);
  });

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of signals) {
    const handler = () => {
      if (!child.killed) {
        child.kill(sig);
      }
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }

  return new Promise<number>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(
        `[agentsensor] Failed to start command "${commandStr}": ${err.message}\n`,
      );
      detector.end();
      appendEvent(root, {
        kind: "run_end",
        ts: new Date().toISOString(),
        runId,
        exitCode: 1,
      });
      resolve(1);
    });

    child.on("close", (code) => {
      for (const [sig, handler] of handlers) {
        process.off(sig, handler);
      }
      detector.end();
      appendEvent(root, {
        kind: "run_end",
        ts: new Date().toISOString(),
        runId,
        exitCode: code,
      });
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help || parsed.command.length === 0) {
    printHelp();
    process.exit(parsed.help ? 0 : 1);
  }
  const code = await runCommand(parsed.command, {
    ...(parsed.project ? { project: parsed.project } : {}),
  });
  process.exit(code);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("\\cli.js") ||
    process.argv[1].endsWith("/agentsensor") ||
    process.argv[1].endsWith("\\agentsensor") ||
    process.argv[1].endsWith("/cli.ts"));

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agentsensor] Fatal error: ${msg}\n`);
    process.exit(1);
  });
}
