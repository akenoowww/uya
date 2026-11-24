import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";

const sandbox = "/usr/bin/sandbox-exec";

// Negated rules avoid giving an earlier broad deny precedence over the permitted paths.
// Dyld needs the Cryptex ancestors and the root directory during process startup.
const profile = `(version 1)
(allow default)
(deny network*)
(deny mach-lookup)
(deny file-write* (require-not (require-any
  (subpath (param "UYA_RUN_DIR")) (literal "/dev/null") (literal "/dev/dtracehelper"))))
(deny file-read-data file-map-executable (require-not (require-any
  (literal "/")
  (path-ancestors "/System/Volumes/Preboot/Cryptexes/OS")
  (path-ancestors "/System/Volumes/Preboot/Cryptexes/App")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS")
  (subpath "/System/Volumes/Preboot/Cryptexes/App/System")
  (subpath "/System/Cryptexes/OS")
  (subpath "/System/Cryptexes/App")
  (subpath "/System/Library")
  (subpath "/Library/Apple/System/Library")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/usr/sbin")
  (subpath "/bin")
  (subpath "/sbin")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/dtracehelper")
  (subpath "/dev/fd")
  (literal (param "UYA_PROGRAM"))
  (subpath (param "UYA_RUN_DIR")))))
`;

function sandboxInvocation(executable: string, args: readonly string[], runDir: string) {
  return {
    command: sandbox,
    args: [
      "-D", `UYA_RUN_DIR=${runDir}`, "-D", `UYA_PROGRAM=${executable}`,
      "-p", profile, executable, ...args,
    ],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", TMPDIR: runDir },
  };
}

let sandboxStarts: boolean | undefined;

export function customStructuredBlockReason(): string | undefined {
  if (process.platform !== "darwin") return "Custom CLI Structured mode is available only on macOS.";
  if (sandboxStarts === undefined) {
    // The executable can exist even when macOS refuses to apply the sandbox profile.
    const cwd = "/private/var/empty";
    const probe = sandboxInvocation("/usr/bin/true", [], cwd);
    const { status } = spawnSync(probe.command, probe.args, {
      cwd,
      env: probe.env,
      stdio: "ignore",
      timeout: 1_500,
      killSignal: "SIGKILL",
    });
    sandboxStarts = status === 0;
  }
  if (!sandboxStarts) return "The macOS sandbox could not start. Custom CLI is available in Terminal.";
}

export async function customCliCommand(command: string, args: readonly string[], directory: string) {
  return sandboxInvocation(await realpath(command), args, await realpath(directory));
}
