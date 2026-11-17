// #3939 ③ latch replay keys on the ref alone, but the message holding that ref
// may no longer carry the text the clip was cut from: a config edit (CCR armed,
// a message filter enabled) re-renders it, or a host ref restamp re-binds the
// ref to another message (#5534). Replaying the old clip there resurrects bytes
// the new config removed or overwrites tool-call arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import { registerMessageFilter, clearMessageFilters } from "../src/filter/registry.js";
import type { CoreMessage } from "../src/types.js";

const W = 100_000;
const MARK = "[truncated for context space]";
const tail = (): CoreMessage[] =>
  [1, 2, 3, 4].flatMap((i): CoreMessage[] => [
    { id: `u${i}`, role: "user", contentType: "text", text: `question ${i}` },
    { id: `a${i}`, role: "assistant", contentType: "text", text: `answer ${i}` },
  ]);

test("a latched clip is not replayed over a CCR placeholder once CCR is armed", () => {
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "run the build" },
    { id: "c1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call1", text: '{"command":"npm run build"}' },
    { id: "r1", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "call1", text: "build output line ".repeat(3000) },
    ...tail(),
  ];
  const core = createCore(defaultConfig(W));
  const t1 = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(W), tokenCount: 96_000, renderTags: "none" });
  assert.ok(t1.messages.find((m) => m.id === "r1")!.text!.includes(MARK), "turn 1 clips the result");
  assert.ok(t1.state.emergencyTruncateLatch?.length, "clip latched");

  const armed = { ...defaultConfig(W), ccr: { enabled: true, toolName: "acp_retrieve", minToolTokens: 50, excludeTools: [], maxHeadChars: 96 } };
  const t2 = core.processTurn({ messages, state: t1.state, config: armed, contentStore: t1.contentStore, tokenCount: 60_000, renderTags: "none" });
  const r1 = t2.messages.find((m) => m.id === "r1")!.text!;
  assert.ok(r1.includes("[acp-stored"), "armed CCR placeholder reaches the wire");
  assert.ok(!r1.includes(MARK), "stale clip not replayed over the placeholder");
});

test("a latched clip is not replayed onto a tool call its ref was re-bound to (#5534)", () => {
  const args = '{"command":"npm test"}';
  const messages: CoreMessage[] = [
    { id: "big", role: "user", contentType: "text", text: "alpha-beta ".repeat(4000) },
    { id: "c1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call1", text: args },
    { id: "r1", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "call1", text: "ok" },
    ...tail(),
  ];
  const core = createCore(defaultConfig(W));
  const t1 = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(W), tokenCount: 96_000, renderTags: "none" });
  assert.ok(t1.state.emergencyTruncateLatch?.length, "clip latched");

  // Host ledger restamp (src/persist.ts) swaps the two bindings.
  const { byRaw, byRef } = t1.state.messageRefs;
  const [rb, rc] = [byRaw.big!, byRaw.c1!];
  const state = { ...t1.state, messageRefs: { byRaw: { ...byRaw, big: rc, c1: rb }, byRef: { ...byRef, [rb]: "c1", [rc]: "big" } } };
  const t2 = core.processTurn({ messages, state, config: defaultConfig(W), tokenCount: 60_000, renderTags: "none" });
  assert.equal(t2.messages.find((m) => m.id === "c1")!.text, args, "tool-call arguments stay JSON");
});

test("a latched clip is not replayed over text a newly enabled filter redacted", () => {
  clearMessageFilters();
  registerMessageFilter({
    name: "redact",
    version: "1",
    description: "test filter",
    filter: (ctx) =>
      ctx.text.includes("SECRETTOKEN")
        ? { action: "modify", text: ctx.text.replace(/SECRETTOKEN/g, "[redacted]") }
        : { action: "keep" },
  });
  try {
    const messages: CoreMessage[] = [
      { id: "big", role: "user", contentType: "text", text: "SECRETTOKEN " + "alpha-beta ".repeat(4000) },
      ...tail(),
    ];
    const core = createCore(defaultConfig(W));
    const t1 = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(W), tokenCount: 96_000, renderTags: "none" });
    const clip = t1.messages.find((m) => m.id === "big")!.text!;
    assert.ok(clip.includes(MARK) && clip.includes("SECRETTOKEN"), "turn 1 clip keeps the head");

    const filtered = { ...defaultConfig(W), messageFilters: { enabled: true, filters: { redact: { enabled: true } } } };
    const t2 = core.processTurn({ messages, state: t1.state, config: filtered, tokenCount: 60_000, renderTags: "none" });
    const big = t2.messages.find((m) => m.id === "big")!.text!;
    assert.ok(big.startsWith("[redacted]"), "filter applied");
    assert.ok(!big.includes("SECRETTOKEN"), "stale clip not replayed over the redaction");
  } finally {
    clearMessageFilters();
  }
});
