import {
  decodeAttachment,
  mediaTypes,
  type Attachment,
} from "./core/attachments";

export function attachmentBlob(path: string, value: Attachment) {
  return new Blob([decodeAttachment(value)], {
    type:
      mediaTypes[path.split(".").pop()!.toLowerCase()] ??
      "application/octet-stream",
  });
}
export function downloadAttachment(path: string, value: Attachment) {
  const url = URL.createObjectURL(attachmentBlob(path, value));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split("/").pop()!;
  try {
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
