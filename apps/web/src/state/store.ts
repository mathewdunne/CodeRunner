import { create } from "zustand";

/**
 * Zustand store for ephemeral, client-only UI state.
 * Domain/server-derived state lives in hooks (useSession, useRunChannel, etc.).
 */
interface UIState {
  /** Console pane collapsed */
  consoleCollapsed: boolean;
  toggleConsoleCollapsed: () => void;

  /** Scope pane collapsed */
  scopeCollapsed: boolean;
  toggleScopeCollapsed: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  consoleCollapsed: false,
  toggleConsoleCollapsed: () =>
    set((s) => ({ consoleCollapsed: !s.consoleCollapsed })),

  scopeCollapsed: false,
  toggleScopeCollapsed: () =>
    set((s) => ({ scopeCollapsed: !s.scopeCollapsed })),
}));
