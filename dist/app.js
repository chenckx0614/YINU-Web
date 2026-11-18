import {
  ApiError, SupabaseRecords, acknowledge, compareRecord, defaultProject, loadSession, makeChange,
  queueChange, readConfig, readOutbox, saveSession,
} from "./sync.js?v=5";

const byId = id => document.getElementById(id);
const fields = {
  records: byId("records"), search: byId("search"), scroll: byId("scroll"),
  connection: byId("connection"), login: byId("login"), actions: byId("actions"),
  customProject: byId("custom-project"),
  attachment: byId("attachment-preview"), preview: byId("attachment-content"),
  composer: byId("composer"), draft: byId("draft"), send: byId("send"), status: byId("status"),
};
const titles = { all: "时间线", favorites: "收藏", files: "附件" };
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const yearFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const dateKey = timestamp => new Date(timestamp).toDateString();
const state = {
  connection: null, cloud: new Map(), pending: new Map(), demo: examples(),
  cursor: 0, filter: "all", syncing: false, lastSync: 0, busy: false, selected: null,
};
let followup;
let locatedRow;
let activeAttachment;

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function sampleDate(days, hours, minutes) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

function examples() {
  return new Map([
    { id: "note-intro", created: sampleDate(1, 19, 28), content: "想留住的东西，随手记在这里。" },
    { id: "note-file", created: sampleDate(1, 20, 12), attachments: [
      { id: "sample-file", name: "周末出行清单.pdf", mime: "application/pdf", size: 192512, position: 0 },
    ] },
    { id: "note-place", created: sampleDate(0, 9, 16), content: "路过一家小书店，在梧桐路 18 号。下次有空进去逛逛。", favorite: true },
    { id: "note-check", created: sampleDate(0, 14, 35), content: "周五前确认车票，顺手把预订信息一起存下来。" },
  ].map(({ id, ...payload }) => [id, { record_id: id, updated_at_ms: payload.created, digest: "", payload }]));
}

function currentRows() {
  if (!state.connection) return state.demo;
  const records = new Map(state.cloud);
  for (const [id, queued] of state.pending) {
    const synced = records.get(id);
    if (!synced || compareRecord(synced, queued) < 0) records.set(id, queued);
  }
  return records;
}

function dateLabel(timestamp) {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const value = new Date(timestamp);
  if (value.toDateString() === now.toDateString()) return "今天";
  if (value.toDateString() === yesterday.toDateString()) return "昨天";
  return value.getFullYear() === now.getFullYear() ? dateFormat.format(value) : yearFormat.format(value);
}

function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "附件";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const rasterTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);

function clearAttachment() {
  for (const url of activeAttachment?.urls ?? []) URL.revokeObjectURL(url);
  activeAttachment = null;
  fields.preview.replaceChildren();
}

async function openAttachment(file) {
  const connection = state.connection;
  if (!connection) return;
  clearAttachment();
  const preview = { urls: [] };
  activeAttachment = preview;
  byId("attachment-title").textContent = file.name;
  fields.preview.append(element("p", null, "正在读取原文件…"));
  fields.attachment.showModal();
  const isCurrent = () => activeAttachment === preview && fields.attachment.open && state.connection === connection;
  function fileLink(blob, label, openInTab = false) {
    const url = URL.createObjectURL(blob);
    preview.urls.push(url);
    const link = element("a", "attachment-link", label);
    link.href = url;
    if (openInTab) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.download = file.name;
    }
    return link;
  }
  try {
    await refresh(connection);
    if (!isCurrent()) return;
    const bytes = await connection.api.downloadAttachment(connection.session, file.id);
    if (!isCurrent()) return;
    const content = document.createDocumentFragment();
    if (rasterTypes.has(file.mime)) {
      const url = URL.createObjectURL(bytes.slice(0, bytes.size, file.mime));
      preview.urls.push(url);
      const image = element("img", "attachment-image");
      image.alt = file.name;
      image.src = url;
      image.addEventListener("error", () => image.replaceWith(element("p", null, "图片预览失败，可以下载原文件。")));
      content.append(image);
    } else if (/\.pdf$/i.test(file.name) || file.mime === "application/pdf") {
      if (await bytes.slice(0, 5).text() === "%PDF-" && isCurrent()) {
        content.append(fileLink(bytes.slice(0, bytes.size, "application/pdf"), "在新标签页预览 PDF", true));
      }
    } else if (/\.docx$/i.test(file.name) || file.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      try {
        const { readDocxText } = await import("./docx.js");
        const text = await readDocxText(bytes);
        if (text.trim()) content.append(element("p", "attachment-word", text));
        else content.append(element("p", null, "此 Word 文档没有可预览的正文。"));
      } catch {
        content.append(element("p", null, "无法预览此 Word 文档，可以下载原文件。"));
      }
    }
    if (!isCurrent()) return;
    content.append(fileLink(bytes.slice(0, bytes.size, "application/octet-stream"), "下载原文件"));
    fields.preview.replaceChildren(content);
  } catch (error) {
    if (isCurrent()) fields.preview.replaceChildren(element("p", "feedback", error.message || "读取附件失败，请稍后重试。"));
  }
}

