import React, { Component, type ReactNode } from "react";

/** A failed editor chunk must not take down draft export or synchronization UI. */
export class EditorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="notice error" role="alert">
          编辑器暂时无法打开，原文没有被修改。可先用下方验证工具导出草稿，再恢复网络并刷新页面。
        </div>
      );
    return this.props.children;
  }
}
