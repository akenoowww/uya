import { isValidElement, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, Group } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowSquareOut, Check, Copy, GitDiff } from "@phosphor-icons/react";
import { highlightCode } from "../codeHighlight";
import { extractTargetPath } from "../patchApply";

export interface ApplyPreviewRequest {
  code: string;
  language?: string;
  suggestedPath?: string;
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
}: {
  children?: ReactNode;
  onPreviewDiff?: (request: ApplyPreviewRequest) => void;
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

  const suggestedPath = extractTargetPath(language, rawCode);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{suggestedPath ? `${language ?? "code"} · ${suggestedPath}` : language ?? "code"}</span>
        <Group gap={4} wrap="nowrap">
          {onPreviewDiff && rawCode.trim().length > 0 && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="iris"
              leftSection={<GitDiff size={12} weight="duotone" />}
              onClick={() => onPreviewDiff({ code: rawCode, language, suggestedPath })}
              aria-label="Preview diff and apply code block"
            >
              Diff / Apply
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
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onPreviewDiff?: (request: ApplyPreviewRequest) => void;
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
          pre: ({ children }) => <CodeBlock onPreviewDiff={onPreviewDiff}>{children}</CodeBlock>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
