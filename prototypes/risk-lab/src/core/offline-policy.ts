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

/** Offline creation has no structural intent: it always enters the Inbox queue. */
export function newNoteParent(offline: boolean, selectedFolder: string) {
  if (offline) return "raw/Inbox";
  return selectedFolder.startsWith("raw/") && !selectedFolder.startsWith("raw/Archive")
    ? selectedFolder
    : "raw/Inbox";
}
