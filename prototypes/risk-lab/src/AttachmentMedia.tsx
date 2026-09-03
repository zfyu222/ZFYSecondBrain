import React, { useEffect, useState } from "react";
import { mediaTypes, type Attachment } from "./core/attachments";

import { attachmentBlob, downloadAttachment } from "./attachment-files";
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
  useEffect(() => {
    setFailed(false);
    if (
      downloadOnly ||
      !/^(image|video|audio)\//.test(
        mediaTypes[path.split(".").pop()!.toLowerCase()] ?? "",
      )
    )
      return;
    const url = URL.createObjectURL(attachmentBlob(path, value));
    setResource({ path, value, url });
    return () => URL.revokeObjectURL(url);
  }, [path, value, downloadOnly]);
  const url =
    resource?.value === value && resource.path === path
      ? resource.url
      : undefined;
  const mime = mediaTypes[path.split(".").pop()!.toLowerCase()];
  return (
    <span className="attachment-media" data-attachment-path={path}>
      {!downloadOnly &&
        !failed &&
        url &&
        (mime?.startsWith("image/") ? (
          <img
            src={url}
            alt={typeof label === "string" ? label : path}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : mime?.startsWith("video/") ? (
          <video
            src={url}
            controls
            preload="none"
            aria-label={path}
            onError={() => setFailed(true)}
          />
        ) : mime?.startsWith("audio/") ? (
          <audio
            src={url}
            controls
            preload="none"
            aria-label={path}
            onError={() => setFailed(true)}
          />
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
