// Read only the main document part. Word formatting and embedded objects are omitted.
export async function readDocxText(blob) {
  const limit = 5 * 1024 * 1024;
  const tail = new DataView(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  let end = tail.byteLength - 22;
  while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 ||
    end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) end--;
  if (end < 0) throw new Error("Invalid DOCX package");
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (size > limit || offset + size > blob.size) throw new Error("Invalid ZIP directory");
  const directory = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
  const decoder = new TextDecoder();
  for (let cursor = 0, entry = 0; entry < count && cursor + 46 <= size; entry++) {
    if (directory.getUint32(cursor, true) !== 0x02014b50) break;
    const nameLength = directory.getUint16(cursor + 28, true);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > size) break;
    const name = decoder.decode(new Uint8Array(directory.buffer, cursor + 46, nameLength));
    if (name === "word/document.xml") {
      const length = directory.getUint32(cursor + 20, true);
      const start = directory.getUint32(cursor + 42, true);
      const method = directory.getUint16(cursor + 10, true);
      if (length > limit || directory.getUint32(cursor + 24, true) > limit || start + 30 > blob.size) break;
      const local = new DataView(await blob.slice(start, start + 30).arrayBuffer());
      if (local.getUint32(0, true) !== 0x04034b50) break;
      const data = start + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      if (data + length > blob.size || ![0, 8].includes(method)) break;
      const source = blob.slice(data, data + length);
      const stream = method === 8 ? source.stream().pipeThrough(new DecompressionStream("deflate-raw")) : source.stream();
      const reader = stream.getReader();
      let text = "";
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limit) throw new Error("Document XML too large");
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }
      const xml = new DOMParser().parseFromString(text + decoder.decode(), "application/xml");
      const ns = xml.documentElement.namespaceURI;
      if (xml.documentElement.localName !== "document") break;
      return Array.from(xml.getElementsByTagNameNS(ns, "p"), paragraph =>
        Array.from(paragraph.getElementsByTagNameNS(ns, "t"), node => node.textContent).join("")).join("\n");
    }
    cursor = nameEnd + directory.getUint16(cursor + 30, true) + directory.getUint16(cursor + 32, true);
  }
  throw new Error("Cannot read Word document");
}
