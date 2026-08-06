import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238) sin dependencias externas. Se usa para el código de
// supervisor que autoriza recepcionar sin token validado.

const BASE32_ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += BASE32_ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += BASE32_ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

export function base32Decode(str: string): Buffer {
  const limpio = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const ch of limpio) {
    valor = (valor << 5) | BASE32_ALFABETO.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generarSecretoTotp(): string {
  return base32Encode(randomBytes(20)); // 160 bits, estándar
}

export function codigoTotp(secretoBase32: string, contador: number): string {
  const clave = base32Decode(secretoBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));
  const hmac = createHmac("sha1", clave).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

// Acepta el código de la ventana actual y ±1 (desfase de reloj de 30s).
// Devuelve el contador (time-step) que matcheó, o null si el código es
// inválido — el contador sirve para bloquear el reuso del mismo código.
export function verificarTotpConPaso(secretoBase32: string, codigo: string): number | null {
  const limpio = codigo.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(limpio)) return null;
  const contador = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [0, -1, 1]) {
    const esperado = codigoTotp(secretoBase32, contador + delta);
    if (timingSafeEqual(Buffer.from(esperado), Buffer.from(limpio))) return contador + delta;
  }
  return null;
}

export function verificarTotp(secretoBase32: string, codigo: string): boolean {
  return verificarTotpConPaso(secretoBase32, codigo) !== null;
}

export function otpauthUrl(secretoBase32: string, cuenta: string, emisor: string): string {
  return `otpauth://totp/${encodeURIComponent(emisor)}:${encodeURIComponent(cuenta)}?secret=${secretoBase32}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;
}
