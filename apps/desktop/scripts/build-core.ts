import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(desktop, "../..");

function defaultTarget(): string {
  if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

const targets =
  process.env.TAURI_ENV_TARGET_TRIPLE === "universal-apple-darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : [process.env.TAURI_ENV_TARGET_TRIPLE ?? defaultTarget()];

const output = resolve(desktop, "src-tauri", "binaries");
const bunTargets: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-x64",
};
await mkdir(output, { recursive: true });

for (const target of targets) {
  if (!Object.hasOwn(bunTargets, target)) {
    throw new Error(`Unsupported sidecar target: ${target}`);
  }
  const suffix = target.includes("windows") ? ".exe" : "";
  const child = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "build",
      "--compile",
      `--target=${bunTargets[target]}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      resolve(root, "packages/core/src/index.ts"),
      "--outfile",
      resolve(output, `uya-core-${target}${suffix}`),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (await child.exited) throw new Error(`Could not compile sidecar for ${target}`);
}
