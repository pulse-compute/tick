// Application-owned, narrow host recipe. Not a Tick package export or credential resolver.
import type { S3Options } from '@pulse-compute/tick/adapters/s3';
export interface AwsCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
const encode = (value: string) => new TextEncoder().encode(value);
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
const hash = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encode(value)));
async function hmac(key: BufferSource, value: string) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encode(value));
}
export async function signRequest(url: string, init: RequestInit, credentials: AwsCredentials, region: string, nowMs = Date.now()): Promise<RequestInit> {
  const target = new URL(url), headers = new Headers(init.headers), method = init.method, body = init.body;
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
    || !['GET', 'PUT'].includes(method ?? '') || (body !== undefined && typeof body !== 'string')
    || !/^[A-Za-z0-9]{16,128}$/.test(accessKeyId) || !/^[\x21-\x7e]{16,256}$/.test(secretAccessKey)
    || !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(region)
    || (sessionToken !== undefined && !/^[\x21-\x7e]{1,16384}$/.test(sessionToken))) throw new Error('Signing unavailable');
  if (['authorization', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token', 'host'].some((name) => headers.has(name))) throw new Error('Signing unavailable');
  const timestamp = new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, ''), date = timestamp.slice(0, 8);
  const payload = await hash((body as string | undefined) ?? '');
  headers.set('host', target.host); headers.set('x-amz-date', timestamp); headers.set('x-amz-content-sha256', payload);
  if (sessionToken !== undefined) headers.set('x-amz-security-token', sessionToken);
  const entries: [string, string][] = [];
  headers.forEach((value, name) => entries.push([name, value]));
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonical = [method, target.pathname, '', entries.map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, ' ')}\n`).join(''), signedHeaders, payload].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`, toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await hash(canonical)}`;
  let key = await hmac(encode('AWS4' + secretAccessKey), date);
  for (const part of [region, 's3', 'aws4_request']) key = await hmac(key, part);
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${hex(await hmac(key, toSign))}`);
  return { ...init, headers };
}
export function createSignedFetch(options: { readonly credentials: () => Promise<AwsCredentials>; readonly region: string; readonly fetch: S3Options['fetch'] }): S3Options['fetch'] {
  const credentials = options.credentials.bind(options), transport = options.fetch.bind(options), region = options.region;
  return async (url, init) => {
    const captured = { ...init, headers: new Headers(init.headers) };
    return transport(url, await signRequest(url, captured, await credentials(), region));
  };
}
