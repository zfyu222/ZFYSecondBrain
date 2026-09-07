export const cilEndpoint = "http://127.0.0.1:4173/api/cil";
export const cilInputLimit = 3_000_000;

export async function callCil(
  inputText: string,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (Buffer.byteLength(inputText, "utf8") > cilInputLimit)
    throw new Error("CIL JSON 输入超过 3 MB 限制");
  if (!inputText.trim()) throw new Error("CIL 需要从标准输入接收一个 JSON 请求");
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch {
    throw new Error("CIL 输入不是有效 JSON");
  }
  const response = await request(cilEndpoint, {
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
  return body;
}
