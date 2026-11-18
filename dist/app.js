import {
  ApiError, SupabaseRecords, acknowledge, compareRecord, defaultProject, loadSession, makeChange,
  pendingAttachmentFiles, readConfig, readOutbox, readWorkspace, saveSession, writeWorkspace,
} from "./sync.js?v=6";
import { recordKind, recordSummary, saveBlob, shareText, startRecording, exportLongImage, askAi, aiAddress, transcribeAudio } from "./tools.js";
import { exportBackup, inspectBackup } from "./backup.js";

const byId = id => document.getElementById(id);
const fields = {
  records: byId("records"), search: byId("search"), scroll: byId("scroll"),
  connection: byId("connection"), login: byId("login"), actions: byId("actions"),
  customProject: byId("custom-project"),
  attachment: byId("attachment-preview"), preview: byId("attachment-content"),
  settings: byId("settings"), utility: byId("utility"), utilityContent: byId("utility-content"),
  composer: byId("composer"), draft: byId("draft"), send: byId("send"), status: byId("status"),
};
const titles = { all: "时间线", favorites: "收藏", files: "附件" };
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const yearFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const dateKey = timestamp => new Date(timestamp).toDateString();
const state = {
  connection: null, cloud: new Map(), pending: new Map(), local: new Map(), trash: new Map(), preferences: {},
  cursor: 0, filter: "all", syncing: false, lastSync: 0, busy: false, selected: null,
  visible: [], selection: null, draftFiles: [], quote: null, deleteIds: [], lastDeletion: [],
};
let followup;
let locatedRow;
let activeAttachment;
let undoTimeout;
let recording;
let utilityTask;
let aiConfig;
let workspaceReady = Promise.resolve();
let selectionDrag;
const scope = () => state.connection?.scope ?? "local";

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

function currentRows() {
  if (!state.connection) return state.local;
  const records = new Map(state.cloud);
  for (const [id, queued] of state.pending) {
    const synced = records.get(id);
    if (!synced || compareRecord(synced, queued) < 0) records.set(id, queued);
  }
  return records;
}

function getPreferences(name) {
  try { return JSON.parse(localStorage.getItem(`yinu.${name}`)) ?? {}; }
  catch { return {}; }
}

function putPreferences(name, value) {
  localStorage.setItem(`yinu.${name}`, JSON.stringify(value));
}

function updatePreferences(patch) {
  const preferences = { ...state.preferences, ...patch };
  putPreferences(scope(), preferences);
  state.preferences = preferences;
}

async function loadWorkspace(connection = state.connection) {
  const currentScope = connection?.scope ?? "local";
  try {
    const [records, deleted, pending] = await Promise.all([
      readWorkspace("records", currentScope), readWorkspace("trash", currentScope),
      connection ? readOutbox(currentScope) : [],
    ]);
    if (state.connection !== connection) return;
    const recordsById = new Map(records.map(row => [row.record_id, row]));
    if (connection) {
      state.cloud = recordsById;
      state.pending = new Map(pending.map(row => [row.record_id, row]));
      state.cursor = records.reduce((max, row) => Math.max(max, row.revision ?? 0), 0);
    } else {
      state.local = recordsById;
    }
    state.trash = new Map(deleted.map(row => [row.record_id, row]));
    renderRecords({ follow: true });
  } catch (error) {
    if (state.connection === connection) showStatus(error.message || "无法读取本机存储。", "warn");
  }
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

async function readAttachment(file, connection = state.connection) {
  const stored = await readWorkspace("files", connection?.scope ?? "local", file.id);
  if (stored?.blob) return stored.blob;
  if (!connection) throw new Error("此浏览器没有保存这个附件的原文件。");
  await refresh(connection);
  if (state.connection !== connection) throw new Error("同步账号已切换。");
  return connection.api.downloadAttachment(connection.session, file.id);
}

const rasterTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);

function clearAttachment() {
  for (const url of activeAttachment?.urls ?? []) URL.revokeObjectURL(url);
  activeAttachment = null;
  fields.preview.replaceChildren();
}

