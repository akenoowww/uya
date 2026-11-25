import { useEffect, useRef, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Group, ScrollArea, Stack, Text, TextInput, UnstyledButton,
} from "@mantine/core";
import { CaretDown, CaretRight, MagnifyingGlass, Paperclip } from "@phosphor-icons/react";
import type { RpcCall, SearchResponse } from "@ide/protocol";
import "./editor.css";

interface Props {
  root: string | null;
  api: RpcCall;
  seedQuery?: { query: string; nonce: number } | null;
  onOpenMatch: (path: string, line: number) => void;
  onAttachFiles: (paths: string[]) => void;
  onChooseProject: () => void;
}

export function SearchPanel({ root, api, seedQuery, onOpenMatch, onAttachFiles, onChooseProject }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [glob, setGlob] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const searchIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (seedQuery?.query) {
      setQuery(seedQuery.query);
      inputRef.current?.focus();
    }
  }, [seedQuery]);

  useEffect(() => {
    if (!root || !query.trim()) {
      setResponse(null);
      setError("");
      setLoading(false);
      return;
    }
    const id = ++searchIdRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void api("workspace.search", {
        query: query.trim(),
        caseSensitive,
        wholeWord,
        regex,
        glob: glob.trim() || undefined,
        maxResults: 200,
        workspacePath: root,
      }).then((result) => {
        if (searchIdRef.current === id) {
          setResponse(result);
          setCollapsed({});
        }
      }).catch((reason: unknown) => {
        if (searchIdRef.current === id) {
          setResponse(null);
          setError(reason instanceof Error ? reason.message : "Search failed.");
        }
      }).finally(() => {
        if (searchIdRef.current === id) setLoading(false);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [api, caseSensitive, glob, query, regex, root, wholeWord]);

  return (
    <section className="tool-pane" aria-label="Workspace code search">
      <header className="tool-heading">
        <h2>Search</h2>
        {response && (
          <Badge size="xs" variant="outline" color="gray" ff="monospace">
            {response.engine}
          </Badge>
        )}
      </header>

      {!root ? (
        <Stack align="center" justify="center" gap="xs" flex={1} p="md">
          <MagnifyingGlass size={22} weight="duotone" color="var(--muted)" aria-hidden="true" />
          <Button variant="default" size="compact-xs" onClick={onChooseProject}>Open folder</Button>
        </Stack>
      ) : (
        <>
          <Stack gap={6} p={8} style={{ borderBottom: "1px solid var(--line)" }}>
            <TextInput
              ref={inputRef}
              size="xs"
              aria-label="Search workspace code"
              placeholder="Search in project…"
              leftSection={<MagnifyingGlass size={13} />}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <Group gap={4} wrap="nowrap">
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                aria-label="Filter files by glob"
                placeholder="Files glob (e.g. *.ts)"
                value={glob}
                onChange={(event) => setGlob(event.currentTarget.value)}
              />
              <ActionIcon
                size="sm"
                variant={caseSensitive ? "light" : "subtle"}
                color={caseSensitive ? "iris" : "gray"}
                aria-label="Match case"
                aria-pressed={caseSensitive}
                title="Match case"
                onClick={() => setCaseSensitive((v) => !v)}
              >
                <Text size="10px" fw={700} ff="monospace">Aa</Text>
              </ActionIcon>
              <ActionIcon
                size="sm"
                variant={wholeWord ? "light" : "subtle"}
                color={wholeWord ? "iris" : "gray"}
                aria-label="Match whole word"
                aria-pressed={wholeWord}
                title="Match whole word"
                onClick={() => setWholeWord((v) => !v)}
              >
                <Text size="10px" fw={700} ff="monospace">ab</Text>
              </ActionIcon>
              <ActionIcon
                size="sm"
                variant={regex ? "light" : "subtle"}
                color={regex ? "iris" : "gray"}
                aria-label="Use regular expression"
                aria-pressed={regex}
                title="Use regular expression"
                onClick={() => setRegex((v) => !v)}
              >
                <Text size="10px" fw={700} ff="monospace">.*</Text>
              </ActionIcon>
            </Group>
            {response && (
              <Group justify="space-between" gap={6} wrap="nowrap" aria-live="polite">
                <Text size="11px" c="dimmed">
                  {response.totalMatches} {response.totalMatches === 1 ? "match" : "matches"} in {response.files.length} {response.files.length === 1 ? "file" : "files"}
                  {response.truncated ? " (capped)" : ""}
                </Text>
                {response.files.length > 0 && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="iris"
                    leftSection={<Paperclip size={11} />}
                    onClick={() => onAttachFiles(response.files.slice(0, 10).map((file) => file.path))}
                  >
                    Attach
                  </Button>
                )}
              </Group>
            )}
          </Stack>

          {error && <Alert color="red" variant="light" m="xs">{error}</Alert>}

          <ScrollArea className="tool-scroll" type="auto">
            <Stack gap={4} p={6}>
              {loading && <Text size="xs" c="dimmed" p="xs">Searching…</Text>}
              {!loading && response && response.files.length === 0 && (
                <Text size="xs" c="dimmed" ta="center" py="md">No matches found.</Text>
              )}
              {response?.files.map((file) => {
                const isClosed = Boolean(collapsed[file.path]);
                return (
                  <div key={file.path} className="search-file-group">
                    <UnstyledButton
                      className="file-row"
                      w="100%"
                      aria-expanded={!isClosed}
                      onClick={() => setCollapsed((prev) => ({ ...prev, [file.path]: !isClosed }))}
                    >
                      <Group gap={5} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                        {isClosed ? <CaretRight size={11} weight="bold" /> : <CaretDown size={11} weight="bold" />}
                        <Text size="xs" fw={600} truncate="end" title={file.path}>{file.path}</Text>
                      </Group>
                      <Badge size="xs" variant="light" color="gray" px={5}>{file.matches.length}</Badge>
                    </UnstyledButton>
                    {!isClosed && (
                      <Stack gap={1} pl={12} pt={2}>
                        {file.matches.map((match, idx) => {
                          const before = match.text.slice(0, match.matchStart);
                          const hit = match.text.slice(match.matchStart, match.matchEnd);
                          const after = match.text.slice(match.matchEnd);
                          return (
                            <UnstyledButton
                              key={`${match.line}:${match.column}:${idx}`}
                              className="search-match-row"
                              onClick={() => onOpenMatch(file.path, match.line)}
                              aria-label={`Open ${file.path} line ${match.line}`}
                            >
                              <Text size="10px" c="dimmed" ff="monospace" w={32} ta="right" style={{ flexShrink: 0 }}>
                                {match.line}
                              </Text>
                              <Text size="11px" ff="monospace" truncate="end" style={{ flex: 1, minWidth: 0 }}>
                                {before}
                                <mark className="search-highlight">{hit}</mark>
                                {after}
                              </Text>
                            </UnstyledButton>
                          );
                        })}
                      </Stack>
                    )}
                  </div>
                );
              })}
            </Stack>
          </ScrollArea>
        </>
      )}
    </section>
  );
}
