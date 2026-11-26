import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFromEnv } from "../src/sync/index";
import { tempDir, removeDir } from "./helpers/fixture";

const MANAGED = [
  "ICM_SYNC_URL",
  "ICM_SYNC_TOKEN",
  "ICM_SYNC_DEVICE",
  "ICM_DB",
  "ICM_SYNC_STATE",
  "ICM_SYNC_BATCH",
  "ICM_SYNC_ENV_FILE",
];

const saved: Record<string, string | undefined> = {};
for (const name of MANAGED) {
  saved[name] = process.env[name];
}

afterEach(() => {
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("configFromEnv", () => {
  test("reads the values from the env file when the shell has none", () => {
    const dir = tempDir("icm-sync-config-");
    const envFile = join(dir, "env");
    writeFileSync(
      envFile,
      [
        "# written by the Nix module",
        "",
        "ICM_SYNC_URL=https://icm.example.test",
        "ICM_SYNC_TOKEN=token-from-file",
        "ICM_SYNC_DEVICE=laptop",
      ].join("\n"),
    );
    process.env.ICM_SYNC_ENV_FILE = envFile;
    delete process.env.ICM_SYNC_URL;
    delete process.env.ICM_SYNC_TOKEN;
    delete process.env.ICM_SYNC_DEVICE;

    const config = configFromEnv();

    expect(config.url).toBe("https://icm.example.test");
    expect(config.token).toBe("token-from-file");
    expect(config.deviceId).toBe("laptop");
    removeDir(dir);
  });

  test("the process environment wins over the env file", () => {
    const dir = tempDir("icm-sync-config-");
    const envFile = join(dir, "env");
    writeFileSync(
      envFile,
      ["ICM_SYNC_URL=https://from-file.test", "ICM_SYNC_DEVICE=file-device"].join("\n"),
    );
    process.env.ICM_SYNC_ENV_FILE = envFile;
    process.env.ICM_SYNC_URL = "https://from-shell.test";
    delete process.env.ICM_SYNC_DEVICE;

    const config = configFromEnv();

    expect(config.url).toBe("https://from-shell.test");
    expect(config.deviceId).toBe("file-device");
    removeDir(dir);
  });

  test("reports a missing variable when neither source has it", () => {
    process.env.ICM_SYNC_ENV_FILE = join(tmpdir(), "icm-sync-does-not-exist.env");
    delete process.env.ICM_SYNC_URL;
    delete process.env.ICM_SYNC_DEVICE;

    expect(() => configFromEnv()).toThrow("missing required environment variable: ICM_SYNC_URL");
  });
});
