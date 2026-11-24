# Contributing to Uya

Thank you for your interest in contributing to **Uya**!

## Development Setup

### Prerequisites
- **macOS 13+** (Xcode Command Line Tools) or **Windows 10/11** (Visual Studio Build Tools with C++ workload & WebView2)
- [Bun](https://bun.sh) 1.3.14+
- Node.js 20.19+ or 22.12+
- Stable Rust toolchain (`rustup`)

### Running Locally
```sh
bun install --frozen-lockfile
bun run desktop:dev
```

## Verification Before Opening a Pull Request

Run the full check suite locally before submitting changes:

```sh
bun run check
bun run desktop:test
```

This runs TypeScript project checks, Bun unit tests, core & loopback smoke tests, the Vite frontend build, and Rust unit tests.

## Pull Request Guidelines
- Keep pull requests focused on a single feature, bug fix, or improvement.
- Preserve Uya's local-first security boundaries (loopback-only sidecar, workspace path confinement, read-only / isolated structured CLI execution).
- Include or update unit tests for behavioral changes.
- All contributions are licensed under the [Apache License 2.0](LICENSE).

## Publishing a Release

Merge the feature and fix pull requests that belong in the release. Open a release pull request from the updated main branch with the new version in the workspace, Tauri, and Rust manifests. Update the lockfiles and add a dated changelog entry describing the changes included in the release.

After the release pull request passes CI and merges, push the matching v-prefixed tag on the merged commit. The release workflow builds and publishes the installers on [GitHub Releases](https://github.com/akenoowww/uya/releases).
