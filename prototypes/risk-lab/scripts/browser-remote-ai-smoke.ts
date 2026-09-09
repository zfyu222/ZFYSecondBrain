process.env.ZFY_REMOTE_EXPECT_AI = "1";
process.env.ZFY_REMOTE_AI_SMOKE = "1";
await import("./browser-remote-smoke");

export {};
