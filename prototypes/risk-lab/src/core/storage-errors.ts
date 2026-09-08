export function describeStorageError(error: unknown): string {
  const value = error as { name?: unknown; message?: unknown };
  const name = typeof value?.name === "string" ? value.name : "";
  const message = typeof value?.message === "string" ? value.message : String(error);
  if (
    name === "QuotaExceededError" ||
    /quota|storage space|存储空间|配额/i.test(message)
  )
    return "浏览器本机空间不足，内容未能保存。请先导出未同步草稿，清理站点空间后再试。";
  if (/private|不允许|denied|blocked|拒绝/i.test(message))
    return "浏览器拒绝本机存储，内容未能保存。请关闭隐私限制或换用普通窗口，并先导出草稿。";
  return message;
}
