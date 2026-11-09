export const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
export const decode = (value: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
export function equal(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
export async function hash(data: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', buffer(data));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function buffer(data: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(data.byteLength);
  new Uint8Array(output).set(data);
  return output;
}
export function toBase64(data: Uint8Array): string {
  let text = '';
  for (let index = 0; index < data.length; index += 8192) {
    text += String.fromCharCode(...data.subarray(index, index + 8192));
  }
  return btoa(text);
}
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
