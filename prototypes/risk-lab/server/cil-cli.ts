export {};

const endpoint = "http://127.0.0.1:4173/api/cil";
const chunks: Buffer[] = [];
let bytes = 0;

try {
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 3_000_000) throw new Error("CIL JSON 输入超过 3 MB 限制");
    chunks.push(buffer);
  }
  if (!bytes) throw new Error("CIL 需要从标准输入接收一个 JSON 请求");
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`知识库服务返回非 JSON 响应（${response.status}）`);
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `知识库服务拒绝请求（${response.status}）`;
    throw new Error(message);
  }
  process.stdout.write(JSON.stringify(body) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) +
      "\n",
  );
  process.exitCode = 1;
}
