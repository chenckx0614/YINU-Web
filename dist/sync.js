const columns = "revision,record_id,updated_at_ms,digest,payload";
const sessionKey = "yinu.web.session";
const encoder = new TextEncoder();

export class ApiError extends Error {
  constructor(status, code) {
    const message = code === "email_not_confirmed" ? "请先在邮箱完成验证，再登录。"
      : status === 404 ? "找不到同步接口，请在 Supabase 项目运行一隅的初始化脚本。"
      : status === 400 || status === 401 || status === 403 ? "项目公钥、登录信息或访问权限有误。"
      : status === 429 ? "请求太频繁，请稍后重试。"
      : `同步服务暂时不可用（HTTP ${status}）。`;
    super(message);
    this.status = status;
  }
}

export function readConfig(project, key) {
  const projectError = "请填入 Supabase 项目的 HTTPS 地址或完整的 Data API 地址。";
  let url;
  try {
    url = new URL(project.trim());
  } catch {
    throw new Error(projectError);
  }
  const validPath = ["/", "/rest/v1", "/rest/v1/"].includes(url.pathname);
  if (url.protocol !== "https:" || !validPath || url.username || url.password || url.hash || url.search) {
    throw new Error(projectError);
  }
  key = key.trim();
  let isPublic = /^sb_publishable_[A-Za-z0-9_-]{10,300}$/.test(key);
  if (!isPublic && key.length <= 2048 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) {
    try {
      const claims = atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"));
      isPublic = JSON.parse(claims).role === "anon";
    } catch { /* Invalid key. */ }
  }
  if (!isPublic) throw new Error("请填入项目的 Publishable 或 anon 公钥。");
  return { project: url.origin, key };
}

export async function attachmentPath(accountId, attachmentId) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(attachmentId)));
  const key = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  return `/storage/v1/object/authenticated/yinu-attachments/${encodeURIComponent(accountId)}/${key}`;
}

export class SupabaseRecords {
  constructor(config, fetcher = globalThis.fetch.bind(globalThis)) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async request(path, { access, body, binary = false } = {}) {
    const headers = { apikey: this.config.key, Accept: "application/json" };
    if (access) headers.Authorization = `Bearer ${access}`;
    if (body != null) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetcher(this.config.project + path, {
        method: body == null ? "GET" : "POST",
        headers, body: body == null ? undefined : JSON.stringify(body),
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error("暂时连不上同步服务，请检查网络和项目地址。");
    }
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      if (binary && (response.status === 404 || String(result?.statusCode) === "404")) {
        throw new Error("云端找不到这个原文件。请在保存原件的手机上打开「跨设备同步」，选择「上传附件到云端」。");
      }
      throw new ApiError(response.status, result?.error_code);
    }
    if (binary) return response.blob();
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("同步服务返回了无法识别的内容，请检查项目地址。");
    }
  }

  async login(email, password) {
    return validateSession(await this.request("/auth/v1/token?grant_type=password", { body: { email, password } }));
  }

  async refresh(session) {
    const fresh = validateSession(await this.request("/auth/v1/token?grant_type=refresh_token",
      { body: { refresh_token: session.refresh } }));
    if (fresh.id !== session.id) throw new Error("登录账号已变化，请重新登录。");
    return fresh;
  }

  async pull(access, after) {
    const query = new URLSearchParams({ select: columns, revision: `gt.${after}`, order: "revision.asc", limit: "40" });
    const rows = await this.request(`/rest/v1/yinu_sync_records?${query}`, { access });
    if (!Array.isArray(rows) || rows.some(row => !validRecord(row) || !Number.isSafeInteger(row.revision) || row.revision <= after)) {
      throw new Error("云端返回的记录格式不完整。");
    }
    return rows;
  }

  async downloadAttachment(session, id) {
    return this.request(await attachmentPath(session.id, id), { access: session.access, binary: true });
  }

  push(access, changes) {
    const payload = changes.map(({ record_id, updated_at_ms, digest, payload }) => ({ record_id, updated_at_ms, digest, payload }));
    return this.request("/rest/v1/rpc/yinu_sync_push", { access, body: { changes: payload } });
  }
}

