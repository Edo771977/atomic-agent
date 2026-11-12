import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDotenvFromStateDir } from "../config/load-dotenv.js";
import { readDotenvValue, stripDotenvQuotes } from "./dotenv-read.js";

describe("readDotenvValue", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dotenv-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing file or key", () => {
    expect(readDotenvValue(join(dir, "nope"), "K")).toBeUndefined();
    writeFileSync(join(dir, ".env"), "OTHER=x\n");
    expect(readDotenvValue(join(dir, ".env"), "K")).toBeUndefined();
  });

  it("reads a key, strips quotes, skips comments", () => {
    writeFileSync(
      join(dir, ".env"),
      ["# comment", "", "A=1", 'B="two words"', "C='three'", "BROKEN"].join(
        "\n",
      ),
    );
    const path = join(dir, ".env");
    expect(readDotenvValue(path, "A")).toBe("1");
    expect(readDotenvValue(path, "B")).toBe("two words");
    expect(readDotenvValue(path, "C")).toBe("three");
  });
});

describe("readDotenvValue agrees with loadDotenvFromStateDir", () => {
  const KEYS = Array.from({ length: 14 }, (_, i) => `ATOMIC_IMPORT_AGREE_${i}`);
  let dir: string;
  let saved: Record<string, string | undefined>;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dotenv-agree-"));
    saved = {};
    for (const k of [...KEYS, "ATOMIC_IMPORT_AGREE_DUP", "lower_key"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads every value exactly as the loader applies it", () => {
    const rawValues = [
      "plain",
      String.raw`"\\server\share"`,
      String.raw`'ab\\cd'`,
      String.raw`"a\"b"`,
      `"it's "x""`,
      `'mismatched"`,
      `  "  padded  "  `,
      "",
      `""`,
      "a=b=c",
      "x # not a comment",
      "`tick`",
      String.raw`C:\dir`,
      `'`,
    ];
    const lines = rawValues.map((v, i) => `${KEYS[i]}=${v}`);
    lines.push(
      "ATOMIC_IMPORT_AGREE_DUP=",
      "ATOMIC_IMPORT_AGREE_DUP=second",
      "ATOMIC_IMPORT_AGREE_DUP=third",
      "lower_key=ignored",
      "NO_EQUALS_LINE",
    );
    writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`);

    loadDotenvFromStateDir(dir);

    const path = join(dir, ".env");
    for (const k of [...KEYS, "ATOMIC_IMPORT_AGREE_DUP", "lower_key"]) {
      expect(readDotenvValue(path, k), k).toBe(process.env[k]);
    }
  });
});

describe("stripDotenvQuotes", () => {
  it("strips only one matching pair", () => {
    expect(stripDotenvQuotes('"x"')).toBe("x");
    expect(stripDotenvQuotes("'x'")).toBe("x");
    expect(stripDotenvQuotes("\"x'")).toBe("\"x'");
    expect(stripDotenvQuotes('""x""')).toBe('"x"');
  });
});
