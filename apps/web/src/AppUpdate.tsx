import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Group, Loader, Modal, Text } from "@mantine/core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { errorMessage } from "./bridge";
import { hasPendingEditorSaves, hasUnsavedEditorDrafts } from "./editorDrafts";
import type { WorkbenchStore } from "./workbenchStore";

const checkInterval = 60 * 60 * 1_000;

interface AppUpdateInfo {
  version: string;
  enabled: boolean;
}

type UpdateNotice =
  | { kind: "checking" | "up-to-date" | "ready" | "installing" | "terminals-open" }
  | { kind: "blocked" | "error"; message: string };

export function useAppUpdate(store: WorkbenchStore, reconnect: () => void) {
  const [app, setApp] = useState<AppUpdateInfo | null>(null);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const preparing = useRef<Promise<string | null> | null>(null);
  const installing = useRef(false);

  const prepare = useCallback(() => {
    if (preparing.current) return preparing.current;
    const request = invoke<string | null>("prepare_app_update")
      .then((version) => {
        setPendingVersion(version);
        return version;
      })
      .finally(() => { preparing.current = null; });
    preparing.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    void invoke<AppUpdateInfo>("get_app_update_info")
      .then((info) => { if (current) setApp(info); })
      .catch(() => {});
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!app?.enabled || pendingVersion) return;
    const check = () => { void prepare().catch(() => {}); };
    check();
    const timer = window.setInterval(check, checkInterval);
    return () => window.clearInterval(timer);
  }, [app?.enabled, pendingVersion, prepare]);

  const checkForUpdates = useCallback(async () => {
    if (installing.current) return;
    if (pendingVersion) {
      setNotice({ kind: "ready" });
      return;
    }
    setNotice({ kind: "checking" });
    let result: UpdateNotice;
    try {
      result = { kind: await prepare() ? "ready" : "up-to-date" };
    } catch (error) {
      result = { kind: "error", message: errorMessage(error) };
    }
    setNotice((current) => current?.kind === "checking" ? result : current);
  }, [pendingVersion, prepare]);

  async function restart(allowTerminalShutdown = false) {
    if (!pendingVersion || installing.current) return;
    const state = store.getState();
    if (hasPendingEditorSaves(state.editorDrafts) || hasUnsavedEditorDrafts(state.editorDrafts)) {
      setNotice({ kind: "blocked", message: "Save your open files before restarting Uya." });
      return;
    }
    if (state.choosingProject || state.submitting || state.submittingPanes.length > 0
      || state.history.some((run) => run.status === "running")
      || Object.values(state.details).some(({ run }) => run.status === "running")) {
      setNotice({ kind: "blocked", message: "Wait for your current work to finish before restarting Uya." });
      return;
    }
    installing.current = true;
    setNotice({ kind: "installing" });
    try {
      const result = await invoke<"terminals-open" | null>("install_app_update", {
        version: pendingVersion, allowTerminalShutdown,
      });
      if (result === "terminals-open") setNotice({ kind: "terminals-open" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
      reconnect();
    } finally {
      installing.current = false;
    }
  }

  return {
    version: app?.version,
    enabled: app?.enabled ?? false,
    pendingVersion,
    notice,
    checkForUpdates,
    restart,
    dismiss: () => setNotice(null),
  };
}

export function AppUpdateDialog({ update }: { update: ReturnType<typeof useAppUpdate> }) {
  const { notice, version, pendingVersion, dismiss, restart } = update;
  const kind = notice?.kind;
  const locked = kind === "installing";

  let message: string | undefined;
  switch (kind) {
    case "checking": message = "Checking for updates…"; break;
    case "up-to-date": message = `Uya ${version} is up to date.`; break;
    case "ready": message = `Uya ${pendingVersion} is ready to install.`; break;
    case "installing": message = "Installing the update. Uya will restart."; break;
    case "terminals-open": message = "Restarting Uya will end your open terminal sessions."; break;
    case "blocked":
    case "error": message = notice?.message; break;
  }

  return (
    <Modal
      opened={Boolean(kind)}
      onClose={() => { if (!locked) dismiss(); }}
      title="Uya updates"
      size="sm"
      closeOnClickOutside={!locked}
      closeOnEscape={!locked}
      withCloseButton={!locked}
    >
      <Group gap="xs" align="center" mb="md" role="status">
        {(kind === "checking" || kind === "installing") && <Loader size="xs" color="iris" />}
        <Text size="sm" c="dimmed">{message}</Text>
      </Group>
      {!locked && (
        <Group justify="flex-end" gap="xs">
          <Button variant="default" size="xs" onClick={dismiss} autoFocus={kind === "terminals-open"}>
            {kind === "ready" || kind === "terminals-open" ? "Later" : "Close"}
          </Button>
          {(kind === "ready" || kind === "terminals-open") && (
            <Button size="xs" color="iris" onClick={() => void restart(kind === "terminals-open")}>
              Restart to Update
            </Button>
          )}
        </Group>
      )}
    </Modal>
  );
}