async function openAttachment(file) {
  const connection = state.connection;
  clearAttachment();
  const preview = { urls: [] };
  activeAttachment = preview;
  byId("attachment-title").textContent = file.name;
  fields.preview.append(element("p", null, "正在读取原文件…"));
  if (!fields.attachment.open) fields.attachment.showModal();
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
    const bytes = await readAttachment(file, connection);
    if (!isCurrent()) return;
    const content = document.createDocumentFragment();
    if (rasterTypes.has(file.mime)) {
      const url = URL.createObjectURL(bytes.slice(0, bytes.size, file.mime));
      preview.urls.push(url);
      const image = element("img", "attachment-image");
      image.alt = file.name;
      image.src = url;
      image.addEventListener("click", () => image.classList.toggle("zoomed"));
      image.addEventListener("error", () => image.replaceWith(element("p", null, "图片预览失败，可以下载原文件。")));
      content.append(image);
      const gallery = activeRows().sort((a, b) => a.payload.created - b.payload.created)
        .flatMap(row => (row.payload.attachments ?? []).filter(item => rasterTypes.has(item.mime)));
      const index = gallery.findIndex(item => item.id === file.id);
      if (index >= 0 && gallery.length > 1) {
        const controls = element("div", "gallery-controls");
        const previous = button("上一张", () => openAttachment(gallery[index - 1]));
        const next = button("下一张", () => openAttachment(gallery[index + 1]));
        previous.disabled = index === 0;
        next.disabled = index === gallery.length - 1;
        controls.append(previous, element("span", null, `${index + 1} / ${gallery.length}`), next);
        content.append(controls);
      }
      content.append(button("标注图片", () => editImage(file, bytes)));
    } else if (/^(audio|video)\//.test(file.mime)) {
      const media = element(file.mime.startsWith("audio/") ? "audio" : "video", "attachment-media");
      media.controls = true;
      media.src = URL.createObjectURL(bytes.slice(0, bytes.size, file.mime));
      preview.urls.push(media.src);
      content.append(media);
      if (file.mime.startsWith("audio/")) content.append(button("转文字", () => showTranscription(file, bytes)));
    } else if (/\.(txt|md|csv|log|json)$/i.test(file.name) && bytes.size <= 1_000_000) {
      content.append(element("pre", "attachment-word", await bytes.text()));
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
  article.classList.toggle("is-selected", !!state.selection?.has(row.record_id));
  if (state.selection) {
    const check = element("input", "record-check");
    check.type = "checkbox";
    check.checked = state.selection.has(row.record_id);
    check.setAttribute("aria-label", `选中 ${recordSummary(data)}`);
    check.addEventListener("change", () => toggleSelection(row.record_id, check.checked, article));
    article.append(check);
  }
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
    const entry = element("button", "attachment");
    entry.type = "button";
    entry.addEventListener("click", () => openAttachment(file));
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
  if (data.favorite && data.group) meta.append(element("span", "file-size", data.group));
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
  article.addEventListener("contextmenu", event => {
    if (getSelection()?.toString() || event.target.closest("input")) return;
    event.preventDefault();
    showActions(row.record_id);
  });
  if (state.selection) article.addEventListener("click", event => {
    if (!event.target.closest("button, a, input") && !getSelection()?.toString()) {
      const check = article.querySelector(".record-check");
      check.checked = !check.checked;
      toggleSelection(row.record_id, check.checked, article);
    }
  });
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
  const date = byId("filter-date").value;
  const kind = byId("filter-kind").value;
  const groupSelect = byId("filter-group");
  const previousGroup = groupSelect.value;
  const groups = [...new Set([...rows.values()].filter(row => !row.payload.deleted && row.payload.favorite)
    .map(row => row.payload.group ?? ""))].sort();
  groupSelect.replaceChildren(new Option("全部分组", ""), ...groups.map(group => new Option(group || "未分组", `group:${group}`)));
  if ([...groupSelect.options].some(option => option.value === previousGroup)) groupSelect.value = previousGroup;
  groupSelect.hidden = state.filter !== "favorites";
  const group = groupSelect.hidden ? "" : groupSelect.value;
  byId("clear-filters").hidden = !query && !date && !kind && !group;
  const visible = [...rows.values()].filter(row => {
    const data = row.payload;
    if (data.deleted || (state.filter === "favorites" && !data.favorite) ||
        (state.filter === "files" && !data.attachments?.length)) return false;
    const created = new Date(data.created);
    const dateValue = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}-${String(created.getDate()).padStart(2, "0")}`;
    if (date && dateValue !== date || kind && !recordKind(data, kind) ||
        group && group !== `group:${data.group ?? ""}`) return false;
    return !query || [data.content, data.quote_text, data.group, ...(data.links ?? []).map(link => link.summary),
      ...(data.attachments ?? []).map(file => file.name)].some(value => typeof value === "string" && value.toLowerCase().includes(query));
  }).sort((a, b) => a.payload.created - b.payload.created || a.record_id.localeCompare(b.record_id));
  state.visible = visible;
  updateSelection();
  renderPins(rows);

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
  byId("filter-date").value = "";
  byId("filter-kind").value = "";
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
  switchWorkspace();
  saveSession(config, session);
  fields.search.value = "";
  updateComposer();
  updateConnection();
  selectFilter("all");
  workspaceReady = loadWorkspace(state.connection);
}

function endConnection() {
  fields.attachment.close();
  clearAttachment();
  state.connection = null;
  state.cloud.clear();
  state.pending.clear();
  state.lastSync = 0;
  state.syncing = false;
  switchWorkspace();
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
  showStatus("已退出同步，当前显示本机记录");
  workspaceReady = loadWorkspace(null);
}

function switchWorkspace() {
  fields.utility.close();
  utilityTask = null;
  recording?.stop(true);
  aiConfig = null;
  state.preferences = getPreferences(scope());
  state.selection = null;
  state.trash = new Map();
  state.lastDeletion = [];
  byId("undo-delete").hidden = true;
  state.draftFiles = [];
  state.quote = null;
  fields.draft.value = "";
  byId("filter-kind").value = "";
  byId("filter-date").value = "";
  updateDraftContext();
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
    await writeWorkspace(connection.scope, { rows: batch });
    if (state.connection !== connection) break;
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
  await workspaceReady;
  if (state.connection !== connection) return;
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
    if (sent.length) {
      await writeWorkspace(connection.scope, { rows: sent });
      await acknowledge(connection.scope, sent);
    }
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
    uploadPendingAttachments(connection);
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

async function uploadPendingAttachments(connection) {
  if (connection.uploading || (connection.retryUploadAt ?? 0) > Date.now()) return;
  connection.uploading = true;
  try {
    const active = new Set([...currentRows().values()].filter(row => !row.payload.deleted)
      .flatMap(row => (row.payload.attachments ?? []).map(file => file.id)));
    const pending = await pendingAttachmentFiles(connection.scope, 4, active);
    for (const file of pending) {
      if (state.connection !== connection) return;
      if (!active.has(file.id)) continue;
      await connection.api.uploadAttachment(connection.session, file.id, file.blob);
      await writeWorkspace(connection.scope, { files: [{ ...file, pending: false }] });
    }
  } catch {
    connection.retryUploadAt = Date.now() + 30000;
    if (state.connection === connection) showStatus("附件还在本机，联网后会重试上传", "warn");
  } finally {
    connection.uploading = false;
  }
}

function scheduleSync() {
  clearTimeout(followup);
  followup = setTimeout(syncNow, 300);
}

async function changeRecord(id, update) {
  return changeRecords([[id, update]]);
}

async function changeRecords(edits, { files = [], trash = [], removed = [] } = {}) {
  const connection = state.connection;
  await workspaceReady;
  if (state.connection !== connection || state.busy || !edits.length) return false;
  const current = currentRows();
  const currentScope = scope();
  state.busy = true;
  updateComposer();
  try {
    const changes = await Promise.all(edits.map(([id, update]) => {
      const before = current.get(id);
      const now = Math.max(Date.now(), (before?.updated_at_ms ?? 0) + 1);
      return makeChange(id, now, update(before?.payload ?? { created: now, type: "TEXT" }));
    }));
    await writeWorkspace(currentScope, { rows: changes, cloud: !!connection, files, trash, removed });
    if (state.connection !== connection) return false;
    const rows = connection ? state.pending : state.local;
    for (const change of changes) rows.set(change.record_id, change);
    for (const item of trash) state.trash.set(item.record_id, item);
    for (const id of removed) state.trash.delete(id);
    if (connection) {
      showStatus(`${state.pending.size} 条记录待同步`);
      scheduleSync();
    } else showStatus("已保存到此浏览器", "ok");
    renderRecords({ follow: edits.some(([id]) => !current.has(id)) && state.filter === "all" });
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
  byId("action-form").hidden = true;
  byId("delete-confirm").hidden = true;
  byId("pin").textContent = state.preferences.pins?.includes(id) ? "取消置顶" : "置顶";
  byId("copy-record").disabled = !row.payload.content;
  fields.actions.showModal();
}

function updateComposer() {
  fields.send.disabled = state.busy || !fields.draft.value.trim() && !state.draftFiles.length;
}

function button(text, handler, className = "secondary") {
  const result = element("button", className, text);
  result.type = "button";
  result.addEventListener("click", handler);
  return result;
}

function currentRecord() {
  const row = currentRows().get(state.selected);
  return row && !row.payload.deleted ? row : null;
}

function activeRows() {
  return [...currentRows().values()].filter(row => !row.payload.deleted);
}

function renderPins(rows) {
  const bar = byId("pin-bar");
  bar.replaceChildren();
  if (state.filter !== "all") { bar.hidden = true; return; }
  for (const id of state.preferences.pins ?? []) {
    const row = rows.get(id);
    if (!row || row.payload.deleted) continue;
    const pill = button(`⌖ ${recordSummary(row.payload)}`, () => locate(id), "pin-pill");
    pill.title = "定位置顶记录";
    bar.append(pill);
  }
  bar.hidden = !bar.childElementCount;
}

function updateSelection() {
  const selection = state.selection;
  if (selection) {
    const rows = currentRows();
    for (const id of selection) if (!rows.has(id) || rows.get(id).payload.deleted) selection.delete(id);
  }
  const count = selection?.size ?? 0;
  byId("selection-count").textContent = `已选 ${count} 条`;
  byId("selection-bar").hidden = !selection;
  byId("selection-start").hidden = !!selection;
  fields.composer.hidden = !!selection;
  if (selection) byId("draft-context").hidden = true;
  for (const suffix of ["merge", "export", "ai", "delete"]) byId(`selection-${suffix}`).disabled = count < (suffix === "merge" ? 2 : 1);
  byId("selection-all").disabled = !state.visible.length;
  byId("selection-all").textContent = state.visible.length && state.visible.every(row => selection?.has(row.record_id))
    ? "取消全选" : "全选";
}

function toggleSelection(id, checked, article) {
  if (!state.selection) return;
  if (checked) state.selection.add(id);
  else state.selection.delete(id);
  article.classList.toggle("is-selected", checked);
  updateSelection();
}

function selectedRows() {
  return activeRows().filter(row => state.selection?.has(row.record_id))
    .sort((a, b) => a.payload.created - b.payload.created);
}

function leaveSelection() {
  state.selection = null;
  selectionDrag = null;
  updateDraftContext();
  renderRecords();
}

function updateDraftContext() {
  const context = byId("draft-context");
  context.replaceChildren();
  if (state.quote) {
    context.append(button(`引用：${state.quote.summary} ×`, () => {
      state.quote = null;
      updateDraftContext();
    }, "draft-chip"));
  }
  state.draftFiles.forEach((file, index) => context.append(button(`${file.name} ×`, () => {
    state.draftFiles.splice(index, 1);
    updateDraftContext();
  }, "draft-chip")));
  context.hidden = !!state.selection || !context.childElementCount;
  updateComposer();
}

function stageFiles(files) {
  const accepted = [...files].filter(file => file.size <= 50_000_000);
  const room = Math.max(0, 20 - state.draftFiles.length);
  state.draftFiles.push(...accepted.slice(0, room));
  if (accepted.length !== files.length || accepted.length > room) {
    showStatus("每条最多 20 个附件，单个文件最多 50 MB。", "warn");
  }
  updateDraftContext();
}

function prepareFiles(files) {
  const entries = files.map((blob, index) => ({
    id: crypto.randomUUID(), name: blob.name || "未命名文件", mime: blob.type || "application/octet-stream",
    size: blob.size, position: index, blob, pending: !!state.connection,
  }));
  return {
    files: entries.map(({ id, blob, pending }) => ({ id, blob, pending })),
    attachments: entries.map(({ id, name, mime, size, position }) => ({ id, name, mime, size, position })),
  };
}

async function saveDraft() {
  const text = fields.draft.value.trim();
  if (!text && !state.draftFiles.length) return;
  const { files, attachments } = prepareFiles(state.draftFiles);
  const quote = state.quote;
  const type = attachments.length ? attachments.every(file => file.mime.startsWith("image/")) ? "IMAGE"
    : attachments.length === 1 && attachments[0].mime.startsWith("audio/") ? "VOICE" : "FILE"
    : textLink(text) ? "LINK" : "TEXT";
  const saved = await changeRecords([[crypto.randomUUID(), original => ({
    ...original, content: text || null, type, attachments, quote_id: quote?.id, quote_text: quote?.summary,
  })]], { files });
  if (!saved) return;
  fields.draft.value = "";
  state.draftFiles = [];
  state.quote = null;
  updateDraftContext();
  clearFilters();
  selectFilter("all");
}

function clearFilters() {
  fields.search.value = "";
  for (const id of ["filter-date", "filter-kind", "filter-group"]) byId(id).value = "";
  renderRecords();
}

function showDelete(ids) {
  if (!ids.length) return;
  state.deleteIds = ids;
  byId("actions-title").textContent = ids.length === 1 ? "删除这条记录？" : `删除这 ${ids.length} 条记录？`;
  for (const id of ["action-choices", "edit-form", "action-form"]) byId(id).hidden = true;
  byId("delete-confirm").hidden = false;
  if (!fields.actions.open) fields.actions.showModal();
}

async function deleteRecords(ids) {
  const now = Date.now();
  const entries = activeRows().filter(row => ids.includes(row.record_id)).map(row => ({ ...row, deletedAt: now }));
  if (!await changeRecords(entries.map(row =>
    [row.record_id, previous => ({ created: previous.created, deleted: true })]), { trash: entries })) return;
  fields.actions.close();
  leaveSelection();
  state.lastDeletion = ids;
  byId("undo-delete").hidden = false;
  clearTimeout(undoTimeout);
  undoTimeout = setTimeout(() => { byId("undo-delete").hidden = true; }, 5000);
  showStatus("已移到最近删除");
}

async function restoreRecords(ids) {
  const entries = ids.map(id => state.trash.get(id)).filter(Boolean);
  if (!await changeRecords(entries.map(row => [row.record_id, () => row.payload]), { removed: entries.map(row => row.record_id) })) return;
  byId("undo-delete").hidden = true;
  state.lastDeletion = [];
  showStatus("已恢复记录", "ok");
}

function actionForm(title, content, submit, work) {
  const form = byId("action-form");
  byId("action-choices").hidden = true;
  byId("actions-title").textContent = title;
  form.hidden = false;
  const feedback = element("p", "feedback");
  const save = element("button", "primary", submit);
  save.type = "submit";
  form.replaceChildren(...content, feedback, save);
  form.onsubmit = async event => {
    event.preventDefault();
    save.disabled = true;
    try { if (await work()) fields.actions.close(); }
    catch (error) { feedback.textContent = error.message; }
    finally { save.disabled = false; }
  };
}

function labelled(text, input) {
  const label = element("label", null, text);
  label.append(input);
  return label;
}

function showRelations(row) {
  const selected = new Map((row.payload.links ?? []).map(link => [link.id, link]));
  const query = element("input");
  query.type = "search";
  query.placeholder = "搜索可关联的记录";
  const list = element("div", "utility-list");
  const candidates = activeRows().filter(target => target.record_id !== row.record_id).reverse();
  function render() {
    const filter = query.value.trim().toLowerCase();
    const matches = candidates.filter(target => recordSummary(target.payload).toLowerCase().includes(filter)).slice(0, 100);
    list.replaceChildren();
    for (const target of matches) {
      const check = element("input");
      check.type = "checkbox";
      check.checked = selected.has(target.record_id);
      check.addEventListener("change", () => {
        if (check.checked) selected.set(target.record_id, { id: target.record_id, summary: recordSummary(target.payload) });
        else selected.delete(target.record_id);
      });
      const label = labelled(recordSummary(target.payload), check);
      label.className = "check-line";
      list.append(label);
    }
  }
  render();
  query.addEventListener("input", render);
  actionForm("关联记录", [query, list], "保存关联", () => {
    if (selected.size > 200) throw new Error("每条记录最多关联 200 条。");
    const links = [...selected.values()].map((link, position) => ({ ...link, position }));
    return changeRecord(row.record_id, previous => ({ ...previous, links }));
  });
}

function openUtility(title, ...nodes) {
  utilityTask = {};
  byId("utility-title").textContent = title;
  fields.utilityContent.replaceChildren(...nodes);
  fields.settings.close();
  if (!fields.utility.open) fields.utility.showModal();
  return utilityTask;
}

function notice(message) { return element("p", null, message); }

async function withUtility(button, feedback, work) {
  button.disabled = true;
  feedback.textContent = "";
  try { await work(); }
  catch (error) { feedback.textContent = error.message || "操作未完成，请重试。"; }
  finally { button.disabled = false; }
}

function showTrash() {
  const list = element("div", "utility-list");
  for (const row of [...state.trash.values()].sort((a, b) => b.deletedAt - a.deletedAt)) {
    const id = row.record_id;
    if (currentRows().get(id)?.payload.deleted !== true) continue;
    const content = element("div", "utility-row");
    const restore = button("恢复", async () => { await restoreRecords([id]); showTrash(); });
    const discard = button("彻底删除", () => {
      const feedback = notice("恢复入口和此浏览器的附件副本会永久移除。");
      const confirm = button("确认彻底删除", () => withUtility(confirm, feedback, async () => {
        const protectedIds = new Set(activeRows().flatMap(record => (record.payload.attachments ?? []).map(file => file.id)));
        for (const other of state.trash.values()) {
          if (other.record_id !== id) for (const file of other.payload.attachments ?? []) protectedIds.add(file.id);
        }
        const dropFiles = (row.payload.attachments ?? []).map(file => file.id).filter(file => !protectedIds.has(file));
        await writeWorkspace(scope(), { removed: [id], dropFiles });
        state.trash.delete(id);
        showTrash();
      }), "primary destructive");
      openUtility("彻底删除记录？", feedback, confirm, button("返回最近删除", showTrash));
    }, "text-button danger");
    content.append(element("strong", null, recordSummary(row.payload)), restore, discard);
    list.append(content);
  }
  if (!list.childElementCount) list.append(notice("没有最近删除的记录。"));
  openUtility("最近删除", list);
}

function localDateTime(timestamp) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function editReminder(row) {
  const id = row.record_id;
  const input = element("input");
  input.type = "datetime-local";
  input.required = true;
  input.value = localDateTime(state.preferences.reminders?.[id] ?? Date.now() + 15 * 60000);
  actionForm("记录提醒", [labelled("提醒时间", input), notice("网页保持打开时检查提醒，可在设置里开启系统通知。")], "保存提醒", () => {
    const at = new Date(input.value).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error("请选择一个将来的时间。");
    updatePreferences({ reminders: { ...state.preferences.reminders, [id]: at } });
    showStatus("已设置提醒", "ok");
    return true;
  });
}

function showReminders() {
  const list = element("div", "utility-list");
  for (const [id, at] of Object.entries(state.preferences.reminders ?? {}).sort((a, b) => a[1] - b[1])) {
    const row = currentRows().get(id);
    if (!row || row.payload.deleted) continue;
    const entry = element("div", "utility-row");
    const name = element("strong", null, recordSummary(row.payload));
    const remove = button("取消", () => {
      const reminders = { ...state.preferences.reminders };
      delete reminders[id];
      updatePreferences({ reminders });
      showReminders();
    });
    entry.append(name, notice(new Date(at).toLocaleString("zh-CN")), remove);
    list.append(entry);
  }
  if (!list.childElementCount) list.append(notice("还没有待提醒的记录。"));
  const feedback = notice("标签页打开时会检查到期提醒。");
  const enable = button("开启系统通知", async () => {
    if (typeof Notification !== "function") { feedback.textContent = "此浏览器不支持系统通知。"; return; }
    try { feedback.textContent = await Notification.requestPermission() === "granted" ? "系统通知已开启。" : "浏览器未授予通知权限。"; }
    catch { feedback.textContent = "此浏览器无法开启系统通知。"; }
  });
  openUtility("记录提醒", list, feedback, enable);
}

function checkReminders() {
  const reminders = { ...getPreferences(scope()).reminders };
  const now = Date.now();
  const due = Object.keys(reminders).filter(id => reminders[id] <= now);
  if (!due.length) return;
  const rows = currentRows();
  const ready = due.filter(id => rows.has(id));
  if (!ready.length) return;
  for (const id of ready) delete reminders[id];
  updatePreferences({ reminders });
  const notes = ready.map(id => rows.get(id)).filter(row => !row.payload.deleted);
  for (const row of notes) {
    const text = recordSummary(row.payload);
    showStatus(`提醒：${text}`);
    if (globalThis.Notification?.permission === "granted") {
      const options = { body: text, tag: row.record_id, data: { recordId: row.record_id } };
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.ready.then(worker => worker.showNotification("一隅 · 记录提醒", options)).catch(() => {});
      } else {
        try { new Notification("一隅 · 记录提醒", options); } catch { /* In-page status is the fallback. */ }
      }
    }
  }
}

function setTheme(value) {
  document.documentElement.dataset.theme = value;
  byId("theme").value = value;
}

function showAiSettings() {
  const nodes = [notice("使用支持网页请求的 OpenAI 兼容服务。密钥只在当前标签页保留。")];
  const sections = {};
  for (const [id, title] of [["chat", "整理正文"], ["speech", "语音转写"]]) {
    const fieldset = element("fieldset");
    fieldset.append(element("legend", null, title));
    const fields = {};
    for (const [key, name] of [["url", "HTTPS 地址"], ["model", "模型"], ["key", "API Key"]]) {
      const input = element("input");
      input.type = key === "key" ? "password" : "text";
      input.autocomplete = "off";
      input.value = key === "key" ? "" : aiConfig?.[id]?.[key] ?? "";
      if (key === "key" && aiConfig?.[id]?.key) input.placeholder = "已配置";
      fields[key] = input;
      fieldset.append(labelled(name, input));
    }
    sections[id] = fields;
    nodes.push(fieldset);
  }
  const feedback = notice("");
  const save = button("保存设置", () => {
    try {
      const values = {};
      for (const [name, fields] of Object.entries(sections)) {
        const url = fields.url.value.trim();
        const model = fields.model.value.trim();
        const key = fields.key.value.trim() || (aiConfig?.[name]?.url === url ? aiConfig[name].key : "");
        if (!url && !model && !key) continue;
        if (!url || !model || !key) throw new Error("请为启用的服务填写地址、模型和密钥。");
        aiAddress(url, name === "chat" ? "chat/completions" : "audio/transcriptions");
        values[name] = { url, model, key };
      }
      aiConfig = values;
      fields.utility.close();
      showStatus("已保存本标签页的 AI 配置", "ok");
    } catch (error) { feedback.textContent = error.message; }
  }, "primary");
  openUtility("AI 服务", ...nodes, feedback, save);
}

function showAi(rows) {
  if (!aiConfig?.chat) { showAiSettings(); return; }
  const preview = element("textarea");
  preview.readOnly = true;
  preview.rows = 7;
  preview.hidden = true;
  const config = aiConfig.chat;
  const feedback = notice(`将把所选正文发送给 ${new URL(config.url).host}。`);
  const run = button("发送并整理", () => withUtility(run, feedback, async () => {
    preview.value = await askAi(config, rows.map(row => row.payload.content).filter(Boolean));
    preview.hidden = false;
    save.hidden = false;
  }), "primary");
  const save = button("存为记录", async () => {
    const links = rows.slice(0, 200).map((row, position) => ({ id: row.record_id, summary: recordSummary(row.payload), position }));
    if (await changeRecord(crypto.randomUUID(), previous => ({ ...previous, content: preview.value, links }))) {
      fields.utility.close();
      leaveSelection();
      selectFilter("all");
    }
  });
  save.hidden = true;
  openUtility("AI 整理", feedback, run, preview, save);
}

function showTranscription(file, blob) {
  if (!aiConfig?.speech) { showAiSettings(); return; }
  const config = aiConfig.speech;
  const feedback = notice(`将把这段语音发送给 ${new URL(config.url).host}。`);
  const run = button("发送并转写", () => withUtility(run, feedback, async () => {
    const audio = new File([blob], file.name, { type: file.mime });
    const text = await transcribeAudio(config, audio);
    if (!fields.utility.open || task !== utilityTask) return;
    fields.draft.value = [fields.draft.value.trim(), text].filter(Boolean).join("\n");
    fields.utility.close();
    fields.attachment.close();
    leaveSelection();
    fields.draft.focus();
  }), "primary");
  const task = openUtility("语音转文字", feedback, run);
}

function showLongExport(rows) {
  const connection = state.connection;
  const feedback = notice(`将导出 ${rows.length} 条记录为 PNG 长图。`);
  const files = element("div", "utility-list");
  const run = button("生成长图", () => withUtility(run, feedback, async () => {
    feedback.textContent = "正在生成…";
    const pages = await exportLongImage(rows, file => readAttachment(file, connection));
    if (!fields.utility.open || task !== utilityTask) return;
    files.replaceChildren(...pages.map((page, index) => button(`下载第 ${index + 1} 页`, () => saveBlob(page, `一隅长图-${index + 1}.png`))));
    feedback.textContent = `已生成 ${pages.length} 页。`;
  }), "primary");
  const task = openUtility("导出长图", feedback, run, files);
}

function mergeRecords(rows) {
  const connection = state.connection;
  const caption = element("textarea");
  caption.placeholder = "合并说明（可选）";
  caption.maxLength = 12000;
  const feedback = notice("将按时间合并正文和文件，原记录会保留。");
  const run = button("保存合并记录", () => withUtility(run, feedback, async () => {
    const originals = rows.flatMap(row => row.payload.attachments ?? []);
    if (originals.length > 20) throw new Error("合并记录最多保存 20 个附件。");
    const content = [caption.value.trim(), ...rows.map(row => row.payload.content)].filter(Boolean).join("\n\n");
    if (content.length > 12000) throw new Error("合并正文最多 12,000 字。");
    const allFiles = [];
    for (const file of originals) allFiles.push(new File([await readAttachment(file, connection)], file.name, { type: file.mime }));
    if (state.connection !== connection || !fields.utility.open || task !== utilityTask) return;
    const { files, attachments } = prepareFiles(allFiles);
    const links = rows.slice(0, 200).map((row, position) => ({ id: row.record_id, summary: recordSummary(row.payload), position }));
    if (await changeRecords([[crypto.randomUUID(), original => ({
      ...original, content: content || null, type: attachments.length ? "FILE" : "TEXT", attachments, links,
    })]], { files })) {
      fields.utility.close();
      leaveSelection();
      clearFilters();
      selectFilter("all");
    }
  }), "primary");
  const task = openUtility("合并记录", caption, feedback, run);
}

function showBackup() {
  const connection = state.connection;
  const currentScope = scope();
  const actions = element("div", "action-choices");
  const feedback = notice("ZIP 可在网页和手机之间恢复。导入时会保留同 ID 的现有记录，并可补回缺失的原件。");
  const picker = element("input");
  picker.type = "file";
  picker.accept = ".zip,application/zip";
  picker.hidden = true;
  const download = button("生成 ZIP 备份", () => withUtility(download, feedback, async () => {
    feedback.textContent = "正在读取记录和附件…";
    const records = activeRows();
    const { blob, missing } = await exportBackup(records, state.preferences, file => readAttachment(file, connection));
    if (task !== utilityTask) return;
    output.replaceChildren(button("下载 ZIP", () => saveBlob(blob, `一隅备份-${new Date().toISOString().slice(0, 10)}.zip`)));
    feedback.textContent = `已备份 ${records.length} 条记录。${missing ? ` 有 ${missing} 个附件只备份了文件信息。` : ""}`;
  }));
  const importButton = button("选择 ZIP 备份", () => picker.click());
  const output = element("div", "action-choices");
  picker.addEventListener("change", () => {
    const file = picker.files[0];
    picker.value = "";
    if (!file) return;
    output.replaceChildren();
    withUtility(importButton, feedback, async () => {
      feedback.textContent = "正在检查备份…";
      const backup = await inspectBackup(file);
      if (task !== utilityTask) return;
      const existingIds = currentRows();
      const additions = backup.records.filter(row => !existingIds.has(row.id)).length;
      feedback.textContent = `备份有 ${backup.records.length} 条记录，其中 ${additions} 条可新增。已有记录会保留。`;
      const restore = button("确认恢复", () => withUtility(restore, feedback, async () => {
        await workspaceReady;
        const rows = currentRows();
        const repairs = [];
        const edits = [];
        const pins = new Set(state.preferences.pins ?? []);
        const reminders = { ...state.preferences.reminders };
        for (const [index, row] of backup.records.entries()) {
          const existing = rows.get(row.id);
          if (existing?.payload.deleted) continue;
          const attachments = row.files.map(({ id, name, mime, size, position }) => ({ id, name, mime, size, position }));
          if (!existing) {
            edits.push([row.id, () => ({
              created: row.created, content: row.text ?? null, type: row.type, favorite: Boolean(row.favorite),
              group: typeof row.favoriteGroup === "string" ? row.favoriteGroup.slice(0, 32) : null,
              quote_id: typeof row.quotedId === "string" ? row.quotedId.slice(0, 128) : null,
              quote_text: typeof row.quotedText === "string" ? row.quotedText.slice(0, 240) : null,
              links: Array.isArray(row.links) ? row.links.filter(link => typeof link?.id === "string" && link.id.length <= 128 &&
                typeof link.summary === "string" && link.id !== row.id).slice(0, 200)
                .map((link, position) => ({ id: link.id, summary: link.summary.slice(0, 240), position })) : [],
              attachments,
            })]);
            if (row.pinned) pins.add(row.id);
            if (Number.isSafeInteger(row.reminderAt) && row.reminderAt > Date.now() && !row.reminderDelivered) reminders[row.id] = row.reminderAt;
          }
          for (const [fileIndex, entry] of row.files.entries()) {
            if (!entry.stored || await readWorkspace("files", currentScope, entry.id)) continue;
            if (existing && !existing.payload.attachments?.some(item => item.id === entry.id && item.size === entry.size)) continue;
            const blob = await backup.read(`attachments/${index}/${fileIndex}`, entry.size);
            if (blob.size !== entry.size) throw new Error("备份附件大小与记录不一致，恢复已取消。");
            repairs.push({ id: entry.id, blob, pending: !!connection && blob.size <= 50_000_000 });
          }
        }
        if (task !== utilityTask || state.connection !== connection) return;
        if (edits.length && !await changeRecords(edits, { files: repairs })) throw new Error("无法写入备份，请重试。");
        if (!edits.length && repairs.length) await writeWorkspace(currentScope, { files: repairs });
        if (edits.length) updatePreferences({ pins: [...pins], reminders });
        if (connection && repairs.length) scheduleSync();
        renderRecords();
        output.replaceChildren();
        feedback.textContent = `已恢复 ${edits.length} 条记录和 ${repairs.length} 个附件。`;
      }), "primary");
      output.append(restore);
    });
  });
  actions.append(download, importButton);
  const task = openUtility("备份与恢复", actions, picker, feedback, output);
}

async function editImage(file, blob) {
  const connection = state.connection;
  const feedback = notice("可在图片上直接画线，修改会另存为新记录。");
  const canvas = element("canvas", "markup-canvas");
  const tools = element("div", "markup-tools");
  const color = element("input");
  color.type = "color";
  color.value = "#e53935";
  color.setAttribute("aria-label", "画笔颜色");
  const task = openUtility("图片标注", feedback, canvas, tools);
  try {
    const image = await createImageBitmap(blob);
    if (task !== utilityTask) { image.close(); return; }
    const ratio = Math.min(1, 1600 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    const history = [];
    const checkpoint = () => {
      history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (history.length > 4) history.shift();
    };
    tools.append(color, button("撤销", () => {
      const previous = history.pop();
      if (!previous) return;
      canvas.width = previous.width;
      canvas.height = previous.height;
      ctx.putImageData(previous, 0, 0);
    }), button("顺时针旋转", () => {
      checkpoint();
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d").drawImage(canvas, 0, 0);
      canvas.width = copy.height;
      canvas.height = copy.width;
      ctx.setTransform(0, 1, -1, 0, canvas.width, 0);
      ctx.drawImage(copy, 0, 0);
      ctx.resetTransform();
    }));
    canvas.addEventListener("pointerdown", event => {
      if (canvas.hasPointerCapture(event.pointerId)) return;
      checkpoint();
      canvas.setPointerCapture(event.pointerId);
      ctx.beginPath();
      ctx.moveTo(event.offsetX / canvas.clientWidth * canvas.width, event.offsetY / canvas.clientHeight * canvas.height);
    });
    canvas.addEventListener("pointermove", event => {
      if (!canvas.hasPointerCapture(event.pointerId)) return;
      ctx.strokeStyle = color.value;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, canvas.width / 180);
      ctx.lineTo(event.offsetX / canvas.clientWidth * canvas.width, event.offsetY / canvas.clientHeight * canvas.height);
      ctx.stroke();
    });
    const save = button("保存为新记录", () => withUtility(save, feedback, async () => {
      const result = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!result) throw new Error("无法生成标注图片。");
      if (task !== utilityTask || state.connection !== connection) return;
      const edited = new File([result], `${file.name.replace(/\.[^.]+$/, "")}-标注.png`, { type: "image/png" });
      const { files, attachments } = prepareFiles([edited]);
      if (await changeRecords([[crypto.randomUUID(), previous => ({ ...previous, type: "IMAGE", attachments })]], { files })) {
        fields.utility.close();
        fields.attachment.close();
        clearFilters();
        selectFilter("all");
      }
    }), "primary");
    tools.append(save);
  } catch { if (task === utilityTask) feedback.textContent = "浏览器无法编辑这种图片。"; }
}

function loginError(message) {
  const feedback = byId("login-error");
  feedback.classList.add("feedback");
  feedback.hidden = false;
  feedback.textContent = message;
}

fields.login.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = byId("login-submit");
  const register = byId("register-submit");
  if (submit.disabled) return;
  const creating = event.submitter === register;
  const { project, key, email, password } = fields.login.elements;
  byId("login-error").hidden = true;
  submit.disabled = register.disabled = true;
  if (creating) register.textContent = "正在注册…";
  else submit.textContent = "正在登录…";
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
    const api = new SupabaseRecords(config);
    const session = creating ? await api.register(email.value.trim(), password.value)
      : await api.login(email.value.trim(), password.value);
    password.value = "";
    if (!session) {
      const feedback = byId("login-error");
      feedback.hidden = false;
      feedback.classList.remove("feedback");
      feedback.textContent = "请先在邮箱完成验证，然后回来登录。";
      return;
    }
    beginConnection(config, session);
    fields.connection.close();
    await syncNow();
  } catch (error) {
    if (!fields.connection.open) openConnection();
    loginError(error.message || (creating ? "注册失败，请重试。" : "登录失败，请重试。"));
  } finally {
    submit.disabled = register.disabled = false;
    submit.textContent = "登录并同步";
    register.textContent = "注册账号";
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
fields.scroll.addEventListener("pointerdown", event => {
  if (!state.selection || !event.target.matches(".record-check") || event.button !== 0) return;
  selectionDrag = { pointer: event.pointerId, start: event.clientY, x: event.clientX,
    first: event.target, set: !event.target.checked, seen: new Set() };
});
fields.scroll.addEventListener("pointermove", event => {
  const drag = selectionDrag;
  if (!drag || drag.pointer !== event.pointerId || !state.selection) return;
  if (!drag.active && Math.hypot(event.clientY - drag.start, event.clientX - drag.x) < 8) return;
  if (!drag.active) { drag.active = true; fields.scroll.setPointerCapture(event.pointerId); }
  const article = document.elementFromPoint(event.clientX, event.clientY)?.closest(".row");
  for (const row of [drag.first.closest(".row"), article]) {
    const check = row?.querySelector(".record-check");
    if (!check || drag.seen.has(row.id)) continue;
    drag.seen.add(row.id);
    check.checked = drag.set;
    toggleSelection(row.id.slice(7), drag.set, row);
  }
});
for (const eventName of ["pointerup", "pointercancel"]) {
  window.addEventListener(eventName, event => {
    if (selectionDrag?.pointer === event.pointerId) selectionDrag = null;
  });
}
fields.search.addEventListener("input", () => { fields.scroll.scrollTop = 0; renderRecords(); });
fields.draft.addEventListener("input", updateComposer);
fields.draft.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) fields.composer.requestSubmit();
});
fields.composer.addEventListener("submit", async event => {
  event.preventDefault();
  await saveDraft();
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
byId("delete").addEventListener("click", () => showDelete([state.selected]));
byId("confirm-delete").addEventListener("click", () => deleteRecords(state.deleteIds));
byId("undo-delete").addEventListener("click", () => restoreRecords(state.lastDeletion));
byId("quote").addEventListener("click", () => {
  const row = currentRecord();
  if (!row) return;
  state.quote = { id: row.record_id, summary: recordSummary(row.payload) };
  fields.actions.close();
  leaveSelection();
  fields.draft.focus();
});
byId("relation").addEventListener("click", () => {
  const row = currentRecord();
  if (row) showRelations(row);
});
byId("pin").addEventListener("click", () => {
  const row = currentRecord();
  if (!row) return;
  const pins = new Set(state.preferences.pins ?? []);
  if (pins.has(row.record_id)) pins.delete(row.record_id);
  else pins.add(row.record_id);
  try {
    updatePreferences({ pins: [...pins] });
    fields.actions.close();
    renderPins(currentRows());
  } catch { showStatus("无法保存本机置顶。", "warn"); }
});
byId("favorite-group").addEventListener("click", () => {
  const row = currentRecord();
  if (!row) return;
  const input = element("input");
  input.maxLength = 32;
  input.value = row.payload.group ?? "";
  input.placeholder = "留空为未分组";
  const groups = new Set(activeRows().map(item => item.payload.group).filter(Boolean));
  const options = element("datalist");
  options.id = "existing-groups";
  options.append(...[...groups].map(group => new Option(group, group)));
  input.setAttribute("list", options.id);
  actionForm("收藏分组", [labelled("分组名称", input), options], "保存到收藏", () => changeRecord(row.record_id,
    previous => ({ ...previous, favorite: true, group: input.value.trim() || null })));
});
byId("copy-record").addEventListener("click", async () => {
  const text = currentRecord()?.payload.content;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    fields.actions.close();
    showStatus("已复制正文", "ok");
  } catch { showStatus("请选中文字后使用浏览器的复制功能。", "warn"); }
});
byId("share-record").addEventListener("click", async () => {
  const row = currentRecord();
  if (!row) return;
  try {
    const message = await shareText(row.payload.content || recordSummary(row.payload));
    fields.actions.close();
    showStatus(message, "ok");
  } catch (error) { if (error.name !== "AbortError") showStatus("浏览器未能完成分享。", "warn"); }
});
byId("record-info").addEventListener("click", () => {
  const row = currentRecord();
  if (!row) return;
  fields.actions.close();
  const incoming = activeRows().filter(record => record.payload.quote_id === row.record_id ||
    record.payload.links?.some(link => link.id === row.record_id));
  const nodes = [
    notice(`创建于 ${new Date(row.payload.created).toLocaleString("zh-CN")}`),
    notice(`修改于 ${new Date(row.updated_at_ms).toLocaleString("zh-CN")}`),
    notice(`${row.payload.content?.length ?? 0} 字 · ${row.payload.attachments?.length ?? 0} 个附件`),
  ];
  if (incoming.length) {
    nodes.push(notice("引用或关联此记录"));
    for (const record of incoming) nodes.push(button(recordSummary(record.payload), () => {
      fields.utility.close(); locate(record.record_id);
    }));
  }
  openUtility("记录详情", ...nodes);
});
byId("remind-record").addEventListener("click", () => {
  const row = currentRecord();
  if (row) editReminder(row);
});
for (const id of ["filter-date", "filter-kind", "filter-group"]) {
  byId(id).addEventListener("change", () => { fields.scroll.scrollTop = 0; renderRecords(); });
}
byId("clear-filters").addEventListener("click", clearFilters);
byId("selection-start").addEventListener("click", () => { state.selection = new Set(); renderRecords(); });
byId("select-record").addEventListener("click", () => {
  const row = currentRecord();
  if (!row) return;
  if (!state.selection) state.selection = new Set();
  state.selection.add(row.record_id);
  fields.actions.close();
  renderRecords();
});
byId("selection-exit").addEventListener("click", leaveSelection);
byId("selection-all").addEventListener("click", () => {
  const ids = state.visible.map(row => row.record_id);
  if (ids.every(id => state.selection.has(id))) ids.forEach(id => state.selection.delete(id));
  else ids.forEach(id => state.selection.add(id));
  renderRecords();
});
byId("selection-delete").addEventListener("click", () => showDelete(selectedRows().map(row => row.record_id)));
byId("selection-merge").addEventListener("click", () => mergeRecords(selectedRows()));
byId("selection-export").addEventListener("click", () => showLongExport(selectedRows()));
byId("selection-ai").addEventListener("click", () => showAi(selectedRows()));
byId("add-files").addEventListener("click", () => byId("pick-files").click());
byId("pick-files").addEventListener("change", event => {
  stageFiles(event.target.files);
  event.target.value = "";
});
fields.draft.addEventListener("paste", event => {
  if (event.clipboardData?.files.length) { event.preventDefault(); stageFiles(event.clipboardData.files); }
});
fields.composer.addEventListener("dragover", event => {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault();
});
fields.composer.addEventListener("drop", event => {
  if (event.dataTransfer.files.length) { event.preventDefault(); stageFiles(event.dataTransfer.files); }
});
byId("record-voice").addEventListener("click", async () => {
  if (recording) { recording.stop(); return; }
  const control = byId("record-voice");
  const connection = state.connection;
  control.disabled = true;
  try {
    const started = await startRecording(file => {
      recording = null;
      control.classList.remove("recording");
      control.setAttribute("aria-label", "录音");
      if (file && state.connection === connection) stageFiles([file]);
      if (state.connection === connection) showStatus(file ? "录音已加入草稿" : "录音已取消");
      if (fields.utility.open && byId("utility-title").textContent === "正在录音") fields.utility.close();
    });
    if (state.connection !== connection) { started.stop(true); return; }
    recording = started;
    control.classList.add("recording");
    control.setAttribute("aria-label", "结束录音");
    const stop = button("结束录音", () => recording?.stop(), "primary");
    const discard = button("取消录音", () => recording?.stop(true));
    openUtility("正在录音", notice("录音最长 1 分钟。结束后会加入草稿。"), stop, discard);
  } catch { showStatus("无法录音，请检查浏览器的麦克风权限。", "warn"); }
  finally { control.disabled = false; }
});
fields.utility.addEventListener("close", () => {
  if (fields.utility.open) return;
  utilityTask = null;
  if (recording) recording.stop(true);
});
byId("settings-open").addEventListener("click", () => fields.settings.showModal());
byId("theme").addEventListener("change", event => {
  setTheme(event.target.value);
  try { putPreferences("appearance", { theme: event.target.value }); } catch { /* Current page retains the theme. */ }
});
byId("trash-open").addEventListener("click", showTrash);
byId("reminders-open").addEventListener("click", showReminders);
byId("backup-open").addEventListener("click", showBackup);
byId("ai-open").addEventListener("click", showAiSettings);
byId("about-open").addEventListener("click", () => openUtility("关于一隅", notice("一隅网页版"), notice("用来随手记录文字、文件和想法。")));
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
setInterval(() => { try { checkReminders(); } catch { /* Browser storage can be unavailable. */ } }, 5000);

setTheme(getPreferences("appearance").theme ?? "system");
const previous = loadSession();
if (previous) {
  beginConnection(previous.config, previous.session);
  syncNow();
} else {
  switchWorkspace();
  updateConnection();
  workspaceReady = loadWorkspace(null);
}

async function intakeLaunch() {
  const address = new URL(location.href);
  const params = address.searchParams;
  const staged = params.get("share");
  const at = params.get("at");
  if (/^[0-9a-f-]{36}$/.test(staged || "") && /^\d{13}$/.test(at || "")) {
    await workspaceReady;
    const queue = await caches.open("yinu-web-incoming");
    const key = new URL(`./receive-share?share=${staged}&at=${at}`, address);
    const payload = await queue.match(key);
    if (payload) {
      const form = await payload.formData();
      fields.draft.value = [...new Set(["text", "url", "title"].map(name => form.get(name)).filter(Boolean))].join("\n").slice(0, 12000);
      stageFiles(form.getAll("files").filter(file => file instanceof File));
      await queue.delete(key);
      fields.draft.focus();
      showStatus("已接收分享，可以编辑后保存");
    }
  } else if (params.has("share-error")) {
    showStatus("无法接收分享。单次最多 20 个附件、合计 50 MB。", "warn");
  } else if (params.get("capture") === "text") {
    await workspaceReady;
    fields.draft.focus();
  } else if (params.get("capture") === "files") {
    await workspaceReady;
    showStatus("点击加号选择要保存的文件");
    byId("add-files").focus();
  } else if (params.has("locate")) {
    await workspaceReady;
    locate(params.get("locate"));
  }
  for (const key of ["share", "at", "share-error", "capture", "locate"]) params.delete(key);
  if (address.href !== location.href) history.replaceState(null, "", address);
}

if (navigator.serviceWorker && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", event => {
    if (typeof event.data?.recordId === "string") locate(event.data.recordId);
  });
}
intakeLaunch().catch(() => showStatus("暂时无法读取分享内容。", "warn"));
