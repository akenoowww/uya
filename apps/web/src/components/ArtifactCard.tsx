import { useEffect, useId, useState } from "react";
import { Button, Group, Loader, Modal, Paper, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { useFocusReturn } from "@mantine/hooks";
import { File, FileCode, FileText, Image, Paperclip, VideoCamera, Waveform } from "@phosphor-icons/react";
import type { ArtifactItem, RpcCall } from "@ide/protocol";
import { errorMessage } from "../bridge";

interface Props {
  artifact: ArtifactItem;
  workspacePath: string | null;
  rpc?: RpcCall;
  onOpenFile?: (path: string) => void;
  onAttachFile?: (path: string) => void;
}

const ARTIFACT_ICONS = {
  audio: Waveform,
  image: Image,
  video: VideoCamera,
  file: File,
  json: FileCode,
  text: FileText,
};

const MEBIBYTE = 1024 * 1024;
const AUTO_PREVIEW_LIMIT = 8 * MEBIBYTE;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MEBIBYTE) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}

interface PreviewResult {
  rpc: RpcCall;
  attempt: number;
  url?: string;
  error?: string;
}

function ArtifactPreview({ artifact, workspacePath, rpc, deferred }: {
  artifact: ArtifactItem;
  workspacePath: string;
  rpc: RpcCall;
  deferred: boolean;
}) {
  const { kind, label, path } = artifact;
  const [attempt, setAttempt] = useState(deferred ? 0 : 1);
  const [result, setResult] = useState<PreviewResult>();
  const [imageState, setImageState] = useState<"idle" | "open" | "restore">("idle");
  const imageModalId = useId();
  const imageOpened = imageState === "open";
  const preview = result?.rpc === rpc && result.attempt === attempt ? result : undefined;
  useFocusReturn({ opened: imageOpened });

  useEffect(() => {
    if (attempt === 0) return;
    let active = true;
    let objectUrl: string | undefined;

    async function loadPreview() {
      try {
        const res = await rpc("workspace.readBinary", { path, workspacePath });
        if (!active) return;
        const bytes = Uint8Array.from(atob(res.base64), (character) => character.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: res.mimeType }));
        setResult({ rpc, attempt, url: objectUrl });
      } catch (error) {
        if (active) setResult({ rpc, attempt, error: errorMessage(error) });
      }
    }

    void loadPreview();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, path, rpc, workspacePath]);

  if (attempt === 0 || preview?.error) {
    return (
      <Group gap="xs">
        {preview?.error && <Text size="xs" c="red.4" role="alert">{preview.error}</Text>}
        <Button size="compact-xs" variant="light" onClick={() => setAttempt((current) => current + 1)}>
          {preview?.error ? "Retry preview" : `Load ${kind} preview`}
        </Button>
      </Group>
    );
  }

  if (!preview?.url) {
    return (
      <Group gap={6} role="status">
        <Loader size={12} aria-hidden="true" />
        <Text size="xs" c="dimmed">Loading preview…</Text>
      </Group>
    );
  }

  function handleMediaError() {
    setImageState("idle");
    setResult({ rpc, attempt, error: `Could not display the ${kind} preview.` });
  }

  if (kind === "audio") {
    return (
      <audio
        controls
        preload="metadata"
        src={preview.url}
        style={{ width: "100%", height: 34 }}
        aria-label={label}
        onError={handleMediaError}
      />
    );
  }

  if (kind === "video") {
    return (
      <video
        controls
        preload="metadata"
        src={preview.url}
        style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 6 }}
        aria-label={label}
        onError={handleMediaError}
      />
    );
  }

  return (
    <>
      <UnstyledButton
        type="button"
        aria-label={`Open full-size image ${label}`}
        aria-haspopup="dialog"
        data-autofocus={imageState === "restore" || undefined}
        onBlur={() => {
          if (imageState === "restore") setImageState("idle");
        }}
        onClick={() => setImageState("open")}
        style={{ display: "block", alignSelf: "flex-start", maxWidth: "100%", borderRadius: 6, cursor: "zoom-in" }}
      >
        <img
          src={preview.url}
          alt={label}
          style={{ display: "block", maxWidth: "100%", maxHeight: 240, objectFit: "contain", borderRadius: 6 }}
          onError={handleMediaError}
        />
      </UnstyledButton>
      <Modal
        stackId={imageModalId}
        opened={imageOpened}
        onClose={() => setImageState("restore")}
        title={label}
        size="auto"
        centered
        returnFocus={false}
        closeButtonProps={{ "aria-label": "Close image preview" }}
      >
        <img
          src={preview.url}
          alt={label}
          style={{ display: "block", maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }}
          onError={() => setImageState("restore")}
        />
      </Modal>
    </>
  );
}

export function ArtifactCard({ artifact, workspacePath, rpc, onOpenFile, onAttachFile }: Props) {
  const { id, kind, label, path, bytes, createdAt } = artifact;
  const Icon = ARTIFACT_ICONS[kind];
  const isMedia = kind === "audio" || kind === "image" || kind === "video";
  const deferred = bytes !== undefined && bytes > AUTO_PREVIEW_LIMIT;
  const pathText = (
    <Text component="span" size="xs" ff="monospace" c={isMedia && onOpenFile ? "iris.3" : "dimmed"} style={{ overflowWrap: "anywhere" }}>
      {path}
    </Text>
  );

  return (
    <Paper withBorder bg="dark.8" radius="sm" p="xs" my={6}>
      <Stack gap={6}>
        <Group gap={8}>
          <ThemeIcon color="iris" variant="light" size="sm" aria-hidden="true">
            <Icon size={14} weight="duotone" />
          </ThemeIcon>
          <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>{label}</Text>
          {bytes !== undefined && <Text size="xs" c="dimmed">{formatSize(bytes)}</Text>}
        </Group>
        {isMedia && rpc && workspacePath && (
          <ArtifactPreview
            key={JSON.stringify([workspacePath, id, path, createdAt, kind, deferred])}
            artifact={artifact}
            workspacePath={workspacePath}
            rpc={rpc}
            deferred={deferred}
          />
        )}
        <Group justify="space-between" gap={6}>
          {isMedia && onOpenFile ? (
            <UnstyledButton type="button" aria-label={`Open ${path} in editor`} onClick={() => onOpenFile(path)}>
              {pathText}
            </UnstyledButton>
          ) : pathText}
          <Group gap={6}>
            {!isMedia && (
              <Button size="compact-xs" variant="default" disabled={!onOpenFile} onClick={() => onOpenFile?.(path)}>
                Open in editor
              </Button>
            )}
            <Button
              size="compact-xs"
              variant="light"
              color="iris"
              leftSection={<Paperclip size={12} aria-hidden="true" />}
              disabled={!onAttachFile}
              onClick={() => onAttachFile?.(path)}
            >
              Attach @file
            </Button>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
