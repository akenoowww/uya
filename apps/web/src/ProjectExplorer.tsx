import { ActionIcon, Button, Checkbox } from "@mantine/core";
import {
  ArrowClockwise, CaretDown, CaretRight, File, FileCode, FileText, Folder, FolderOpen,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { DirectoryEntry, RpcCall } from "@ide/protocol";
import "./editor.css";

interface ExplorerProps {
  root: string | null;
  api: RpcCall;
  onOpen(path: string): void;
  activePath?: string | null;
  selectedContext: readonly string[];
  onToggleContext(path: string): void;
  onChooseProject(): void;
  refreshKey?: number;
}

interface RowsProps extends Pick<ExplorerProps, "api" | "onOpen" | "activePath" | "selectedContext" | "onToggleContext"> {
  path?: string;
  workspacePath: string;
  refreshKey: string;
  depth: number;
}

function FileIcon({ name }: { name: string }) {
  if (/\.(jsonc?|ya?ml|toml)$/i.test(name)) return <FileCode className="file-meta" size={14} weight="duotone" />;
  if (/\.(tsx?|jsx?|css|html|py|rs|sh|go|java|swift)$/i.test(name)) return <FileCode className="file-code" size={14} weight="duotone" />;
  if (/\.(txt|md|mdx)$/i.test(name)) return <FileText size={14} weight="duotone" />;
  return <File size={14} weight="duotone" />;
}

function DirectoryRows(props: RowsProps) {
  const { api, path, workspacePath, refreshKey, depth, activePath, selectedContext, onOpen, onToggleContext } = props;
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    setError("");
    void api("workspace.list", { path, workspacePath }).then((result) => {
      if (current) setEntries(result);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Could not list this folder.");
    });
    return () => { current = false; };
  }, [api, path, workspacePath, refreshKey, retry]);

  if (error) {
    return (
      <div className="editor-inline-error" role="alert">
        {error}{" "}
        <Button size="compact-xs" variant="subtle" color="iris" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  if (!entries) return <p className="editor-note" role="status">Loading files…</p>;
  if (!entries.length) return <p className="editor-note">This folder is empty.</p>;

  function toggleDirectory(dirPath: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }

  return (
    <ul className="file-tree">
      {entries.map((entry) => {
        const open = expanded.has(entry.path);
        const directory = entry.kind === "directory";
        const selected = selectedContext.includes(entry.path);
        return (
          <li key={entry.path}>
            <div className={`file-row${activePath === entry.path ? " file-row-active" : ""}`} style={{ paddingInlineStart: 10 + depth * 14 }}>
              <button
                type="button"
                className="file-name"
                aria-current={activePath === entry.path ? "true" : undefined}
                aria-expanded={directory ? open : undefined}
                onClick={() => directory ? toggleDirectory(entry.path) : onOpen(entry.path)}
                title={entry.path}
              >
                {directory ? (
                  <>
                    {open ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
                    {open ? <FolderOpen size={15} weight="duotone" /> : <Folder size={15} weight="duotone" />}
                  </>
                ) : (
                  <>
                    <span className="file-chevron-gap" />
                    <FileIcon name={entry.name} />
                  </>
                )}
                <span>{entry.name}</span>
              </button>
              {!directory && (
                <Checkbox
                  size="xs"
                  aria-label={`Include ${entry.path} in prompt context`}
                  title={`Include ${entry.path} in prompt context`}
                  checked={selected}
                  onChange={() => onToggleContext(entry.path)}
                />
              )}
            </div>
            {directory && open && <DirectoryRows {...props} path={entry.path} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectExplorer({ root, onChooseProject, refreshKey = 0, ...props }: ExplorerProps) {
  const [refresh, setRefresh] = useState(0);
  const name = root?.split("/").filter(Boolean).at(-1) ?? root;
  return (
    <section className="tool-pane" aria-label="Project explorer">
      <header className="tool-heading">
        <h2>Explorer</h2>
        <div className="tool-actions">
          <ActionIcon size="sm" onClick={onChooseProject} aria-label="Open project folder" title="Open project folder">
            <FolderOpen size={15} weight="duotone" />
          </ActionIcon>
          {root && (
            <ActionIcon size="sm" onClick={() => setRefresh((value) => value + 1)} aria-label="Refresh file tree" title="Refresh file tree">
              <ArrowClockwise size={13} />
            </ActionIcon>
          )}
        </div>
      </header>
      {root ? (
        <>
          <div className="project-label" title={root}><FolderOpen size={14} weight="duotone" /> <span>{name}</span></div>
          <div className="tool-scroll"><DirectoryRows key={root} {...props} workspacePath={root} refreshKey={`${refreshKey}:${refresh}`} depth={0} /></div>
        </>
      ) : (
        <div className="editor-empty">
          <FolderOpen size={22} weight="duotone" aria-hidden="true" />
          <Button variant="default" size="compact-xs" onClick={onChooseProject}>Open folder</Button>
        </div>
      )}
    </section>
  );
}