function validateSession(data) {
  if (!data?.user?.id || !data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) {
    throw new Error("登录服务未返回可用会话。");
  }
  return {
    id: data.user.id, email: data.user.email ?? "", access: data.access_token,
    refresh: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export function saveSession(config, session) {
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify({ config, session }));
    else sessionStorage.removeItem(sessionKey);
  } catch { /* The current session remains available in memory. */ }
}

export function loadSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey));
    if (!value?.session?.id || !value.session.access || !value.session.refresh) return null;
    return { config: readConfig(value.config.project, value.config.key), session: value.session };
  } catch {
    return null;
  }
}

export function compareRecord(a, b) {
  if (a.updated_at_ms !== b.updated_at_ms) return a.updated_at_ms - b.updated_at_ms;
  return a.digest === b.digest ? 0 : a.digest < b.digest ? -1 : 1;
}

export function validRecord(record) {
  if (!record || typeof record.record_id !== "string" || !record.record_id ||
      !Number.isSafeInteger(record.updated_at_ms) || !/^[a-f0-9]{64}$/.test(record.digest)) return false;
  const data = record.payload;
  return Boolean(data && typeof data.deleted === "boolean" && Number.isFinite(new Date(data.created).getTime()) &&
    typeof data.created === "number" && (data.content == null || typeof data.content === "string") &&
    (data.attachments == null || Array.isArray(data.attachments) && data.attachments.every(file => file && typeof file.name === "string")) &&
    (data.links == null || Array.isArray(data.links) && data.links.every(link => link && typeof link.id === "string")));
}

export async function makeChange(recordId, updatedAt, current) {
  const payload = { created: current.created, deleted: Boolean(current.deleted) };
  if (!payload.deleted) {
    payload.type = current.type ?? "TEXT";
    if (current.content != null) payload.content = current.content;
    payload.favorite = Boolean(current.favorite);
    if (current.group != null) payload.group = current.group;
    if (current.quote_id != null) payload.quote_id = current.quote_id;
    if (current.quote_text != null) payload.quote_text = current.quote_text;
    payload.attachments = [...(current.attachments ?? [])].sort((a, b) => a.position - b.position).map(
      ({ id, name, mime, size, position }) => ({ id, name, mime, size, position }),
    );
    payload.links = [...(current.links ?? [])].sort((a, b) => a.position - b.position).map(
      ({ id, summary, position }) => ({ id, summary, position }),
    );
  }
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(payload)));
  const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  return { record_id: recordId, updated_at_ms: updatedAt, digest, payload };
}

let databasePromise;
function localDb() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const open = indexedDB.open("yinu-web", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("outbox", { keyPath: ["scope", "record_id"] }).createIndex("scope", "scope");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }).catch(error => { databasePromise = null; throw error; });
  }
  return databasePromise;
}

export async function readOutbox(scope) {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const query = db.transaction("outbox").objectStore("outbox").index("scope").getAll(scope);
    query.onsuccess = () => resolve(query.result.filter(validRecord));
    query.onerror = () => reject(query.error);
  });
}

async function writeOutbox(change) {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("outbox", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    change(transaction.objectStore("outbox"));
  });
}

export function queueChange(scope, record) {
  return writeOutbox(store => {
    const request = store.get([scope, record.record_id]);
    request.onsuccess = () => {
      if (!request.result || compareRecord(request.result, record) < 0) store.put({ ...record, scope });
    };
  });
}

export function acknowledge(scope, uploaded) {
  return writeOutbox(store => {
    for (const record of uploaded) {
      const key = [scope, record.record_id];
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result && compareRecord(request.result, record) === 0) store.delete(key);
      };
    }
  });
}
