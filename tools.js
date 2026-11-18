const extensions = {
  image: /\.(png|jpe?g|gif|webp|avif|bmp|heic)$/i,
  doc: /\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|rtf|odt|epub|json|log)$/i,
  video: /\.(mp4|mkv|mov|webm|avi)$/i,
  audio: /\.(mp3|m4a|ogg|wav|aac|opus|flac)$/i,
  archive: /\.(zip|7z|rar|gz|tar|bz2|xz)$/i,
  apk: /\.(apk|apks|xapk|aab)$/i,
};

export function recordKind(record, kind) {
  if (kind === "link") return record.type === "LINK" || /^https?:\/\/\S+$/i.test(record.content ?? "");
  if (kind === "text") return record.type === "TEXT" && Boolean(record.content);
  return (record.attachments ?? []).some(file => {
    if (file.mime?.startsWith(kind + "/")) return true;
    if ((kind === "video" || kind === "audio") && /^(video|audio)\//.test(file.mime)) return false;
    if (kind === "doc" && /^(text\/|application\/(pdf|msword|vnd\.(openxmlformats|ms-)))/.test(file.mime)) return true;
    return extensions[kind]?.test(file.name) ?? false;
  });
}

export function recordSummary(data) {
  return (data.content?.trim() || data.attachments?.map(file => file.name).join("、") || "记录").slice(0, 240);
}

export function saveBlob(blob, name) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function shareText(text) {
  if (navigator.canShare?.({ text })) { await navigator.share({ text }); return "已分享"; }
  await navigator.clipboard.writeText(text);
  return "已复制，可以粘贴分享";
}

export async function startRecording(finished) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== "function") {
    throw new Error("此浏览器不支持录音。");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let recorder;
  try { recorder = new MediaRecorder(stream); }
  catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  const chunks = [];
  let cancelled = false;
  let timer;
  function stop(discard = false) {
    cancelled ||= discard;
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop();
    stream.getTracks().forEach(track => track.stop());
  }
  recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener("error", () => stop(true), { once: true });
  recorder.addEventListener("stop", () => {
    stop();
    const mime = recorder.mimeType.split(";")[0] || "audio/webm";
    const extension = mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm";
    const file = new File(chunks, `语音-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: mime });
    finished(cancelled || !file.size ? null : file);
  }, { once: true });
  try { recorder.start(); }
  catch (error) { stop(true); throw error; }
  timer = setTimeout(stop, 60000);
  return { stop };
}

export async function exportLongImage(rows, readFile) {
  const width = 720;
  const maxHeight = 3900;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = maxHeight;
  const context = canvas.getContext("2d");
  context.font = "21px system-ui, sans-serif";
  let y = 0;
  const pages = [];
  function nextPage() {
    context.fillStyle = "#f3f4f6";
    context.fillRect(0, 0, width, maxHeight);
    context.fillStyle = "#24354b";
    context.fillText("一隅 · 记录", 36, 50);
    y = 78;
  }
  async function finishPage() {
    if (y === 78) return;
    const trimmed = document.createElement("canvas");
    trimmed.width = width;
    trimmed.height = Math.min(maxHeight, y + 24);
    trimmed.getContext("2d").drawImage(canvas, 0, 0);
    const blob = await new Promise(resolve => trimmed.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("长图生成失败。");
    pages.push(blob);
    nextPage();
  }
  async function drawText(text, color) {
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const character of paragraph + "\n") {
        if (character === "\n" || context.measureText(line + character).width > width - 86) {
          if (y + 34 > maxHeight) await finishPage();
          context.fillStyle = color;
          context.fillText(line, 43, y + 24);
          y += 32;
          line = "";
        }
        if (character !== "\n") line += character;
      }
    }
  }
  nextPage();
  for (const row of rows) {
    const data = row.payload;
    await drawText(new Date(data.created).toLocaleString("zh-CN"), "#5f6f83");
    if (data.content) await drawText(data.content, "#202631");
    if (data.quote_text) await drawText(`引用：${data.quote_text}`, "#5f6f83");
    for (const file of data.attachments ?? []) {
      await drawText(file.name, "#315585");
      if (!/^image\/(jpeg|png|webp|gif|avif|bmp)$/.test(file.mime)) continue;
      const image = await Promise.resolve().then(async () => createImageBitmap(await readFile(file))).catch(() => null);
      if (!image) continue;
      const scale = Math.min(1, (width - 86) / image.width, 560 / image.height);
      const height = image.height * scale;
      if (y + height + 40 > maxHeight) await finishPage();
      context.drawImage(image, 43, y, image.width * scale, height);
      image.close();
      y += height + 12;
    }
    y += 20;
  }
  await finishPage();
  return pages;
}

export function aiAddress(value, task = "chat/completions") {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("请输入 AI 服务的 HTTPS 地址。");
  }
  const base = url.toString().replace(/\/+$/, "");
  return base.endsWith(`/${task}`) ? base : `${base}/${task}`;
}

export async function askAi(config, texts) {
  const content = texts.join("\n\n").trim();
  if (!content || content.length > 12000) throw new Error("请选择含正文的记录，每次最多整理 12,000 字。");
  const response = await fetch(aiAddress(config.url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [
      { role: "system", content: "请用中文整理用户的记录。概括主要内容、待办事项和重要日期。不要编造信息。" },
      { role: "user", content },
    ] }),
  }).catch(() => { throw new Error("无法从浏览器连接 AI 服务。请检查地址，确认服务支持网页跨域请求。"); });
  if (!response.ok) throw new Error(`AI 请求失败（HTTP ${response.status}）。请检查配置。`);
  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("AI 服务没有返回可用正文。");
  return answer.trim().slice(0, 12000);
}

export async function transcribeAudio(config, file) {
  const body = new FormData();
  body.append("model", config.model);
  body.append("file", file, file.name);
  const response = await fetch(aiAddress(config.url, "audio/transcriptions"), {
    method: "POST", redirect: "error", body, signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${config.key}` },
  }).catch(() => { throw new Error("无法连接转写服务，请确认服务支持网页跨域请求。"); });
  if (!response.ok) throw new Error(`转写失败（HTTP ${response.status}）。`);
  const data = await response.json();
  if (typeof data?.text !== "string" || !data.text.trim()) throw new Error("转写服务没有返回文字。");
  return data.text.trim().slice(0, 12000);
}
