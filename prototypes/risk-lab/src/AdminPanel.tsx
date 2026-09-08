import { useEffect, useState, type FormEvent } from "react";

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
  notifications: {
    id: string;
    level: "info" | "error";
    message: string;
    createdAt: string;
    read: boolean;
  }[];
};
type KnowledgeMatch = { path: string; excerpt: string; related: string[] };
type KnowledgeSearch = {
  sourceRevision: string;
  result: { command: "search"; matches: KnowledgeMatch[] };
};
type ManagerAnswer = {
  answer: string;
  citations: { path: string; quote: string }[];
  sourceRevision: string;
  submittedAt: string;
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
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeMatches, setKnowledgeMatches] = useState<KnowledgeMatch[] | null>(null);
  const [knowledgeRevision, setKnowledgeRevision] = useState("");
  const [managerQuestion, setManagerQuestion] = useState("");
  const [managerAnswer, setManagerAnswer] = useState<ManagerAnswer | null>(null);

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
  async function markMemoryNotificationRead(id: string) {
    try {
      await json(`/api/memory/notifications/${id}/read`, { method: "POST", body: JSON.stringify({}) });
      setMemory((current) => current ? {
        ...current,
        notifications: current.notifications.map((item) => item.id === id ? { ...item, read: true } : item),
      } : current);
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function searchKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = knowledgeQuery.trim();
    if (!query) return;
    setBusy(true);
    try {
      const response = await json<KnowledgeSearch>("/api/cil", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          task: "本地资料检索",
          command: "search",
          paths: ["raw/"],
          query,
          authorization: "read",
        }),
      });
      setKnowledgeMatches(response.result.matches);
      setKnowledgeRevision(response.sourceRevision);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function askManager(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = managerQuestion.trim();
    if (!question) return;
    setBusy(true);
    try {
      const answer = await json<ManagerAnswer>("/api/manager/ask", {
        method: "POST", body: JSON.stringify({ question }),
      });
      setManagerAnswer(answer);
      setError("");
    } catch (reason) {
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
            问答仅发送检索命中的已同步非归档原文给已配置模型；回答必须逐字引用原文。管理员提议必须先审阅，应用时会再次检查整个知识库版本。
          </p>
          {error && <p className="notice error">{error}</p>}
          <div className="admin-grid">
            <div>
              <section className="knowledge-search">
                <h2>询问知识管理员</h2>
                <p>点击发送后才会将最多 8 篇相关原文发送给已配置的模型；不会自动写入知识库。</p>
                <form onSubmit={(event) => void askManager(event)}>
                  <input
                    aria-label="询问知识管理员"
                    value={managerQuestion}
                    onChange={(event) => setManagerQuestion(event.target.value)}
                    placeholder="基于已同步资料提问"
                    maxLength={2000}
                  />
                  <button className="primary" disabled={busy || !managerQuestion.trim()}>
                    获取带引用的回答
                  </button>
                </form>
                {managerAnswer && (
                  <article className="review-card manager-answer">
                    <p>{managerAnswer.answer}</p>
                    <p>来源版本 {managerAnswer.sourceRevision.slice(0, 10)}</p>
                    <ul>
                      {managerAnswer.citations.map((citation, index) => (
                        <li key={`${citation.path}-${index}`}><code>{citation.path}</code>：{citation.quote}</li>
                      ))}
                    </ul>
                  </article>
                )}
              </section>
              <section className="knowledge-search">
                <h2>本地资料检索</h2>
                <p>只检索当前已同步的非归档 Markdown；结果是原文证据，不由原型伪造 AI 回答。</p>
                <form onSubmit={(event) => void searchKnowledge(event)}>
                  <input
                    aria-label="检索本地资料"
                    value={knowledgeQuery}
                    onChange={(event) => setKnowledgeQuery(event.target.value)}
                    placeholder="输入关键词、路径或 #标签"
                    maxLength={2000}
                  />
                  <button className="primary" disabled={busy || !knowledgeQuery.trim()}>
                    检索
                  </button>
                </form>
                {knowledgeMatches && (
                  <div className="knowledge-results">
                    <p>
                      {knowledgeMatches.length ? `找到 ${knowledgeMatches.length} 条原文证据` : "未找到匹配的已同步资料"}
                      {knowledgeRevision ? ` · 来源版本 ${knowledgeRevision.slice(0, 10)}` : ""}
                    </p>
                    {knowledgeMatches.map((match) => (
                      <article className="review-card" key={match.path}>
                        <code>{match.path}</code>
                        <p>{match.excerpt}</p>
                        {match.related.length > 0 && (
                          <p>关联原文：{match.related.join("、")}</p>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
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
              {memory?.notifications.some((item) => !item.read) ? (
                <section className="memory-confirmations">
                  <h3>每日整理通知</h3>
                  {memory.notifications.filter((item) => !item.read).slice(0, 10).map((item) => (
                    <button className={`memory-notification ${item.level}`} key={item.id} onClick={() => void markMemoryNotificationRead(item.id)}>
                      {item.level === "error" ? "失败：" : "通知："}{item.message}
                    </button>
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
