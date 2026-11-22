import {open} from "node:fs/promises";
import {inflateRawSync} from "node:zlib";

export interface Entry {name: string; size: number; compressed: number; method: number; offset: number; attributes: number}

/** Read only the central directory and explicitly selected files. */
export async function archive<T>(path: string, use: (entries: Entry[], read: (entry: Entry, limit: number) => Promise<Buffer>) => Promise<T>) {
  const file = await open(path);
  try {
    const {size} = await file.stat();
    async function bytes(offset: number, length: number) {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error("ZIP com intervalo inválido.");
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const read = await file.read(buffer, done, length - done, offset + done);
        if (read.bytesRead === 0) throw new Error("ZIP truncado.");
        done += read.bytesRead;
      }
      return buffer;
    }
    const tail = await bytes(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 ||
      tail.readUInt16LE(end + 20) !== tail.length - end - 22)) end--;
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("ZIP inválido.");
    let total = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
    if (total === 65535 || length === 0xffffffff || start === 0xffffffff) {
      const locator = await bytes(size - tail.length + end - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error("Localizador ZIP64 inválido.");
      const eocd = await bytes(Number(locator.readBigUInt64LE(8)), 56);
      if (eocd.readUInt32LE(0) !== 0x06064b50 || eocd.readUInt32LE(16) || eocd.readUInt32LE(20)) {
        throw new Error("ZIP64 inválido.");
      }
      total = Number(eocd.readBigUInt64LE(32));
      length = Number(eocd.readBigUInt64LE(40));
      start = Number(eocd.readBigUInt64LE(48));
    }
    if (total > 250_000 || length > 48 * 1024 ** 2) throw new Error("Índice ZIP acima do limite.");
    const directory = await bytes(start, length);
    const entries: Entry[] = [];
    for (let offset = 0; entries.length < total;) {
      if (offset + 46 > length || directory.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("Índice ZIP inválido.");
      }
      const nameSize = directory.readUInt16LE(offset + 28);
      const nameStart = offset + 46;
      const next = nameStart + nameSize + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
      if (next > length) throw new Error("Nome ZIP inválido.");
      entries.push({
        name: directory.toString("utf8", nameStart, nameStart + nameSize),
        size: directory.readUInt32LE(offset + 24), compressed: directory.readUInt32LE(offset + 20),
        method: directory.readUInt16LE(offset + 10), offset: directory.readUInt32LE(offset + 42),
        attributes: directory.readUInt32LE(offset + 38),
      });
      offset = next;
    }
    return await use(entries, async (entry, limit) => {
      if (entry.size > limit || entry.compressed > limit + 64 * 1024) throw new Error("Arquivo acima do limite.");
      const header = await bytes(entry.offset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50 || (header.readUInt16LE(6) & 1)) {
        throw new Error("Entrada ZIP inválida ou criptografada.");
      }
      const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const raw = await bytes(start, entry.compressed);
      if (entry.method !== 0 && entry.method !== 8) throw new Error("Compressão ZIP incompatível.");
      const data = entry.method === 0 ? raw : inflateRawSync(raw, {maxOutputLength: limit});
      if (data.length !== entry.size) throw new Error("Entrada ZIP truncada.");
      return data;
    });
  } finally { await file.close(); }
}
