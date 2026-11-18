import assert from "node:assert/strict";
import { test } from "node:test";
import { exportBackup, inspectBackup } from "./dist/backup.js";
import { recordKind } from "./dist/tools.js";

test("a backup contains Android-compatible records and unmodified attachment bytes", async () => {
  const original = new Blob([Uint8Array.from([0, 47, 255])]);
  const file = { id: "a", name: "测试.png", mime: "image/png", size: original.size, position: 0 };
  const rows = [{
    record_id: "r", updated_at_ms: 20, payload: {
      type: "IMAGE", content: "内容", created: 10, favorite: true, group: "灵感",
      attachments: [file, { ...file, id: "b", name: "遗失.png", position: 1 }],
      links: [{ id: "other", summary: "相关记录", position: 0 }],
    },
  }];
  const result = await exportBackup(rows, { pins: ["r"], reminders: { r: 123 } }, async item => {
    if (item.id === "a") return original;
    throw new Error("Not available");
  });
  assert.equal(result.missing, 1);
  const { records, read } = await inspectBackup(result.blob);
  assert.deepEqual(records[0].files.map(item => item.stored), [true, false]);
  assert.equal(records[0].favoriteGroup, "灵感");
  assert.equal(records[0].pinned, true);
  assert.equal(records[0].reminderAt, 123);
  assert.deepEqual(new Uint8Array(await (await read("attachments/0/0")).arrayBuffer()), new Uint8Array([0, 47, 255]));
  await assert.rejects(inspectBackup(result.blob.slice(0, result.blob.size - 1)));
});

test("attachment categories recognize both Android MIME values and file extensions", () => {
  assert.equal(recordKind({ attachments: [{ name: "sample.PNG", mime: "application/octet-stream" }] }, "image"), true);
  assert.equal(recordKind({ attachments: [{ name: "sample.webm", mime: "audio/webm" }] }, "audio"), true);
  assert.equal(recordKind({ type: "LINK", content: "https://example.com" }, "link"), true);
  assert.equal(recordKind({ type: "TEXT", content: "text" }, "video"), false);
});
