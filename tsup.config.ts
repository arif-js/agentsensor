import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts", mcp: "src/mcp.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { register: "src/register.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    clean: false,
    sourcemap: true,
  },
]);
