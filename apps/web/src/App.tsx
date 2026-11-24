import { useMemo, useState } from "react";
import { MantineProvider } from "@mantine/core";
import { AppUpdateDialog, useAppUpdate } from "./AppUpdate";
import { CommandPalette, openCommandPalette, toggleCommandPalette } from "./components/CommandPalette";
import { QuickOpenModal } from "./components/QuickOpenModal";
import { Composer } from "./Composer";
import { useProtectEditorDrafts } from "./editorDrafts";
import { uyaTheme } from "./mantineTheme";
import { useWorkbenchShortcuts } from "./shortcuts";
import { ActivityRail, WorkbenchDialogs, WorkbenchSidebar, WorkbenchStatus, WorkbenchTitlebar } from "./WorkbenchChrome";
import { WorkbenchConnection } from "./WorkbenchConnection";
import { WorkbenchDock } from "./WorkbenchDock";
import { createWorkbench } from "./workbench";
import { WorkbenchContext, useWorkbench, useWorkbenchState } from "./workbenchContext";

function QuickOpenHost({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { dock } = useWorkbench();
  const root = useWorkbenchState((state) => state.workspace?.path ?? null);
  const rpc = useWorkbenchState((state) => state.bridge?.rpc);
  return (
    <QuickOpenModal
      opened={opened}
      onClose={onClose}
      root={root}
      rpc={rpc}
      onOpenFile={(path) => dock.openFile(path)}
    />
  );
}

export function App() {
  const [workbench] = useState(createWorkbench);
  const [quickOpen, setQuickOpen] = useState(false);
  const update = useAppUpdate(workbench.store, workbench.retryConnection);
  const shortcutControls = useMemo(() => ({
    togglePalette: toggleCommandPalette,
    openQuickOpen: () => setQuickOpen(true),
    openShortcuts: () => workbench.openShortcuts(),
  }), [workbench]);

  useProtectEditorDrafts(workbench.readEditorDrafts);
  useWorkbenchShortcuts(workbench, shortcutControls);

  return (
    <MantineProvider theme={uyaTheme} forceColorScheme="dark">
      <WorkbenchContext.Provider value={workbench}>
        <WorkbenchConnection />
        <div className="workspace-shell">
          <WorkbenchTitlebar
            onOpenPalette={openCommandPalette}
            onRestartToUpdate={update.pendingVersion ? () => void update.restart() : undefined}
          />
          <div className="workspace-body">
            <ActivityRail />
            <WorkbenchSidebar />
            <main className="workbench">
              <WorkbenchDock />
              <Composer />
            </main>
          </div>
          <WorkbenchStatus version={update.version} />
          <WorkbenchDialogs />
          <QuickOpenHost opened={quickOpen} onClose={() => setQuickOpen(false)} />
          <CommandPalette
            onOpenQuickOpen={() => setQuickOpen(true)}
            onCheckForUpdates={update.enabled ? update.checkForUpdates : undefined}
          />
          <AppUpdateDialog update={update} />
        </div>
      </WorkbenchContext.Provider>
    </MantineProvider>
  );
}
