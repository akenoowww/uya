import { isValidElement, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, Group } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowSquareOut, Check, Copy, GitDiff, TerminalWindow } from "@phosphor-icons/react";
import { highlightCode } from "../codeHighlight";
import { extractTargetPath, isShellLanguage, isUnifiedDiff, parseMultiFileUnifiedDiff } from "../patchApply";
import type { MultiFilePatchEntry } from "../patchApply";

export interface ApplyPreviewRequest {
  code: string;
  language?: string;
  suggestedPath?: string;
  multiFiles?: MultiFilePatchEntry[];
}

const FILE_REF_PATTERN = /^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+)(?::(\d+))?$/;

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return "";
}

function isSafeHttpUrl(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function CodeBlock({
  children,
  onPreviewDiff,
  onRunCommand,
}: {
  children?: ReactNode;
  onPreviewDiff?: (request: ApplyPreviewRequest) => void;
  onRunCommand?: (command: string) => void;
}) {
  const clipboard = useClipboard({ timeout: 1600 });
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const language = /language-([^\s]+)/.exec(child?.props.className ?? "")?.[1];
  const rawCode = extractText(child ? child.props.children : children).replace(/\n$/, "");
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHighlighted(null);
    void highlightCode(rawCode, language).then((html) => {
      if (active && html) setHighlighted(html);
    });
    return () => { active = false; };
  }, [language, rawCode]);

  const shellBlock = isShellLanguage(language);
  const multiFiles = !shellBlock && isUnifiedDiff(language, rawCode) ? parseMultiFileUnifiedDiff(rawCode) : [];
  const suggestedPath = multiFiles[0]?.path ?? extractTargetPath(language, rawCode);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">
          {multiFiles.length > 1
            ? `${language ?? "diff"} · ${multiFiles.length} files`
            : suggestedPath
              ? `${language ?? "code"} · ${suggestedPath}`
              : language ?? "code"}
        </span>
        <Group gap={4} wrap="nowrap">
          {shellBlock && onRunCommand && rawCode.trim().length > 0 && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="teal"
              leftSection={<TerminalWindow size={12} weight="duotone" />}
              onClick={() => onRunCommand(rawCode.trim())}
              aria-label="Run shell command in terminal"
            >
              Run in Terminal
            </Button>
          )}
          {!shellBlock && onPreviewDiff && rawCode.trim().length > 0 && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="iris"
              leftSection={<GitDiff size={12} weight="duotone" />}
              onClick={() => onPreviewDiff({
                code: rawCode,
                language,
                suggestedPath,
                ...(multiFiles.length > 1 ? { multiFiles } : {}),
              })}
              aria-label={multiFiles.length > 1 ? `Preview diff and apply ${multiFiles.length} files` : "Preview diff and apply code block"}
            >
              {multiFiles.length > 1 ? `Diff / Apply (${multiFiles.length})` : "Diff / Apply"}
            </Button>
          )}
          <Button
            size="compact-xs"
            variant="subtle"
            color={clipboard.copied ? "teal" : "gray"}
            leftSection={clipboard.copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
            onClick={() => clipboard.copy(rawCode)}
            aria-label="Copy code block"
          >
            {clipboard.copied ? "Copied" : "Copy"}
          </Button>
        </Group>
      </div>
      {highlighted ? (
        <pre className="code-block-highlighted"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      ) : (
        <pre>{children}</pre>
      )}
    </div>
  );
}

export function MarkdownView({
  text,
  onOpenUrl,
  onOpenFile,
  onPreviewDiff,
  onRunCommand,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onPreviewDiff?: (request: ApplyPreviewRequest) => void;
  onRunCommand?: (command: string) => void;
}) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          a: ({ href, children }) => (
            isSafeHttpUrl(href) && onOpenUrl ? (
              <button
                type="button"
                className="markdown-link-btn"
                title={href}
                onClick={() => onOpenUrl(href)}
              >
                <span>{children}</span>
                <ArrowSquareOut size={11} aria-hidden="true" />
              </button>
            ) : (
              <span className="markdown-link">{children}</span>
            )
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = Boolean(className);
            const raw = !isBlock ? extractText(children).trim() : "";
            const fileRef = !isBlock && onOpenFile ? FILE_REF_PATTERN.exec(raw) : null;
            if (fileRef?.[1] && !fileRef[1].startsWith("http")) {
              const filePath = fileRef[1];
              const line = fileRef[2] ? Number(fileRef[2]) : undefined;
              return (
                <button
                  type="button"
                  className="markdown-file-ref"
                  title={`Open ${filePath}${line ? ` at line ${line}` : ""}`}
                  onClick={() => onOpenFile?.(filePath, line)}
                >
                  <code>{children}</code>
                </button>
              );
            }
            return <code className={className} {...rest}>{children}</code>;
          },
          pre: ({ children }) => (
            <CodeBlock onPreviewDiff={onPreviewDiff} onRunCommand={onRunCommand}>{children}</CodeBlock>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
