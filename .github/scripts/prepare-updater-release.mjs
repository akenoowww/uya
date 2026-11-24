import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [assetsDir] = process.argv.slice(2);
const { GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repository, TAURI_UPDATER_PUBLIC_KEY: publicKey } = process.env;
const version = tag?.replace(/^v/, "");
if (!assetsDir || !version || !repository || !publicKey?.trim()) {
  throw new Error("The release asset directory, tag, repository, and updater public key are required.");
}

const files = {
  "darwin-aarch64": `Uya-${version}-macos-arm64.app.tar.gz`,
  "darwin-x86_64": `Uya-${version}-macos-x64.app.tar.gz`,
  "windows-x86_64-nsis": `Uya-${version}-windows-x64-setup.exe`,
  "windows-x86_64-msi": `Uya-${version}-windows-x64.msi`,
};
const releaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
const verificationDir = mkdtempSync(join(tmpdir(), "uya-updater-"));
try {
  // Tauri stores the Minisign public key and signatures in base64 envelopes.
  const keyPath = join(verificationDir, "updater.pub");
  const signaturePath = join(verificationDir, "updater.sig");
  writeFileSync(keyPath, Buffer.from(publicKey.trim(), "base64"));
  const platforms = {};
  for (const [platform, file] of Object.entries(files)) {
    const assetPath = join(assetsDir, file);
    const signature = readFileSync(`${assetPath}.sig`, "utf8").trim();
    const decodedSignature = Buffer.from(signature, "base64");
    writeFileSync(signaturePath, decodedSignature);
    execFileSync("minisign", ["-V", "-q", "-p", keyPath, "-x", signaturePath, "-m", assetPath], { stdio: "inherit" });
    const signedVersion = decodedSignature.toString("utf8").split(/\r?\n/)[2]?.split("\t")
      .find((field) => field.startsWith("version:"));
    if (signedVersion !== `version:${version}`) {
      throw new Error(`${file} must be signed for Uya ${version}.`);
    }
    platforms[platform] = { url: `${releaseUrl}/${encodeURIComponent(file)}`, signature };
  }
  writeFileSync(join(assetsDir, "latest.json"), `${JSON.stringify({ version, platforms }, null, 2)}\n`);
} finally {
  rmSync(verificationDir, { recursive: true });
}
