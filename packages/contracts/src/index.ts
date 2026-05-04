export const V1_ROUTE_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

export type V1WorkspaceRoute = {
  workspaceSlug: string;
};

export function isWorkspaceSlug(value: string): boolean {
  return V1_ROUTE_SLUG_PATTERN.test(value);
}
