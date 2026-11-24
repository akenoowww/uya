import {
  ActionIcon, Button, Checkbox, Group, Modal, ScrollArea, Stack, Text, TextInput,
} from "@mantine/core";
import {
  ArrowClockwise, CaretDown, CaretRight, File, FileCode, FilePlus, FileText,
  Folder, FolderOpen, FolderPlus, PencilSimple, Trash,
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

type FileMutation =
  | { kind: "create-file"; parentDir: string }
  | { kind: "create-dir"; parentDir: string }
  | { kind: "rename"; entry: DirectoryEntry }
  | { kind: "remove"; entry: DirectoryEntry };

interface RowsProps extends Pick<ExplorerProps, "api" | "onOpen" | "activePath" | "selectedContext" | "onToggleContext"> {
  path?: string;
  workspacePath: string;
  refreshKey: string;
  depth: number;
  onMutate: (action: FileMutation) => void;
}

function FileIcon({ name }: { name: string }) {
  if (/\.(jsonc?|ya?ml|toml)$/i.test(name)) return <FileCode className="file-meta" size={14} weight="duotone" />;
  if (/\.(tsx?|jsx?|css|html|py|rs|sh|go|java|swift)$/i.test(name)) return <FileCode className="file-code" size={14} weight="duotone" />;
  if (/\.(txt|md|mdx)$/i.test(name)) return <FileText size={14} weight="duotone" />;
  return <File size={14} weight="duotone" />;
}

function DirectoryRows(props: RowsProps) {
  const { api, path, workspacePath, refreshKey, depth, activePath, selectedContext, onOpen, onToggleContext, onMutate } = props;
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
      <Group gap="xs" p="xs" role="alert">
        <Text size="xs" c="red">{error}</Text>
        <Button size="compact-xs" variant="subtle" color="iris" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </Button>
      </Group>
    );
  }
  if (!entries) return <Text size="xs" c="dimmed" p="xs" role="status">Loading files…</Text>;
  if (!entries.length) return <Text size="xs" c="dimmed" p="xs">This folder is empty.</Text>;

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
            <div className={`file-row${activePath === entry.path ? " file-row-active" : ""}`} style={{ paddingInlineStart: 8 + depth * 14 }}>
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
              <span className="file-row-hover-actions">
                {directory && (
                  <ActionIcon
                    size={18}
                    variant="subtle"
                    color="gray"
                    aria-label={`New file in ${entry.path}`}
                    title="New file here"
                    onClick={() => onMutate({ kind: "create-file", parentDir: entry.path })}
                  >
                    <FilePlus size={11} />
                  </ActionIcon>
                )}
                <ActionIcon
                  size={18}
                  variant="subtle"
                  color="gray"
                  aria-label={`Rename ${entry.path}`}
                  title="Rename"
                  onClick={() => onMutate({ kind: "rename", entry })}
                >
                  <PencilSimple size={11} />
                </ActionIcon>
                <ActionIcon
                  size={18}
                  variant="subtle"
                  color="red"
                  aria-label={`Delete ${entry.path}`}
                  title="Delete"
                  onClick={() => onMutate({ kind: "remove", entry })}
                >
                  <Trash size={11} />
                </ActionIcon>
              </span>
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
  const [mutation, setMutation] = useState<FileMutation | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");

  function openMutation(next: FileMutation) {
    setMutation(next);
    setMutationError("");
    if (next.kind === "rename") setInputValue(next.entry.path);
    else if (next.kind === "create-file" || next.kind === "create-dir") {
      setInputValue(next.parentDir ? `${next.parentDir}/` : "");
    } else {
      setInputValue("");
    }
  }

  async function submitMutation() {
    if (!root || !mutation || busy) return;
    setBusy(true);
    setMutationError("");
    try {
      if (mutation.kind === "create-file" || mutation.kind === "create-dir") {
        const target = inputValue.trim().replace(/^\/+/, "");
        const created = await props.api("workspace.create", {
          path: target,
          kind: mutation.kind === "create-file" ? "file" : "directory",
          workspacePath: root,
        });
        setMutation(null);
        setRefresh((value) => value + 1);
        if (created.kind === "file") props.onOpen(created.path);
      } else if (mutation.kind === "rename") {
        const target = inputValue.trim().replace(/^\/+/, "");
        await props.api("workspace.rename", {
          from: mutation.entry.path,
          to: target,
          workspacePath: root,
        });
        setMutation(null);
        setRefresh((value) => value + 1);
      } else {
        await props.api("workspace.remove", { path: mutation.entry.path, workspacePath: root });
        setMutation(null);
        setRefresh((value) => value + 1);
      }
    } catch (reason: unknown) {
      setMutationError(reason instanceof Error ? reason.message : "File operation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tool-pane" aria-label="Project explorer">
      <header className="tool-heading">
        <h2>Explorer</h2>
        <Group gap={2} wrap="nowrap">
          {root ? (
            <>
              <ActionIcon
                size="sm"
                onClick={() => openMutation({ kind: "create-file", parentDir: "" })}
                aria-label="New file"
                title="New file"
              >
                <FilePlus size={14} weight="duotone" />
              </ActionIcon>
              <ActionIcon
                size="sm"
                onClick={() => openMutation({ kind: "create-dir", parentDir: "" })}
                aria-label="New folder"
                title="New folder"
              >
                <FolderPlus size={14} weight="duotone" />
              </ActionIcon>
              <ActionIcon
                size="sm"
                onClick={() => setRefresh((value) => value + 1)}
                aria-label="Refresh file tree"
                title="Refresh file tree"
              >
                <ArrowClockwise size={13} />
              </ActionIcon>
            </>
          ) : (
            <ActionIcon size="sm" onClick={onChooseProject} aria-label="Open project folder" title="Open project folder">
              <FolderOpen size={15} weight="duotone" />
            </ActionIcon>
          )}
        </Group>
      </header>
      {root ? (
        <ScrollArea className="tool-scroll" type="auto">
          <div style={{ paddingBlock: 4 }}>
            <DirectoryRows
              key={root}
              {...props}
              workspacePath={root}
              refreshKey={`${refreshKey}:${refresh}`}
              depth={0}
              onMutate={openMutation}
            />
          </div>
        </ScrollArea>
      ) : (
        <Stack align="center" justify="center" gap="xs" flex={1} p="md">
          <FolderOpen size={22} weight="duotone" color="var(--muted)" />
          <Button variant="default" size="compact-xs" onClick={onChooseProject}>Open folder</Button>
        </Stack>
      )}

      <Modal
        opened={Boolean(mutation)}
        onClose={() => !busy && setMutation(null)}
        title={
          mutation?.kind === "create-file" ? "New file"
            : mutation?.kind === "create-dir" ? "New folder"
              : mutation?.kind === "rename" ? "Rename"
                : mutation ? `Delete ${mutation.entry.name}?` : ""
        }
        size="sm"
      >
        {mutation?.kind === "remove" ? (
          <>
            <Text size="xs" c="dimmed" mb="sm">
              Permanently remove <code>{mutation.entry.path}</code> from disk?
            </Text>
            {mutationError && <Text size="xs" c="red" mb="sm">{mutationError}</Text>}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" disabled={busy} onClick={() => setMutation(null)}>Cancel</Button>
              <Button color="red" variant="light" loading={busy} onClick={() => void submitMutation()}>Delete</Button>
            </Group>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void submitMutation(); }}>
            <TextInput
              autoFocus
              size="xs"
              label={mutation?.kind === "rename" ? "New relative path" : "Relative path"}
              placeholder={mutation?.kind === "create-dir" ? "src/utils" : "src/example.ts"}
              value={inputValue}
              onChange={(event) => setInputValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
                  event.preventDefault();
                }
              }}
              spellCheck={false}
              mb="sm"
            />
            {mutationError && <Text size="xs" c="red" mb="sm">{mutationError}</Text>}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" disabled={busy} onClick={() => setMutation(null)}>Cancel</Button>
              <Button type="submit" color="iris" loading={busy} disabled={!inputValue.trim()}>
                {mutation?.kind === "rename" ? "Rename" : "Create"}
              </Button>
            </Group>
          </form>
        )}
      </Modal>
    </section>
  );
}
