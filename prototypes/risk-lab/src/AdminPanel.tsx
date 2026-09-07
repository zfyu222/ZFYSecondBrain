import { useEffect, useState } from "react";

type Review = {
  id: string;
  task: string;
  path: string;
  before: string | null;
  after: string;
  rationale: string;
  createdAt: string;
  status: "pending" | "applied" | "rejected" | "stale";
};
type MemoryCandidate = {
  capability: "summaries" | "inbox" | "dualView";
  path: string;
  reason: string;
};
type MemoryState = {
  config: {
    enabled: boolean;
    localTime: string;
    capabilities: { summaries: boolean; inbox: boolean; dualView: boolean };
  };
  runs: {
    id: string;
    trigger: "scheduled" | "manual";
    startedAt: string;
    sourceRevision: string;
    status: "completed" | "awaiting-manager";
    message: string;
    candidates: MemoryCandidate[];
  }[];
  confirmations: {
    id: string;
    sourcePath: string;
    destination: string;
    tags: string[];
    rationale: string;
    status: "pending" | "applied" | "rejected" | "stale";
  }[];
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof body.error === "string" ? body.error : `请求失败（${response.status}）`,
    );
  return body as T;
}

const capabilityLabel = {
  summaries: "多级摘要",
  inbox: "Inbox 分类与标签",
  dualView: "双视图检查",
};
const reviewStatusLabel = {
  pending: "待审阅",
  applied: "已应用",
  rejected: "已拒绝",
  stale: "来源已变化",
};

export default function AdminPanel({
  offline,
  onVaultChanged,
}: {
  offline: boolean;
  onVaultChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [draft, setDraft] = useState<MemoryState["config"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    if (offline) return;
    const [nextReviews, nextMemory] = await Promise.all([
      json<Review[]>("/api/manager/reviews"),
      json<MemoryState>("/api/memory"),
    ]);
    setReviews(nextReviews);
    setMemory(nextMemory);
    setDraft(nextMemory.config);
    setError("");
  }

  useEffect(() => {
    if (open) void load().catch((reason) => setError(String(reason)));
  }, [open, offline]);

  async function decide(id: string, decision: "apply" | "reject") {
    setBusy(true);
    try {
      await json(`/api/manager/reviews/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      await load();
      if (decision === "apply") onVaultChanged();
    } catch (reason) {
      const message = String(reason);
      await load().catch(() => {});
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!draft) return;
    setBusy(true);
    try {
      await json("/api/memory/config", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      await json("/api/memory/run", { method: "POST" });
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function decideInbox(id: string, decision: "accept" | "reject") {
    setBusy(true);
    try {
      await json(`/api/memory/confirmations/${id}/decision`, {
        method: "POST", body: JSON.stringify({ decision }),
      });
      await load();
      if (decision === "accept") onVaultChanged();
    } catch (reason) {
      await load().catch(() => {});
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const latest = memory?.runs.at(-1);
  return (
    <section className="admin-panel">
      <button
        className="admin-toggle"
        disabled={offline}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "收起管理员" : "管理员与每日整理"}
        {reviews.some((review) => review.status === "pending") ? " · 有待审变更" : ""}
      </button>
      {open && (
        <div className="admin-content">
          <p className="admin-boundary">
            当前未连接真实模型。管理员提议必须先审阅，应用时会再次检查整个知识库版本。
          </p>
          {error && <p className="notice error">{error}</p>}
          <div className="admin-grid">
            <div>
              <h2>变更审阅</h2>
              {!reviews.length && <p>暂无管理员变更提议。</p>}
              {[...reviews].reverse().slice(0, 10).map((review) => (
                <article className="review-card" key={review.id}>
                  <div className="review-heading">
                    <strong>{review.task}</strong>
                    <span>{reviewStatusLabel[review.status]}</span>
                  </div>
                  <code>{review.path}</code>
                  <p>{review.rationale}</p>
                  <details>
                    <summary>查看提议前后全文</summary>
                    <div className="review-diff">
                      <pre>{review.before ?? "（新建文档）"}</pre>
                      <pre>{review.after}</pre>
                    </div>
                  </details>
                  {review.status === "pending" && (
                    <div className="tool-row">
                      <button disabled={busy} onClick={() => void decide(review.id, "reject")}>
                        拒绝
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void decide(review.id, "apply")}
                      >
                        接受并再次验版
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <div>
              <h2>每日记忆整理</h2>
              {draft && (
                <div className="memory-settings">
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setDraft({ ...draft, enabled: event.target.checked })
                      }
                    />
                    启用服务端每日整理
                  </label>
                  <label>
                    服务器本地时间
                    <input
                      type="time"
                      value={draft.localTime}
                      onChange={(event) =>
                        setDraft({ ...draft, localTime: event.target.value })
                      }
                    />
                  </label>
                  {(Object.keys(capabilityLabel) as (keyof typeof capabilityLabel)[]).map(
                    (capability) => (
                      <label key={capability}>
                        <input
                          type="checkbox"
                          checked={draft.capabilities[capability]}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              capabilities: {
                                ...draft.capabilities,
                                [capability]: event.target.checked,
                              },
                            })
                          }
                        />
                        持续授权：{capabilityLabel[capability]}
                      </label>
                    ),
                  )}
                  <div className="tool-row">
                    <button disabled={busy} onClick={() => void saveConfig()}>
                      保存设置
                    </button>
                    <button
                      className="primary"
                      disabled={busy || !draft.enabled}
                      onClick={() => void runNow()}
                    >
                      立即形成计划
                    </button>
                  </div>
                </div>
              )}
              {latest && (
                <article className="memory-run">
                  <strong>
                    最近运行 · {latest.trigger === "manual" ? "手动" : "定时"} · {latest.status === "completed" ? "无待处理项" : "等待管理员"}
                  </strong>
                  <p>{new Date(latest.startedAt).toLocaleString()} · 来源版本 {latest.sourceRevision.slice(0, 10)}</p>
                  <p>{latest.message}</p>
                  <ul>
                    {latest.candidates.slice(0, 20).map((item, index) => (
                      <li key={`${item.capability}-${item.path}-${index}`}>
                        <b>{capabilityLabel[item.capability]}</b> · {item.path}<br />
                        {item.reason}
                      </li>
                    ))}
                  </ul>
                </article>
              )}
              {memory?.confirmations.length ? (
                <section className="memory-confirmations">
                  <h3>待确认 Inbox 分类</h3>
                  {[...memory.confirmations].reverse().slice(0, 10).map((item) => (
                    <article className="review-card" key={item.id}>
                      <div className="review-heading">
                        <strong>{item.sourcePath}</strong>
                        <span>{reviewStatusLabel[item.status]}</span>
                      </div>
                      <p>建议移至 <code>{item.destination}</code></p>
                      <p>标签：{item.tags.join("、")}</p>
                      <p>{item.rationale}</p>
                      {item.status === "pending" && (
                        <div className="tool-row">
                          <button disabled={busy} onClick={() => void decideInbox(item.id, "reject")}>保留在 Inbox</button>
                          <button className="primary" disabled={busy} onClick={() => void decideInbox(item.id, "accept")}>确认分类并验版</button>
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
