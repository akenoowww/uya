import { useEffect, useState } from "react";
import { Group, Modal, ScrollArea, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { FileCode, MagnifyingGlass } from "@phosphor-icons/react";
import type { RpcCall } from "@ide/protocol";

interface Props {
  opened: boolean;
  onClose: () => void;
  root: string | null;
  rpc: RpcCall | undefined;
  onOpenFile: (path: string) => void;
}

export function QuickOpenModal({ opened, onClose, root, rpc, onOpenFile }: Props) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!opened) {
      setQuery("");
      setSelected(0);
      return;
    }
    if (!root || !rpc) {
      setFiles([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void rpc("workspace.files", { query: query.trim() || undefined, limit: 40, workspacePath: root })
        .then((result) => {
          if (active) {
            setFiles(result);
            setSelected(0);
          }
        })
        .catch(() => {
          if (active) setFiles([]);
        });
    }, 50);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [opened, query, root, rpc]);

  function openSelected(path: string | undefined) {
    if (!path) return;
    onOpenFile(path);
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} withCloseButton={false} padding="xs" size={520} yOffset="14vh" centered={false}>
      <TextInput
        autoFocus
        size="sm"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={root ? "Open file by name…" : "Open a project folder first"}
        leftSection={<MagnifyingGlass size={15} />}
        spellCheck={false}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && files.length) {
            event.preventDefault();
            setSelected((current) => (current + 1) % files.length);
          } else if (event.key === "ArrowUp" && files.length) {
            event.preventDefault();
            setSelected((current) => (current - 1 + files.length) % files.length);
          } else if (event.key === "Enter") {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            openSelected(files[selected]);
          }
        }}
      />
      <ScrollArea.Autosize mah={320} mt="xs" type="auto">
        {files.length ? (
          <Stack gap={2} role="listbox" aria-label="Matching workspace files">
            {files.map((path, index) => {
              const name = path.split("/").at(-1) ?? path;
              const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              return (
                <UnstyledButton
                  key={path}
                  role="option"
                  aria-selected={index === selected}
                  className={`slash-item${index === selected ? " selected" : ""}`}
                  onClick={() => openSelected(path)}
                >
                  <Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                    <FileCode size={14} weight="duotone" color="#92adc9" />
                    <Text size="xs" fw={560} truncate="end">{name}</Text>
                    {dir && <Text size="11px" c="dimmed" truncate="end">{dir}</Text>}
                  </Group>
                </UnstyledButton>
              );
            })}
          </Stack>
        ) : (
          <Text size="xs" c="dimmed" ta="center" py="md">
            {root ? "No matching files." : "Open a project folder to browse files."}
          </Text>
        )}
      </ScrollArea.Autosize>
    </Modal>
  );
}
