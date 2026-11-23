import { constants, accessSync } from "node:fs";
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

export function supportsCustomStructured(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    accessSync(sandbox, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function customCliCommand(command: string, args: readonly string[], directory: string) {
  const executable = await realpath(command);
  const runDir = await realpath(directory);
  return {
    command: sandbox,
    args: [
      "-D", `UYA_RUN_DIR=${runDir}`, "-D", `UYA_PROGRAM=${executable}`,
      "-p", profile, executable, ...args,
    ],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", TMPDIR: runDir },
  };
}
