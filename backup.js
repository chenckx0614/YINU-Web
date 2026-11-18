const limit = 200 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) index = (index >>> 1) ^ (index & 1 ? 0xedb88320 : 0);
  return index;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

async function zip(entries) {
  const data = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  if (entries.length > 65535) throw new Error("备份文件数量过多。");
  for (const [path, blob] of entries) {
    const name = encoder.encode(path);
    const size = blob.size;
    if (offset + size > limit) throw new Error("网页备份单次最多 200 MiB。");
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    data.push(local.buffer, name, blob);
    directory.push(entry.buffer, name);
    offset += 30 + name.length + size;
    directorySize += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...data, ...directory, end.buffer], { type: "application/zip" });
}

async function readZip(blob) {
  const fail = () => new Error("备份 ZIP 有缺损或使用了不支持的格式。");
  if (blob.size > limit) throw new Error("网页恢复单次最多 200 MiB。");
  const tail = new DataView(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  let end = tail.byteLength - 22;
  while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 ||
    end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) end--;
  if (end < 0 || tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) throw fail();
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (offset + size > blob.size || size > 16 * 1024 * 1024) throw fail();
  const directory = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
  const entries = new Map();
  let cursor = 0;
  let unpacked = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size || directory.getUint32(cursor, true) !== 0x02014b50) throw fail();
    const nameStart = cursor + 46;
    const nameEnd = nameStart + directory.getUint16(cursor + 28, true);
    if (nameEnd > size) throw fail();
    const name = decoder.decode(new Uint8Array(directory.buffer, nameStart, nameEnd - nameStart));
    const method = directory.getUint16(cursor + 10, true);
    const length = directory.getUint32(cursor + 20, true);
    const original = directory.getUint32(cursor + 24, true);
    const previous = entries.get(name);
    if (previous || ![0, 8].includes(method) || directory.getUint16(cursor + 8, true) & 1) throw fail();
    unpacked += original;
    if (unpacked > limit) throw new Error("备份解压后超过网页恢复上限。");
    entries.set(name, { method, length, original, start: directory.getUint32(cursor + 42, true), crc: directory.getUint32(cursor + 16, true) });
    cursor = nameEnd + directory.getUint16(cursor + 30, true) + directory.getUint16(cursor + 32, true);
  }
  return async function read(name, bound = limit) {
    const entry = entries.get(name);
    if (!entry || entry.original > bound || entry.start + 30 > offset) throw fail();
    const header = new DataView(await blob.slice(entry.start, entry.start + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) throw fail();
    const data = entry.start + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (data + entry.length > offset) throw fail();
    const source = blob.slice(data, data + entry.length);
    const stream = entry.method === 8 ? source.stream().pipeThrough(new DecompressionStream("deflate-raw")) : source.stream();
    const reader = stream.getReader();
    const bytes = new Uint8Array(entry.original);
    let filled = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (filled + value.length > bytes.length) throw fail();
        bytes.set(value, filled);
        filled += value.length;
      }
    } finally { await reader.cancel(); }
    if (bytes.length !== filled || crc32(bytes) !== entry.crc) throw fail();
    return new Blob([bytes]);
  };
}

export async function exportBackup(rows, preferences, readAttachment) {
  const files = [];
  const records = [];
  let missing = 0;
  let bytes = 0;
  for (const row of rows) {
    const payload = row.payload;
    const record = {
      id: row.record_id, type: payload.type ?? "TEXT", text: payload.content ?? null, created: payload.created,
      updated: row.updated_at_ms, favorite: !!payload.favorite, favoriteGroup: payload.group ?? null,
      pinned: preferences.pins?.includes(row.record_id) ?? false, quotedId: payload.quote_id ?? null,
      quotedText: payload.quote_text ?? null, links: payload.links ?? [], files: [],
    };
    const reminder = preferences.reminders?.[row.record_id];
    if (reminder) record.reminderAt = reminder;
    for (const attachment of payload.attachments ?? []) {
      const blob = await readAttachment(attachment).catch(() => null);
      const stored = !!blob && blob.size === attachment.size;
      if (stored) {
        bytes += blob.size;
        if (bytes > limit) throw new Error("网页备份单次最多 200 MiB。");
        files.push([`attachments/${records.length}/${record.files.length}`, blob]);
      } else missing++;
      record.files.push({ ...attachment, stored });
    }
    records.push(record);
  }
  const manifest = new Blob([JSON.stringify({ format: "yinu-local-backup", version: 2, records })]);
  if (manifest.size > 16 * 1024 * 1024) throw new Error("备份记录过多。");
  return { blob: await zip([["manifest.json", manifest], ...files, ["backup.complete", new Blob()]]), missing };
}

export async function inspectBackup(blob) {
  const read = await readZip(blob);
  const complete = await read("backup.complete", 0);
  if (complete.size) throw new Error("备份没有完整保存。");
  const manifest = JSON.parse(await (await read("manifest.json", 16 * 1024 * 1024)).text());
  if (manifest.format !== "yinu-local-backup" || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.records)) {
    throw new Error("请选择一隅的 ZIP 备份。");
  }
  const ids = new Set();
  const attachmentIds = new Set();
  const validId = id => typeof id === "string" && id.trim() && id.length <= 128;
  const validTime = value => Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
  for (const row of manifest.records) {
    if (!validId(row.id) || ids.has(row.id) || !validTime(row.created) || !validTime(row.updated) ||
        !Array.isArray(row.files) || row.files.length > 2000 || typeof row.type !== "string" ||
        row.text != null && typeof row.text !== "string") throw new Error("备份记录格式有误。");
    ids.add(row.id);
    for (const file of row.files) {
      if (!validId(file.id) || attachmentIds.has(file.id) || !Number.isSafeInteger(file.size) || file.size < 0 ||
          typeof file.name !== "string" || typeof file.mime !== "string" || !Number.isInteger(file.position)) {
        throw new Error("备份附件信息有误。");
      }
      attachmentIds.add(file.id);
    }
  }
  return { records: manifest.records, read };
}
