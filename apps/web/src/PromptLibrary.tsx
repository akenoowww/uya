import { ActionIcon, Alert, Badge, Button, Group, Paper, ScrollArea, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { ArrowClockwise, ArrowUpRight, BookOpen, PencilSimple, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PromptDocument, PromptRef, PromptSummary, RenderedPrompt, RpcCall } from "@ide/protocol";
import { EFFORT_META } from "./components/EffortPicker";
import "./editor.css";

interface PromptLibraryProps {
  root: string | null;
  api: RpcCall;
  onUse(prompt: RenderedPrompt): void;
  refreshKey?: number;
}

type SourceDraft = {
  ref: PromptRef;
  revision?: string;
  source: string;
};

function refKey(ref: PromptRef): string {
  return `${ref.scope}:${ref.path}`;
}

const blankPrompt = "---\ntitle: New prompt\neffort: medium\nvariables:\n  topic: \"this project\"\n---\n\nSummarize {{topic}}.\n";

function PromptLibraryView({ root, api, onUse, refreshKey }: PromptLibraryProps) {
  const [prompts, setPrompts] = useState<PromptSummary[] | null>(null);
  const [choice, setChoice] = useState("");
  const [document, setDocument] = useState<PromptDocument | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [documentError, setDocumentError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [documentRefresh, setDocumentRefresh] = useState(0);
  const active = useRef(false);
  const selectedRef = prompts?.find((prompt) => refKey(prompt.ref) === choice)?.ref;
  const scope = selectedRef?.scope;
  const path = selectedRef?.path;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setListError("");
    void api("prompts.list", {}).then((result) => {
      if (!current) return;
      setPrompts(result);
      setChoice((previous) => result.some((prompt) => refKey(prompt.ref) === previous) ? previous : "");
    }).catch((reason: unknown) => {
      if (current) setListError(reason instanceof Error ? reason.message : "Could not list prompts.");
    });
    return () => { current = false; };
  }, [api, refresh, refreshKey]);

  useEffect(() => {
    let current = true;
    setDocument(null);
    setDocumentError("");
    setValues({});
    if (scope && path) {
      void api("prompts.read", { ref: { scope, path } }).then((result) => {
        if (!current) return;
        setDocument(result);
        setValues(Object.fromEntries(result.variables.flatMap(({ name, defaultValue }) => defaultValue === undefined ? [] : [[name, defaultValue]])));
      }).catch((reason: unknown) => {
        if (current) setDocumentError(reason instanceof Error ? reason.message : "Could not open this prompt.");
      });
    }
    return () => { current = false; };
  }, [api, scope, path, documentRefresh]);

  async function usePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!document || busy) return;
    setBusy(true);
    setDocumentError("");
    try {
      const result = await api("prompts.render", { ref: document.ref, values });
      if (!active.current) return;
      if (result.revision !== document.revision) {
        setDocumentError("This prompt changed on disk. Reload it before using it.");
        return;
      }
      onUse(result);
    } catch (reason) {
      if (active.current) setDocumentError(reason instanceof Error ? reason.message : "Could not render this prompt.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    let targetPath = draft.ref.path.trim();
    if (!targetPath) {
      setDocumentError("Enter a filename for this prompt.");
      return;
    }
    if (!targetPath.endsWith(".prompt.md")) targetPath += ".prompt.md";
    setBusy(true);
    setDocumentError("");
    try {
      const saved = await api("prompts.write", { ...draft, ref: { scope: draft.ref.scope, path: targetPath } });
      if (!active.current) return;
      setDraft(null);
      setPrompts((previous) => [...(previous ?? []).filter((prompt) => refKey(prompt.ref) !== refKey(saved.ref)), saved]);
      setChoice(refKey(saved.ref));
      setRefresh((value) => value + 1);
      setDocumentRefresh((value) => value + 1);
    } catch (reason) {
      if (active.current) setDocumentError(reason instanceof Error ? reason.message : "Could not save this prompt.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function refreshPrompts() {
    setRefresh((value) => value + 1);
    setDocumentRefresh((value) => value + 1);
  }

  const selectData = (["project", "global"] as const).flatMap((groupScope) => {
    const items = (prompts ?? []).filter((prompt) => prompt.ref.scope === groupScope);
    if (!items.length) return [];
    return [{
      group: groupScope === "project" ? "Project" : "Global",
      items: items.map((prompt) => ({ value: refKey(prompt.ref), label: prompt.title })),
    }];
  });

  return (
    <section className="tool-pane" aria-label="Prompt library">
      <header className="tool-heading">
        <h2>Prompt Library</h2>
        <Group gap={2} wrap="nowrap">
          <ActionIcon
            size="sm"
            disabled={Boolean(draft) || busy}
            aria-label="New prompt"
            title="New prompt"
            onClick={() => {
              setDocumentError("");
              setDraft({ source: blankPrompt, ref: { scope: root ? "project" : "global", path: "" } });
            }}
          >
            <Plus size={15} weight="bold" />
          </ActionIcon>
          <ActionIcon size="sm" disabled={Boolean(draft) || busy} onClick={refreshPrompts} aria-label="Reload prompts" title="Reload prompts">
            <ArrowClockwise size={13} />
          </ActionIcon>
        </Group>
      </header>
      <ScrollArea className="tool-scroll" type="auto">
        <Stack gap="xs" p="sm">
          {listError && <Alert color="red" variant="light">{listError}</Alert>}
          {!draft && (
            <>
              {prompts?.length ? (
                <Select
                  label="Template"
                  size="xs"
                  placeholder="Select a template"
                  value={choice || null}
                  disabled={busy}
                  data={selectData}
                  allowDeselect
                  onChange={(value) => setChoice(value ?? "")}
                />
              ) : !listError && (
                prompts ? (
                  <Stack align="center" gap="xs" py="xl">
                    <BookOpen size={22} weight="duotone" color="var(--muted)" />
                    <Text size="xs" c="dimmed">No prompt templates yet</Text>
                  </Stack>
                ) : <Text size="xs" c="dimmed" role="status">Loading prompts…</Text>
              )}
              {choice && !document && !documentError && <Text size="xs" c="dimmed" role="status">Loading template…</Text>}
              {document && refKey(document.ref) === choice && (
                <form onSubmit={usePrompt}>
                  <Stack gap="xs">
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                        <Text size="11px" ff="monospace" c="dimmed" truncate="end" title={document.ref.path}>
                          {document.ref.path}
                        </Text>
                        {document.providerId && <Badge size="xs" variant="outline" color="gray">{document.providerId}</Badge>}
                        {document.effort && <Badge size="xs" variant="light" color="iris">{EFFORT_META[document.effort].label}</Badge>}
                        {document.mode && <Badge size="xs" variant="light" color="gray">{document.mode}</Badge>}
                      </Group>
                      <ActionIcon
                        size="sm"
                        disabled={busy}
                        aria-label="Edit prompt source"
                        title="Edit prompt source"
                        onClick={() => {
                          setDocumentError("");
                          setDraft({ ref: document.ref, source: document.source, revision: document.revision });
                        }}
                      >
                        <PencilSimple size={13} />
                      </ActionIcon>
                    </Group>
                    {document.parseError ? <Alert color="red" variant="light">{document.parseError}</Alert> : (
                      <Stack gap="xs">
                        <Paper p="xs" withBorder bg="dark.9">
                          <pre className="prompt-preview">{document.body}</pre>
                        </Paper>
                        {document.variables.map(({ name }) => (
                          <Textarea
                            key={name}
                            label={name}
                            size="xs"
                            rows={2}
                            value={values[name] ?? ""}
                            disabled={busy}
                            onChange={(event) => setValues({ ...values, [name]: event.currentTarget.value })}
                          />
                        ))}
                        <Group>
                          <Button
                            type="submit"
                            color="iris"
                            size="compact-xs"
                            loading={busy}
                            rightSection={<ArrowUpRight size={14} />}
                          >
                            Use prompt
                          </Button>
                        </Group>
                      </Stack>
                    )}
                  </Stack>
                </form>
              )}
            </>
          )}
          {draft && (
            <form onSubmit={saveSource}>
              <Stack gap="xs">
                {draft.revision === undefined ? (
                  <>
                    <Select
                      label="Library"
                      size="xs"
                      value={draft.ref.scope}
                      disabled={busy}
                      data={[
                        ...(root ? [{ value: "project", label: "Project" }] : []),
                        { value: "global", label: "Global" },
                      ]}
                      onChange={(value) => setDraft({ ...draft, ref: { ...draft.ref, scope: value === "global" ? "global" : "project" } })}
                    />
                    <TextInput
                      label="Filename"
                      size="xs"
                      value={draft.ref.path}
                      placeholder="review.prompt.md"
                      required
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, ref: { ...draft.ref, path: event.currentTarget.value } })}
                    />
                  </>
                ) : <Text size="11px" ff="monospace" c="dimmed">{draft.ref.path}</Text>}
                <Textarea
                  label="Markdown source"
                  size="xs"
                  classNames={{ input: "prompt-source" }}
                  rows={9}
                  value={draft.source}
                  required
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, source: event.currentTarget.value })}
                />
                <Group gap="xs">
                  <Button type="submit" color="iris" size="compact-xs" loading={busy}>Save prompt</Button>
                  <Button variant="default" size="compact-xs" disabled={busy} onClick={() => { setDraft(null); setDocumentError(""); }}>
                    Cancel
                  </Button>
                </Group>
              </Stack>
            </form>
          )}
          {documentError && <Alert color="red" variant="light">{documentError}</Alert>}
        </Stack>
      </ScrollArea>
    </section>
  );
}

export function PromptLibrary(props: PromptLibraryProps) {
  return <PromptLibraryView key={props.root ?? ""} {...props} />;
}
