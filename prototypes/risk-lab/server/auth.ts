import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
type Stored = { version: 1; salt: string; verifier: string };

/** Optional single-account guard. It is deliberately disabled unless an
 * initialization password is supplied, preserving the isolated local prototype. */
export class SingleAccountAuth {
  private stored?: Stored;
  private readonly sessions = new Set<string>();
  readonly enabled: boolean;
  constructor(private readonly root: string, private readonly initializationPassword = process.env.ZFY_AUTH_PASSWORD) {
    this.enabled = Boolean(initializationPassword);
  }
  private get file() { return path.join(this.root, "state", "auth.json"); }
  private async hash(password: string, salt: string) {
    return Buffer.from(await scrypt(password, salt, 32) as Uint8Array).toString("base64");
  }
  private async load() {
    if (!this.enabled || this.stored) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Stored;
      if (parsed.version !== 1 || typeof parsed.salt !== "string" || typeof parsed.verifier !== "string")
        throw new Error("认证配置格式无效");
      this.stored = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const salt = randomBytes(16).toString("base64");
      this.stored = { version: 1, salt, verifier: await this.hash(this.initializationPassword!, salt) };
      await fs.writeFile(this.file, JSON.stringify(this.stored, null, 2), { mode: 0o600 });
    }
  }
  private token(header?: string) {
    return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith("zfy_session="))?.slice("zfy_session=".length);
  }
  async authorized(cookie?: string) {
    if (!this.enabled) return true;
    await this.load();
    const token = this.token(cookie);
    return Boolean(token && this.sessions.has(token));
  }
  async login(password: unknown) {
    if (!this.enabled) throw new Error("本地原型未启用账号认证");
    if (typeof password !== "string" || password.length > 1024) return undefined;
    await this.load();
    const expected = Buffer.from(this.stored!.verifier, "base64");
    const actual = Buffer.from(await this.hash(password, this.stored!.salt), "base64");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    const token = randomBytes(32).toString("base64url");
    this.sessions.add(token);
    return token;
  }
  logout(cookie?: string) {
    const token = this.token(cookie);
    if (token) this.sessions.delete(token);
  }
  fingerprint() { return createHash("sha256").update(this.root).digest("hex").slice(0, 12); }
}
