import { create } from "zustand";
import { persist } from "zustand/middleware";

export type InputMode = "controller" | "keyboard";

/**
 * Zustand store for ephemeral, client-only UI state.
 * Domain/server-derived state lives in hooks (useSession, useRunChannel, etc.).
 */
interface UIState {
  /** Active driver input source */
  inputMode: InputMode;
  setInputMode: (mode: InputMode) => void;

  /** Console pane collapsed */
  consoleCollapsed: boolean;
  toggleConsoleCollapsed: () => void;

  /** Scope pane collapsed */
  scopeCollapsed: boolean;
  toggleScopeCollapsed: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      inputMode: "controller",
      setInputMode: (inputMode) => set({ inputMode }),

      consoleCollapsed: false,
      toggleConsoleCollapsed: () =>
        set((s) => ({ consoleCollapsed: !s.consoleCollapsed })),

      scopeCollapsed: false,
      toggleScopeCollapsed: () =>
        set((s) => ({ scopeCollapsed: !s.scopeCollapsed })),
    }),
    {
      name: "frc-coderunner-ui",
      partialize: (state) => ({ inputMode: state.inputMode }),
    },
  ),
);
