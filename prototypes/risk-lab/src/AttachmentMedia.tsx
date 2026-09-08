import React, { useEffect, useState } from "react";
import { mediaTypes, type Attachment } from "./core/attachments";

import { attachmentBlob, downloadAttachment } from "./attachment-files";

export type AttachmentPreviewKind = "image" | "video" | "audio" | "pdf" | "download";

// Only byte-verified attachments already stored in the current vault may be
// previewed. Ordinary Markdown links deliberately remain download-only.
export function attachmentPreviewKind(
  path: string,
  downloadOnly = false,
): AttachmentPreviewKind {
  if (downloadOnly) return "download";
  const mime = mediaTypes[path.split(".").pop()!.toLowerCase()];
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "download";
}

export function AttachmentMedia({
  path,
  value,
  label,
  downloadOnly = false,
}: {
  path: string;
  value: Attachment;
  label: React.ReactNode;
  downloadOnly?: boolean;
}) {
  const [resource, setResource] = useState<{
    path: string;
    value: Attachment;
    url: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const kind = attachmentPreviewKind(path, downloadOnly);
  useEffect(() => {
    setFailed(false);
    if (kind === "download")
      return;
    const url = URL.createObjectURL(attachmentBlob(path, value));
    setResource({ path, value, url });
    return () => URL.revokeObjectURL(url);
  }, [path, value, kind]);
  const url =
    resource?.value === value && resource.path === path
      ? resource.url
      : undefined;
  return (
    <span className="attachment-media" data-attachment-path={path}>
      {!downloadOnly &&
        !failed &&
        url &&
        (kind === "image" ? (
          <img
            src={url}
            alt={typeof label === "string" ? label : path}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : kind === "video" ? (
          <video
            src={url}
            controls
            preload="none"
            aria-label={path}
            onError={() => setFailed(true)}
          />
        ) : kind === "audio" ? (
          <audio
            src={url}
            controls
            preload="none"
            aria-label={path}
            onError={() => setFailed(true)}
          />
        ) : kind === "pdf" ? (
          <>
            <iframe
              className="attachment-pdf"
              src={url}
              title={`PDF 预览：${path}`}
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
            />
            <small className="attachment-pdf-help">
              PDF 预览由当前浏览器提供；如未显示，请下载原始文件。
            </small>
          </>
        ) : null)}
      {failed && <small>无法解码此附件，原始文件仍可下载。</small>}
      <button
        type="button"
        className="note-link"
        onClick={() => downloadAttachment(path, value)}
        title={path}
      >
        下载附件：{label || path.split("/").pop()}
      </button>
    </span>
  );
}
