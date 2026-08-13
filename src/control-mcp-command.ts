import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function controlMcpCommand(): Promise<{
  command: string;
  args: string[];
}> {
  for (const relative of ["./control-mcp.js", "../dist/control-mcp.js"]) {
    const built = fileURLToPath(new URL(relative, import.meta.url));
    try {
      await access(built);
      return { command: process.execPath, args: [built] };
    } catch {}
  }
  const source = fileURLToPath(new URL("./control-mcp.ts", import.meta.url));
  await access(source);
  return { command: process.execPath, args: [...process.execArgv, source] };
}
