import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, Group, Text } from "@mantine/core";
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
  const dialog = useRef<HTMLDialogElement>(null);
  const dismissButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const kind = notice?.kind;

  useLayoutEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (!kind) {
      if (modal.open) modal.close();
    } else if (!modal.open) {
      modal.showModal();
    } else if (kind === "terminals-open") {
      dismissButton.current?.focus();
    }
  }, [kind]);

  let message: string | undefined;
  switch (notice?.kind) {
    case "checking": message = "Checking for updates…"; break;
    case "up-to-date": message = `Uya ${version} is up to date.`; break;
    case "ready": message = `Uya ${pendingVersion} is ready to install.`; break;
    case "installing": message = "Installing the update. Uya will restart."; break;
    case "terminals-open": message = "Restarting Uya will end your open terminal sessions."; break;
    case "blocked":
    case "error": message = notice.message; break;
  }

  return (
    <dialog
      ref={dialog}
      className="app-update-dialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => { if (kind === "installing") event.preventDefault(); }}
      onClose={() => { if (!dialog.current?.open) dismiss(); }}
    >
      <Text component="h1" id={titleId} fw={650} m={0}>Uya updates</Text>
      <Text id={messageId} size="sm" c="dimmed" mt={8} mb={16} role="status">{message}</Text>
      {kind !== "installing" && (
        <Group justify="flex-end" gap="xs">
          <form method="dialog">
            <Button type="submit" ref={dismissButton} variant="default" size="xs">
              {kind === "ready" || kind === "terminals-open" ? "Later" : "Close"}
            </Button>
          </form>
          {(kind === "ready" || kind === "terminals-open") && (
            <Button size="xs" color="iris" onClick={() => void restart(kind === "terminals-open")}>
              Restart to Update
            </Button>
          )}
        </Group>
      )}
    </dialog>
  );
}
