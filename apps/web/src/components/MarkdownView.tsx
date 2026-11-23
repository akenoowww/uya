import { isValidElement } from "react";
import type { ReactNode } from "react";
import { Button } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "@phosphor-icons/react";

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const clipboard = useClipboard({ timeout: 1600 });
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const language = /language-([^\s]+)/.exec(child?.props.className ?? "")?.[1];
  const rawCode = extractText(child ? child.props.children : children).replace(/\n$/, "");

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? "code"}</span>
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
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          a: ({ children }) => <span className="markdown-link">{children}</span>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
