export type RunFlushFileState = {
  path: string;
  access: "editable" | "readonly";
  dirty: boolean;
  saving: boolean;
  error: string | null;
};

export function runFlushBlockers(files: RunFlushFileState[]): RunFlushFileState[] {
  return files.filter((file) => file.access === "editable" && (file.dirty || file.saving || file.error));
}