function textLink(text) {
  if (typeof text !== "string" || !/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

function addReferences(bubble, record, rows) {
  const refs = new Map();
  if (record.quote_id) refs.set(record.quote_id, record.quote_text || "引用的记录");
  for (const ref of record.links ?? []) {
    if (!refs.has(ref.id)) refs.set(ref.id, ref.summary || "关联的记录");
  }
  for (const [id, summary] of refs) {
    const button = element("button", "reference", summary);
    button.type = "button";
    button.disabled = !rows.has(id) || rows.get(id).payload.deleted;
    if (!button.disabled) button.addEventListener("click", () => locate(id));
    bubble.append(button);
  }
}

function renderRow(row, rows) {
  const data = row.payload;
  const article = element("article", "row");
  article.id = `record-${row.record_id}`;
  const message = element("div", "message");
  const bubble = element("div", data.content ? "bubble" : "bubble file-only");
  if (data.content) {
    const body = element("p", "body");
    const url = textLink(data.content);
    if (url) {
      const link = element("a", null, data.content);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      body.append(link);
    } else body.textContent = data.content;
    bubble.append(body);
  }
  for (const file of data.attachments ?? []) {
    const entry = element(state.connection ? "button" : "div", "attachment");
    if (state.connection) {
      entry.type = "button";
      entry.addEventListener("click", () => openAttachment(file));
    }
    const graphic = element("span", "file-icon");
    graphic.append(icon("file"));
    const labels = element("span");
    labels.append(element("span", "file-name", file.name), element("span", "file-size", fileSize(file.size)));
    entry.append(graphic, labels);
    bubble.append(entry);
  }
  addReferences(bubble, data, rows);
  const meta = element("div", "record-meta");
  if (state.pending.has(row.record_id)) meta.append(element("span", "pending-mark", "待同步"));
  meta.append(element("time", null, timeFormat.format(row.payload.created)));
  const star = recordAction("star", data.favorite ? "取消收藏" : "收藏", () =>
    changeRecord(row.record_id, previous => ({ ...previous, favorite: !previous.favorite, group: null })),
  );
  star.setAttribute("aria-pressed", String(Boolean(data.favorite)));
  meta.append(star, recordAction("more", "记录操作", () => showActions(row.record_id)));
  message.append(bubble, meta);
  const avatar = element("span", "row-avatar", "隅");
  avatar.setAttribute("aria-hidden", "true");
  article.append(message, avatar);
  return article;
}

function recordAction(symbol, label, run) {
  const button = element("button", "meta-action");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(symbol));
  button.addEventListener("click", run);
  return button;
}

function renderRecords({ follow = false } = {}) {
  const rows = currentRows();
  const query = fields.search.value.trim().toLowerCase();
  const visible = [...rows.values()].filter(row => {
    const data = row.payload;
    if (data.deleted || (state.filter === "favorites" && !data.favorite) ||
        (state.filter === "files" && !data.attachments?.length)) return false;
    return !query || data.content?.toLowerCase().includes(query) ||
      data.attachments?.some(file => file.name?.toLowerCase().includes(query));
  }).sort((a, b) => a.payload.created - b.payload.created || a.record_id.localeCompare(b.record_id));

  const fragment = document.createDocumentFragment();
  if (visible.length === 0) {
    const empty = element("div", "empty");
    const message = state.syncing && !query ? "正在读取记录…" : query ? "没有匹配的记录"
      : { all: "还没有记录", favorites: "还没有收藏", files: "还没有附件" }[state.filter];
    empty.append(icon(state.filter === "all" ? "record" : state.filter === "files" ? "folder" : "star"), element("p", null, message));
    fragment.append(empty);
  }
  let previousDay;
  for (const row of visible) {
    const day = dateKey(row.payload.created);
    if (day !== previousDay) fragment.append(element("div", "day", dateLabel(row.payload.created)));
    previousDay = day;
    fragment.append(renderRow(row, rows));
  }
  fields.records.replaceChildren(fragment);
  if (follow) scrollToLatest();
  else updateLatestButton();
}

function isNearLatest() {
  return fields.scroll.scrollHeight - fields.scroll.clientHeight - fields.scroll.scrollTop < 64;
}

function updateLatestButton() {
  byId("latest").hidden = isNearLatest();
}

function scrollToLatest(smooth = false) {
  fields.scroll.scrollTo({ top: fields.scroll.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  updateLatestButton();
}

function selectFilter(filter) {
  state.filter = filter;
  byId("page-title").textContent = titles[filter];
  for (const button of document.querySelectorAll("[data-filter]")) {
    const selected = button.dataset.filter === filter;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  renderRecords({ follow: filter === "all" && !fields.search.value.trim() });
}

function locate(id) {
  fields.search.value = "";
  selectFilter("all");
  const row = byId(`record-${id}`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  locatedRow?.classList.remove("located");
  locatedRow = row;
  row.classList.add("located");
  setTimeout(() => row.classList.remove("located"), 1500);
}

function showStatus(message, type = "") {
  if (fields.status.textContent !== message) fields.status.textContent = message;
  byId("status-dot").className = type ? `status-dot ${type}` : "status-dot";
}

function updateConnection() {
  const connection = state.connection;
  const label = connection ? "立即同步" : "连接同步";
  byId("sync-label").textContent = label;
  byId("sync").disabled = state.syncing;
  byId("sync").classList.toggle("busy", state.syncing);
  byId("sync").setAttribute("aria-label", label);
  byId("example").hidden = !!connection;
  byId("account-title").textContent = connection ? "同步账号" : "连接同步";
  byId("account-detail").textContent = connection?.session.email || "Supabase 账号";
  byId("account").setAttribute("aria-label", connection ? "同步账号" : "连接同步账号");
  fields.login.hidden = !!connection;
  byId("connected").hidden = !connection;
  byId("connection-title").textContent = connection ? "同步账号" : "连接我的记录";
  byId("connected-email").textContent = connection?.session.email || "";
  byId("connection-info").textContent = state.lastSync
    ? `上次同步 ${timeFormat.format(state.lastSync)}`
    : "登录后会读取同一项目和账号的记录。";
}

function beginConnection(config, session) {
  state.connection = { config, session, api: new SupabaseRecords(config), scope: JSON.stringify([config.project, session.id]) };
  state.cloud = new Map();
  state.pending = new Map();
  state.cursor = 0;
  state.lastSync = 0;
  saveSession(config, session);
  fields.search.value = "";
  fields.draft.value = "";
  updateComposer();
  updateConnection();
  selectFilter("all");
}

function endConnection() {
  fields.attachment.close();
  clearAttachment();
  state.connection = null;
  state.cloud.clear();
  state.pending.clear();
  state.lastSync = 0;
  state.syncing = false;
  clearTimeout(followup);
  saveSession(null, null);
  fields.draft.value = "";
  fields.search.value = "";
  fields.login.reset();
  fields.customProject.open = false;
  byId("edit-field").value = "";
  fields.actions.close();
  updateComposer();
  updateConnection();
  selectFilter("all");
  showStatus("已退出同步，当前显示示例");
}

function openConnection() {
  const feedback = byId("login-error");
  feedback.hidden = true;
  feedback.textContent = "";
  updateConnection();
  if (!fields.connection.open) fields.connection.showModal();
}

async function pull(connection) {
  let changed = false;
  for (let page = 0; page < 40; page++) {
    const batch = await connection.api.pull(connection.session.access, state.cursor);
    if (state.connection !== connection || !batch.length) break;
    for (const row of batch) {
      state.cloud.set(row.record_id, row);
      state.cursor = Math.max(state.cursor, row.revision);
    }
    changed = true;
  }
  return changed;
}

function refresh(connection) {
  if (!connection.refreshing) connection.refreshing = refreshSession(connection).finally(() => { connection.refreshing = null; });
  return connection.refreshing;
}

async function refreshSession(connection) {
  if (connection.session.expiresAt - Date.now() >= 60000) return;
  try {
    const fresh = await connection.api.refresh(connection.session);
    if (state.connection === connection) {
      connection.session = fresh;
      saveSession(connection.config, fresh);
    }
  } catch (error) {
    if (state.connection === connection && error instanceof ApiError && [400, 401, 403].includes(error.status)) {
      endConnection();
      openConnection();
      loginError("登录已失效，请重新登录。");
    }
    throw error;
  }
}

async function syncNow({ quiet = false } = {}) {
  const connection = state.connection;
  if (!connection || state.syncing) return;
  if (!navigator.onLine) {
    showStatus("当前离线，联网后会自动同步", "warn");
    return;
  }
  state.syncing = true;
  if (!quiet) {
    updateConnection();
    showStatus("正在同步…");
  }
  const follow = state.filter === "all" && !fields.search.value.trim() && isNearLatest();
  const startCursor = state.cursor;
  let complete = false;
  let changed = false;
  try {
    const entries = await readOutbox(connection.scope);
    if (state.connection !== connection) return;
    if (entries.length !== state.pending.size || entries.some(row => state.pending.get(row.record_id)?.digest !== row.digest)) {
      state.pending = new Map(entries.map(row => [row.record_id, row]));
      changed = true;
    }
    await refresh(connection);
    if (state.connection !== connection) return;
    const sent = entries.slice(0, 100);
    for (let start = 0; start < sent.length; start += 20) {
      await connection.api.push(connection.session.access, sent.slice(start, start + 20));
      if (state.connection !== connection) return;
    }
    changed = await pull(connection) || changed;
    if (state.connection !== connection) return;
    if (sent.length) await acknowledge(connection.scope, sent);
    const remaining = sent.length ? await readOutbox(connection.scope) : [...state.pending.values()];
    if (state.connection !== connection) return;
    if (remaining.length !== state.pending.size ||
        remaining.some(row => state.pending.get(row.record_id)?.digest !== row.digest)) {
      state.pending = new Map(remaining.map(row => [row.record_id, row]));
      changed = true;
    }
    state.lastSync = Date.now();
    complete = true;
    showStatus(state.pending.size ? `${state.pending.size} 条记录待同步` : "已同步", "ok");
  } catch (error) {
    if (state.connection !== connection) return;
    if (error instanceof ApiError && error.status === 401) connection.session.expiresAt = 0;
    showStatus(error.message || "同步未完成，请重试。", "warn");
  } finally {
    if (state.connection === connection) {
      state.syncing = false;
      updateConnection();
      if (changed || startCursor !== state.cursor) renderRecords({ follow });
      if (complete && state.pending.size) scheduleSync();
    }
  }
}

function scheduleSync() {
  clearTimeout(followup);
  followup = setTimeout(syncNow, 300);
}

async function changeRecord(id, update) {
  if (state.busy) return false;
  const connection = state.connection;
  const before = currentRows().get(id);
  const now = Math.max(Date.now(), (before?.updated_at_ms ?? 0) + 1);
  state.busy = true;
  updateComposer();
  try {
    const data = update(before?.payload ?? { created: now, type: "TEXT" });
    if (connection) {
      const change = await makeChange(id, now, data);
      await queueChange(connection.scope, change);
      if (state.connection !== connection) return false;
      state.pending.set(id, change);
      showStatus(`${state.pending.size} 条记录待同步`);
      scheduleSync();
    } else state.demo.set(id, { record_id: id, updated_at_ms: now, digest: "", payload: data });
    renderRecords({ follow: !before && state.filter === "all" });
    return true;
  } catch {
    showStatus("无法在此浏览器保存修改，请检查浏览器存储权限。", "warn");
    return false;
  } finally {
    state.busy = false;
    updateComposer();
  }
}

function showActions(id) {
  const row = currentRows().get(id);
  if (!row) return;
  state.selected = id;
  byId("actions-title").textContent = "记录操作";
  byId("action-choices").hidden = false;
  byId("edit-form").hidden = true;
  byId("delete-confirm").hidden = true;
  fields.actions.showModal();
}

function updateComposer() {
  fields.send.disabled = state.busy || !fields.draft.value.trim();
}

function loginError(message) {
  const feedback = byId("login-error");
  feedback.hidden = false;
  feedback.textContent = message;
}

fields.login.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = byId("login-submit");
  if (submit.disabled) return;
  const { project, key, email, password } = fields.login.elements;
  byId("login-error").hidden = true;
  submit.disabled = true;
  submit.textContent = "正在登录…";
  try {
    const config = fields.customProject.open ? readConfig(project.value, key.value) : defaultProject;
    if (!email.validity.valid) {
      email.focus();
      throw new Error("请输入有效的同步邮箱。");
    }
    if (!password.value) {
      password.focus();
      throw new Error("请输入同步账号的密码。");
    }
    const session = await new SupabaseRecords(config).login(email.value.trim(), password.value);
    password.value = "";
    beginConnection(config, session);
    fields.connection.close();
    await syncNow();
  } catch (error) {
    if (!fields.connection.open) openConnection();
    loginError(error.message || "登录失败，请重试。");
  } finally {
    submit.disabled = false;
    submit.textContent = "登录并同步";
  }
});

for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => selectFilter(button.dataset.filter));
}
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
fields.attachment.addEventListener("close", () => {
  if (!fields.attachment.open) clearAttachment();
});
byId("account").addEventListener("click", openConnection);
byId("connect").addEventListener("click", openConnection);
byId("sync").addEventListener("click", () => state.connection ? syncNow() : openConnection());
byId("logout").addEventListener("click", () => { fields.connection.close(); endConnection(); });
byId("latest").addEventListener("click", () => scrollToLatest(true));
fields.scroll.addEventListener("scroll", updateLatestButton, { passive: true });
fields.search.addEventListener("input", () => { fields.scroll.scrollTop = 0; renderRecords(); });
fields.draft.addEventListener("input", updateComposer);
fields.draft.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) fields.composer.requestSubmit();
});
fields.composer.addEventListener("submit", async event => {
  event.preventDefault();
  const text = fields.draft.value.trim();
  if (!text) return;
  const saved = await changeRecord(crypto.randomUUID(), original => ({ ...original, content: text, type: textLink(text) ? "LINK" : "TEXT" }));
  if (!saved) return;
  fields.draft.value = "";
  fields.search.value = "";
  selectFilter("all");
  updateComposer();
});
byId("edit").addEventListener("click", () => {
  const row = currentRows().get(state.selected);
  if (!row || row.payload.deleted) return;
  byId("actions-title").textContent = "编辑正文";
  byId("action-choices").hidden = true;
  byId("edit-field").value = row.payload.content ?? "";
  byId("edit-field").required = !row.payload.attachments?.length;
  byId("edit-form").hidden = false;
  byId("edit-field").focus();
});
byId("edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  const previous = currentRows().get(state.selected);
  if (!previous || previous.payload.deleted) return;
  const text = byId("edit-field").value.trim();
  if (!text && !previous.payload.attachments?.length) return;
  if (await changeRecord(state.selected, row => ({
    ...row, content: text || null,
    type: ["TEXT", "LINK"].includes(row.type) ? textLink(text) ? "LINK" : "TEXT" : row.type,
  }))) fields.actions.close();
});
byId("delete").addEventListener("click", () => {
  byId("actions-title").textContent = "删除这条记录？";
  byId("action-choices").hidden = true;
  byId("delete-confirm").hidden = false;
});
byId("confirm-delete").addEventListener("click", async () => {
  if (await changeRecord(state.selected, previous => ({ created: previous.created, deleted: true }))) fields.actions.close();
});
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    fields.search.focus();
  }
});
window.addEventListener("online", () => { if (!document.hidden) syncNow({ quiet: true }); });
window.addEventListener("offline", () => { if (state.connection) showStatus("当前离线，联网后会自动同步", "warn"); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow({ quiet: true }); });
setInterval(() => { if (!document.hidden) syncNow({ quiet: true }); }, 5000);

const previous = loadSession();
if (previous) {
  beginConnection(previous.config, previous.session);
  syncNow();
} else {
  updateConnection();
  renderRecords();
}
