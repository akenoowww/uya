import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkbench, useWorkbenchState } from "./workbenchContext";

export function WorkbenchConnection() {
  const { core } = useWorkbench();
  const bridge = useWorkbenchState((state) => state.bridge);
  const attempt = useWorkbenchState((state) => state.connectionAttempt);
  const root = useWorkbenchState((state) => state.workspace?.path ?? null);
  const conversationIds = useWorkbenchState(useShallow((state) => state.dock.chatPanes.flatMap(({ config }) =>
    config.conversationId ? [config.conversationId] : []).sort()));

  useEffect(() => core.start(), [core, attempt]);
  useEffect(() => {
    if (bridge) return core.hydrate(bridge, root, conversationIds);
  }, [core, bridge, root, conversationIds]);
  return null;
}
