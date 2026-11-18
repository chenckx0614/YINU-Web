import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compareRecord, makeChange, readConfig, SupabaseRecords, validRecord } from "./dist/sync.js";

test("the project field accepts the Supabase Data API URL copied from the dashboard", () => {
  const project = "https://example.supabase.co";
  const key = "sb_publishable_public_only";
  for (const suffix of ["", "/", "/rest/v1", "/rest/v1/"]) {
    assert.deepEqual(readConfig(` ${project}${suffix} \n`, key), { project, key });
  }
  assert.throws(() => readConfig(`${project}/rest/v1/records`, key), /Data API/);
  assert.throws(() => readConfig(`${project}/rest/v1/?select=*`, key), /Data API/);
});

test("the default fetch runs with the browser global as its receiver", async context => {
  const config = readConfig("https://example.supabase.co", "sb_publishable_public_only");
  context.mock.method(globalThis, "fetch", function () {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return new Response(null, { status: 204 });
  });
  const api = new SupabaseRecords(config);
  assert.equal(await api.request("/auth/v1/health"), null);
});

test("download uses the account's authorized Storage path and returns original bytes", async () => {
  const config = readConfig("https://example.supabase.co", "sb_publishable_public_only");
  const session = { id: "my-account", access: "my-access-token" };
  const id = "备份附件/1";
  const key = createHash("sha256").update(id, "utf8").digest("hex");
  const bytes = new Uint8Array([0, 128, 255]);
  const api = new SupabaseRecords(config, (url, options) => {
    assert.equal(url, `${config.project}/storage/v1/object/authenticated/yinu-attachments/${session.id}/${key}`);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer my-access-token");
    return new Response(bytes);
  });
  const result = await api.downloadAttachment(session, id);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  const oldRecord = new SupabaseRecords(config, () => Response.json({ statusCode: "404" }, { status: 400 }));
  await assert.rejects(oldRecord.downloadAttachment(session, id), /上传附件到云端/);
});

test("the browser uses the existing account-bound Android sync API", async () => {
  const config = readConfig("https://example.supabase.co/rest/v1/", "sb_publishable_public_only");
  assert.throws(() => readConfig(config.project, "sb_secret_supersecret"));
  const note = await makeChange("same-id", 100, { created: 50, content: "网页写入", attachments: [] });
  const deleted = await makeChange("same-id", 101, { ...note.payload, deleted: true });
  assert.equal(validRecord(note), true);
  assert.equal(compareRecord(deleted, note), 1);
  assert.deepEqual(deleted.payload, { created: 50, deleted: true });

  const calls = [];
  const api = new SupabaseRecords(config, async (url, options) => {
    calls.push([new URL(url), options]);
    assert.equal(options.headers.apikey, config.key);
    assert.equal(options.redirect, "error");
    if (url.includes("/auth/v1/token")) return Response.json({
      user: { id: "user", email: "test@example.org" }, access_token: "user-jwt", refresh_token: "refresh", expires_in: 3600,
    });
    assert.equal(options.headers.Authorization, "Bearer user-jwt");
    if (url.includes("/rpc/")) return new Response(null, { status: 204 });
    return Response.json([{ ...deleted, revision: 6 }]);
  });
  const session = await api.login("test@example.org", "test-password");
  assert.equal(calls[0][0].pathname, "/auth/v1/token");
  await api.push(session.access, [deleted]);
  assert.deepEqual(JSON.parse(calls[1][1].body), { changes: [deleted] });
  assert.equal(calls[1][0].pathname, "/rest/v1/rpc/yinu_sync_push");
  const page = await api.pull(session.access, 5);
  assert.equal(calls[2][0].searchParams.get("revision"), "gt.5");
  assert.equal(page[0].payload.deleted, true);
});
