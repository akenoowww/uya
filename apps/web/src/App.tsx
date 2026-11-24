import { useMemo, useState } from "react";
import { MantineProvider } from "@mantine/core";
import { AppUpdateDialog, useAppUpdate } from "./AppUpdate";
import { CommandPalette, openCommandPalette, toggleCommandPalette } from "./components/CommandPalette";
import { Composer } from "./Composer";
import { useProtectEditorDrafts } from "./editorDrafts";
import { uyaTheme } from "./mantineTheme";
import { useWorkbenchShortcuts } from "./shortcuts";
import { ActivityRail, WorkbenchDialogs, WorkbenchSidebar, WorkbenchStatus, WorkbenchTitlebar, WorkbenchToolbar } from "./WorkbenchChrome";
import { WorkbenchConnection } from "./WorkbenchConnection";
import { WorkbenchDock } from "./WorkbenchDock";
import { createWorkbench } from "./workbench";
import { WorkbenchContext } from "./workbenchContext";

export function App() {
  const [workbench] = useState(createWorkbench);
  const update = useAppUpdate(workbench.store, workbench.retryConnection);
  const shortcutControls = useMemo(() => ({
    togglePalette: toggleCommandPalette,
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
              <WorkbenchToolbar />
              <WorkbenchDock />
              <Composer />
            </main>
          </div>
          <WorkbenchStatus onOpenPalette={openCommandPalette} version={update.version} />
          <WorkbenchDialogs />
          <CommandPalette onCheckForUpdates={update.enabled ? update.checkForUpdates : undefined} />
          <AppUpdateDialog update={update} />
        </div>
      </WorkbenchContext.Provider>
    </MantineProvider>
  );
}
