export async function requestPersistentStorage(
  storage: Pick<StorageManager, "persisted" | "persist"> | undefined,
): Promise<boolean | null> {
  if (!storage) return null;
  try {
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
