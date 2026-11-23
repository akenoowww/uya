import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { Workbench } from "./workbench";
import type { WorkbenchState } from "./workbenchStore";

export const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("Missing workbench.");
  return value;
}

export function useWorkbenchState<T>(selector: (state: WorkbenchState) => T): T {
  return useStore(useWorkbench().store, selector);
}
