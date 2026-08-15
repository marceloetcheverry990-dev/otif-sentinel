import React, { useRef, useState } from 'react';
import { View, Text, PanResponder, StyleSheet, Pressable, LayoutChangeEvent } from 'react-native';

type Props = {
  onSigned: (dataUrl: string) => void;
  onCancel?: () => void;
};

type Pt = { x: number; y: number };

/** CRC32 + PNG encoder mínimo (RGB, sin compresión zlib real → store) */
function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();
function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n: number) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function chunk(type: string, data: Uint8Array) {
  const typeBytes = Uint8Array.from(type.split('').map((ch) => ch.charCodeAt(0)));
  const len = u32(data.length);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = u32(crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(len, 0);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}
/** zlib store (sin comprimir) de un bloque */
function zlibStore(raw: Uint8Array) {
  const blocks: number[] = [0x78, 0x01]; // zlib header
  let pos = 0;
  while (pos < raw.length) {
    const size = Math.min(65535, raw.length - pos);
    const last = pos + size >= raw.length ? 1 : 0;
    blocks.push(last);
    blocks.push(size & 255, (size >> 8) & 255);
    blocks.push((~size) & 255, ((~size) >> 8) & 255);
    for (let i = 0; i < size; i++) blocks.push(raw[pos + i]);
    pos += size;
  }
  // Adler32
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  blocks.push(...u32(adler));
  return Uint8Array.from(blocks);
}

function strokesToPngDataUrl(width: number, height: number, strokes: Pt[][]) {
  const w = Math.max(32, Math.floor(width));
  const h = Math.max(32, Math.floor(height));
  const rgba = new Uint8Array(w * h * 3);
  rgba.fill(255);
  const setBlack = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = xi + dx;
        const yy = yi + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = (yy * w + xx) * 3;
        rgba[i] = 17;
        rgba[i + 1] = 17;
        rgba[i + 2] = 17;
      }
    }
  };
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      const steps = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        setBlack(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
    }
  }
  // filter byte per row
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = Uint8Array.from([
    ...u32(w),
    ...u32(h),
    8,
    2,
    0,
    0,
    0,
  ]);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibStore(raw)), chunk('IEND', new Uint8Array())];
  let total = 0;
  for (const p of parts) total += p.length;
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  let bin = '';
  for (let i = 0; i < png.length; i++) bin += String.fromCharCode(png[i]);
  const b64 = typeof globalThis.btoa === 'function' ? globalThis.btoa(bin) : Buffer.from(png).toString('base64');
  return `data:image/png;base64,${b64}`;
}

export default function SignaturePad({ onSigned, onCancel }: Props) {
  const [strokes, setStrokes] = useState<Pt[][]>([]);
  const [current, setCurrent] = useState<Pt[]>([]);
  const [size, setSize] = useState({ w: 320, h: 180 });
  const drawing = useRef(false);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ w: width, h: height });
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        drawing.current = true;
        const { locationX, locationY } = evt.nativeEvent;
        setCurrent([{ x: locationX, y: locationY }]);
      },
      onPanResponderMove: (evt) => {
        if (!drawing.current) return;
        const { locationX, locationY } = evt.nativeEvent;
        setCurrent((prev) => [...prev, { x: locationX, y: locationY }]);
      },
      onPanResponderRelease: () => {
        drawing.current = false;
        setStrokes((prev) => (current.length ? [...prev, current] : prev));
        setCurrent([]);
      },
    })
  ).current;

  const clear = () => {
    setStrokes([]);
    setCurrent([]);
  };

  const confirm = () => {
    const all = current.length ? [...strokes, current] : strokes;
    if (!all.length) return;
    onSigned(strokesToPngDataUrl(size.w, size.h, all));
  };

  const dots = [...strokes.flat(), ...current];

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Firma del receptor</Text>
      <View style={styles.pad} onLayout={onLayout} {...pan.panHandlers}>
        {dots.map((p, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={[styles.dot, { left: p.x - 1.5, top: p.y - 1.5 }]}
          />
        ))}
      </View>
      <View style={styles.row}>
        {onCancel ? (
          <Pressable style={[styles.btn, styles.ghost]} onPress={onCancel}>
            <Text style={styles.ghostText}>Cancelar</Text>
          </Pressable>
        ) : null}
        <Pressable style={[styles.btn, styles.ghost]} onPress={clear}>
          <Text style={styles.ghostText}>Borrar</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.primary]} onPress={confirm}>
          <Text style={styles.primaryText}>Usar firma</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, padding: 12 },
  title: { fontWeight: '700', fontSize: 16, color: '#0f172a' },
  pad: {
    height: 180,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  dot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#111',
  },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  ghost: { backgroundColor: '#e2e8f0' },
  ghostText: { color: '#0f172a', fontWeight: '600' },
  primary: { backgroundColor: '#0056D2' },
  primaryText: { color: '#fff', fontWeight: '700' },
});
