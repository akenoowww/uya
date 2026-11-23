import { useMemo, useState } from "react";
import { MantineProvider } from "@mantine/core";
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
          <WorkbenchTitlebar onOpenPalette={openCommandPalette} />
          <div className="workspace-body">
            <ActivityRail />
            <WorkbenchSidebar />
            <main className="workbench">
              <WorkbenchToolbar />
              <WorkbenchDock />
              <Composer />
            </main>
          </div>
          <WorkbenchStatus onOpenPalette={openCommandPalette} />
          <WorkbenchDialogs />
          <CommandPalette />
        </div>
      </WorkbenchContext.Provider>
    </MantineProvider>
  );
}
