/** Web first-release offline policy: drafts may change, structural requests wait for a connection. */
export type OfflineAction =
  | "create-inbox"
  | "edit-cached"
  | "search-cached"
  | "read-cached-attachment"
  | "attachment-upload"
  | "structure-change"
  | "server-processing";

const offlineAllowed = new Set<OfflineAction>([
  "create-inbox",
  "edit-cached",
  "search-cached",
  "read-cached-attachment",
]);

export function canPerformAction(offline: boolean, action: OfflineAction) {
  return !offline || offlineAllowed.has(action);
}
