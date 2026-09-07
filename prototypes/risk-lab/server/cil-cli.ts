import { callCil, cilInputLimit } from "./cil-client";

const chunks: Buffer[] = [];
let bytes = 0;

try {
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > cilInputLimit) throw new Error("CIL JSON 输入超过 3 MB 限制");
    chunks.push(buffer);
  }
  const body = await callCil(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify(body) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) +
      "\n",
  );
  process.exitCode = 1;
}
