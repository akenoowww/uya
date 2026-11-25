import { describe, expect, test } from "bun:test";
import { applyUnifiedDiff, extractTargetPath, isShellLanguage, isUnifiedDiff, parseMultiFileUnifiedDiff } from "./patchApply";

describe("patchApply", () => {
  test("detects unified diff blocks and extracts target file path", () => {
    const diff = [
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " export { a, b };",
    ].join("\n");

    expect(isUnifiedDiff("diff", diff)).toBe(true);
    expect(isUnifiedDiff(undefined, diff)).toBe(true);
    expect(extractTargetPath("diff", diff)).toBe("src/example.ts");
  });

  test("extracts path from leading comment in regular code block", () => {
    expect(extractTargetPath("ts", "// apps/web/src/App.tsx\nexport function App() {}")).toBe("apps/web/src/App.tsx");
    expect(extractTargetPath("python", "# src/main.py\nprint(1)")).toBe("src/main.py");
    expect(extractTargetPath("ts", "// ../escape.ts\n")).toBeUndefined();
  });

  test("applies multi-hunk unified diff with line offset drift", () => {
    const original = [
      "// extra header",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "",
    ].join("\n");
    const diff = [
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 20;",
      " const c = 3;",
      "@@ -4,1 +4,2 @@",
      " const d = 4;",
      "+const e = 5;",
    ].join("\n");

    const applied = applyUnifiedDiff(original, diff);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.text).toBe([
        "// extra header",
        "const a = 1;",
        "const b = 20;",
        "const c = 3;",
        "const d = 4;",
        "const e = 5;",
        "",
      ].join("\n"));
    }
  });

  test("returns error when hunk context does not match", () => {
    const result = applyUnifiedDiff("const x = 1;\n", "@@ -1,1 +1,1 @@\n-const y = 2;\n+const y = 3;\n");
    expect(result.ok).toBe(false);
  });

  test("identifies shell code block languages", () => {
    expect(isShellLanguage("sh")).toBe(true);
    expect(isShellLanguage("bash")).toBe(true);
    expect(isShellLanguage("zsh")).toBe(true);
    expect(isShellLanguage("powershell")).toBe(true);
    expect(isShellLanguage("typescript")).toBe(false);
    expect(isShellLanguage(undefined)).toBe(false);
  });

  test("parses multi-file git unified diff patches", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,1 @@",
      "+export const b = 3;",
    ].join("\n");

    const parsed = parseMultiFileUnifiedDiff(patch);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.path).toBe("src/a.ts");
    expect(parsed[0]?.isNewFile).toBe(false);
    expect(parsed[1]?.path).toBe("src/b.ts");
    expect(parsed[1]?.isNewFile).toBe(true);
  });
});
