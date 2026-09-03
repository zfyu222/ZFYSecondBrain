// Manual UI-test fixture generator; never use with a real knowledge library.
// pnpm --filter @zfy/risk-lab exec tsx tests/browser-conflict-fixture.ts base|remote TAG
import { serializeOpml, serializeRelations, topic } from "../src/core/formats";
import type { Snapshot } from "../src/core/contracts";

const [stage, tag] = process.argv.slice(2);
if (
  !["base", "remote"].includes(stage) ||
  !tag ||
  !/^[a-zA-Z0-9-]{1,40}$/.test(tag)
)
  throw new Error("Expected base|remote and a unique test tag");
const origin = "http://127.0.0.1:4173";
const health = await fetch(origin + "/api/health").then((r) => r.json());
if (
  !health.prototype ||
  health.ai !== false ||
  health.storage !== ".prototype-data/server"
)
  throw new Error("Not the isolated test service");
const stem = `raw/Inbox/冲突验收-${tag}`;
const body =
  "本机独立段：原始\n\n分隔一\n\n共同修改段：原始\n\n分隔二\n\n服务端独立段：原始\n";
const relation = (type: string) =>
  serializeRelations(stem + ".opml", [
    { from: "/Root[1]/A[1]", to: "/Root[1]/B[1]", type, status: "confirmed" },
  ]);
const base = {
  [stem + ".md"]: body,
  [stem + ".opml"]: serializeOpml({
    title: "冲突验收",
    root: { ...topic("Root"), children: [topic("A"), topic("B")] },
  }),
  [stem + ".relations.yaml"]: relation("相关"),
};
const response = await fetch(origin + "/api/snapshot");
if (!response.ok) throw new Error("Cannot read snapshot");
const snapshot = (await response.json()) as Snapshot;
for (const [path, text] of Object.entries(base)) {
  if (stage === "base" ? path in snapshot.files : snapshot.files[path] !== text)
    throw new Error(
      "Fixture already exists or changed; choose a fresh tag, do not overwrite: " +
        path,
    );
}
const changes =
  stage === "base"
    ? base
    : {
        ...base,
        [stem + ".md"]: body
          .replace("共同修改段：原始", "共同修改段：服务端版本")
          .replace("服务端独立段：原始", "服务端独立段：保留"),
        [stem + ".relations.yaml"]: relation("支持"),
      };
const committed = await fetch(origin + "/api/commit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: crypto.randomUUID(),
    expectedRevision: snapshot.revision,
    files: { ...snapshot.files, ...changes },
  }),
});
if (!committed.ok) throw new Error(await committed.text());
console.log(`${stage}: ${stem}`);
