export function readBigUintLE(
    buf: Buffer,
    offset: number,
    length: number
  ): number {
    switch (length) {
      case 1:
        return buf.readUint8(offset);
      case 2:
        return buf.readUint16LE(offset);
      case 4:
        return buf.readUint32LE(offset);
      case 8:
        return Number(buf.readBigUint64LE(offset));
    }
    throw new Error(`unsupported data size (${length} bytes)`);
  }