import { isAbsolute } from "node:path";
import { HistorySchemaError } from "./history-migrations";
import { runMcpStdioBridge } from "./mcp-stdio";
import { startServer } from "./server";

function startSidecar() {
  const token = process.env.IDE_SESSION_TOKEN;
  const dataDir = process.env.IDE_DATA_DIR;
  if (!token || !dataDir || !isAbsolute(dataDir)) throw new Error("Missing sidecar configuration.");
  const sidecar = startServer({ token, dataDir });
  console.log(JSON.stringify({ port: sidecar.port }));
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    void sidecar.close().then(() => process.exit(0), () => process.exit(1));
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  if (process.env.IDE_MANAGED_SIDECAR === "1") {
    process.stdin.once("end", stop);
    process.stdin.once("error", stop);
    process.stdin.resume();
  }
}

if (process.argv[2] === "--mcp-stdio") {
  const configPath = process.argv[3];
  if (!configPath) {
    console.error("Missing Uya MCP bridge configuration path.");
    process.exit(1);
  }
  await runMcpStdioBridge(configPath).catch(() => {
    console.error("Uya MCP stdio bridge terminated.");
    process.exit(1);
  });
} else {
  try {
    startSidecar();
  } catch (error) {
    if (error instanceof HistorySchemaError) {
      if (process.env.IDE_MANAGED_SIDECAR === "1") {
        console.log(JSON.stringify({ error: error.code }));
      } else {
        console.error(error.message);
      }
    } else {
      console.error("Local orchestrator startup failed.");
    }
    process.exitCode = 1;
  }
}
