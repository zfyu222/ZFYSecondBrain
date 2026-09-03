import { describe, expect, it, vi } from "vitest";
import { observeOfflineStatus, offlineStatusText } from "../src/offline-status";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  change(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}
class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
}
function setup(registration: FakeRegistration) {
  const notify = vi.fn();
  const stop = observeOfflineStatus(
    registration as unknown as ServiceWorkerRegistration,
    notify,
  );
  return { notify, stop };
}
describe("offline update notices", () => {
  it("tracks a first installation through activation without suggesting a forced reload", () => {
    const reg = new FakeRegistration();
    const worker = new FakeWorker();
    reg.installing = worker;
    const test = setup(reg);
    expect(test.notify).toHaveBeenLastCalledWith("installing");
    worker.change("installed");
    expect(test.notify).toHaveBeenLastCalledWith("installing");
    reg.active = worker;
    reg.installing = null;
    worker.change("activated");
    expect(test.notify).toHaveBeenLastCalledWith("ready");
    test.stop();
  });
  it("recognizes an update already waiting when a tab opens", () => {
    const reg = new FakeRegistration();
    reg.active = new FakeWorker();
    reg.waiting = new FakeWorker();
    reg.waiting.state = "installed";
    const test = setup(reg);
    expect(test.notify).toHaveBeenLastCalledWith("waiting");
    expect(offlineStatusText.waiting).toContain("保存失败时先导出草稿");
    expect(offlineStatusText.waiting).toContain("全部标签页");
    test.stop();
  });
  it("observes a later update and the installed/waiting property race", () => {
    const reg = new FakeRegistration();
    reg.active = new FakeWorker();
    const test = setup(reg);
    expect(test.notify).toHaveBeenLastCalledWith("ready");
    reg.installing = new FakeWorker();
    reg.dispatchEvent(new Event("updatefound"));
    expect(test.notify).toHaveBeenLastCalledWith("installing");
    reg.installing.change("installed");
    expect(test.notify).toHaveBeenLastCalledWith("waiting");
    test.stop();
  });
  it("reports failed cache installation and releases all observers on unmount", () => {
    const reg = new FakeRegistration();
    reg.installing = new FakeWorker();
    const test = setup(reg);
    reg.installing.change("redundant");
    expect(test.notify).toHaveBeenLastCalledWith("failed");
    expect(offlineStatusText.failed).toContain("不代表笔记保存失败");
    test.stop();
    test.notify.mockClear();
    reg.installing.change("activated");
    reg.dispatchEvent(new Event("updatefound"));
    expect(test.notify).not.toHaveBeenCalled();
  });
  it("ignores an obsolete installing worker once its replacement is observed", () => {
    const reg = new FakeRegistration();
    reg.installing = new FakeWorker();
    const old = reg.installing;
    const test = setup(reg);
    reg.installing = new FakeWorker();
    reg.dispatchEvent(new Event("updatefound"));
    test.notify.mockClear();
    old.change("redundant");
    expect(test.notify).not.toHaveBeenCalled();
    reg.installing.change("redundant");
    expect(test.notify).toHaveBeenLastCalledWith("failed");
    test.stop();
  });
});
