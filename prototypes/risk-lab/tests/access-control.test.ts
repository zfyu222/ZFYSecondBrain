import { describe, expect, it } from "vitest";
import { accessControlFromEnvironment } from "../server/access-control";

describe("remote access configuration", () => {
  it("keeps the default server loopback-only", () => {
    expect(accessControlFromEnvironment({})).toEqual({
      hosts: ["127.0.0.1:4173", "localhost:4173"],
      origins: ["http://127.0.0.1:4173", "http://localhost:4173"],
      listenHost: "127.0.0.1",
    });
  });

  it("allows a remote listener only for an explicit HTTPS origin", () => {
    expect(
      accessControlFromEnvironment({ ZFY_PUBLIC_ORIGIN: "https://notes.example.test" }),
    ).toEqual({
      hosts: ["notes.example.test"],
      origins: ["https://notes.example.test"],
      listenHost: "0.0.0.0",
    });
  });

  it("rejects a path, a credential or an insecure public endpoint", () => {
    for (const origin of [
      "http://notes.example.test",
      "https://notes.example.test/app",
      "https://user:secret@notes.example.test",
      "not a url",
    ])
      expect(() => accessControlFromEnvironment({ ZFY_PUBLIC_ORIGIN: origin })).toThrow();
  });
});
