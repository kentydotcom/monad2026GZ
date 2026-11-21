import assert from "node:assert/strict";
import test from "node:test";
import {
  LANGS,
  LOG_FIXTURES,
  copy,
  emptyCopy,
  missingKeys,
  preservedIdentical,
  readLang,
  translateLine,
  withLang,
  writeLang,
  type Lang,
} from "./i18n.ts";

test("both languages cover the same strings", () => {
  assert.deepEqual(missingKeys(), []);
  assert.deepEqual(emptyCopy(), []);
  assert.deepEqual(preservedIdentical(), []);
  const enKeys = Object.keys(copy.en).sort();
  const zhKeys = Object.keys(copy.zh).sort();
  assert.deepEqual(enKeys, zhKeys);
  assert.equal(enKeys.length > 80, true);
});

test("simplified Chinese stays on commit, erase, and check", () => {
  const joined = Object.values(copy.zh).join("\n");
  assert.match(joined, /擦除/);
  assert.match(joined, /团队/);
  assert.match(joined, /链上封存/);
  assert.equal(joined.includes("Proof of Deletion"), false);
  assert.equal(joined.includes("全局删除"), false);
  assert.match(joined, /团队存储/);
  assert.equal(joined.includes("证明删除"), false);
  assert.equal(copy.zh.byline, "Kent G Lau, PhD");
  assert.equal(copy.en.byline, "Kent G Lau, PhD");
  assert.match(copy.zh.lede, /WYRVEL|哈希/);
  assert.match(joined, /300/);
  assert.match(joined, /600/);
  assert.match(joined, /10143/);
});

test("language choice persists and does not clear the tour draft", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  };
  assert.equal(readLang(storage), "en");
  writeLang(storage, "zh");
  assert.equal(readLang(storage), "zh");
  writeLang(storage, "en" satisfies Lang);
  assert.equal(readLang(storage), "en");

  const draft = {
    lang: "en" as const,
    payload: "Pin a hash. Keep the data private.",
    recordId: "0x56773adcc87522f874792382427fdd05dae9fff0d3cec3be8465d06423790d60",
    txHash: "0xf9e24bb9e2a1c75823238501ece0b4010901e684e0bd78a94eb1e7fbd1e968b0",
    erasedAt: "2026-11-21T03:58:01.806Z",
  };
  const next = withLang(draft, "zh");
  assert.equal(next.lang, "zh");
  assert.equal(next.payload, draft.payload);
  assert.equal(next.recordId, draft.recordId);
  assert.equal(next.txHash, draft.txHash);
  assert.equal(next.erasedAt, draft.erasedAt);
  assert.equal(draft.lang, "en");
});

test("step logs keep hashes and gain Chinese wording", () => {
  for (const line of LOG_FIXTURES) {
    const zh = translateLine(line, "zh");
    assert.equal(translateLine(line, "en"), line);
    const hexes = line.match(/0x[0-9a-fA-F]+/g) ?? [];
    for (const hex of hexes) assert.equal(zh.includes(hex), true, line);
    if (!line.startsWith("RPC ")) assert.match(zh, /[\u4e00-\u9fff]/, line);
  }
  for (const lang of LANGS) {
    assert.equal(copy[lang].fieldKeccak, "keccak256");
  }
});
