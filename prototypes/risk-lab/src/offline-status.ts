export type OfflineStatus = "installing" | "ready" | "waiting" | "failed";

export const offlineStatusText: Record<OfflineStatus, string> = {
  installing: "正在准备离线界面，请暂时保持联网。",
  ready: "离线界面已安装；首次安装后重新打开生效。",
  waiting:
    "新版本已准备好。请确认各标签页已保存本机（保存失败时先导出草稿），关闭此应用的全部标签页后重新打开。仅刷新不会立即升级。",
  failed:
    "离线界面安装未完成，请联网后重试。此状态不代表笔记保存失败，也不要因此清除浏览器数据。",
};

/** Observe installation only; never force activation or reload an editor. */
export function observeOfflineStatus(
  registration: ServiceWorkerRegistration,
  notify: (status: OfflineStatus) => void,
) {
  let watched: ServiceWorker | null = null;
  const stateChanged = () => {
    const state = watched?.state;
    if (state === "redundant") notify("failed");
    else if (
      registration.waiting || (state === "installed" && registration.active)
    )
      notify("waiting");
    else if (state === "activated" || (!watched && registration.active))
      notify("ready");
    else notify("installing");
  };
  const watch = () => {
    watched?.removeEventListener("statechange", stateChanged);
    watched = registration.installing ?? registration.waiting;
    watched?.addEventListener("statechange", stateChanged);
    stateChanged();
  };
  registration.addEventListener("updatefound", watch);
  watch();
  return () => {
    registration.removeEventListener("updatefound", watch);
    watched?.removeEventListener("statechange", stateChanged);
  };
}
