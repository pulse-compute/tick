// Proof-only host recipe; not a package export. No credential discovery, retries or logs.
const encode = (value) => new TextEncoder().encode(value);
const hex = (value) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
const hash = async (value) => hex(await crypto.subtle.digest('SHA-256', encode(value)));
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encode(value));
}

// Narrow single-chunk GET/PUT signing. The adapter already supplied the encoded path.
export async function signRequest(url, init, credentials, region, nowMs = Date.now()) {
  const target = new URL(url), headers = new Headers(init.headers), method = init.method, body = init.body;
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
    || !['GET', 'PUT'].includes(method) || (body !== undefined && typeof body !== 'string')
    || !/^[A-Za-z0-9]{16,128}$/.test(accessKeyId || '') || typeof secretAccessKey !== 'string'
    || !/^[\x21-\x7e]{16,256}$/.test(secretAccessKey) || !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(region)
    || (sessionToken !== undefined && (typeof sessionToken !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(sessionToken)))) throw new Error('Signing unavailable');
  if (headers.has('authorization') || headers.has('x-amz-date') || headers.has('x-amz-content-sha256')
    || headers.has('x-amz-security-token') || headers.has('host')) throw new Error('Signing unavailable');
  const timestamp = new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, ''), date = timestamp.slice(0, 8);
  const payload = await hash(body ?? '');
  headers.set('host', target.host); headers.set('x-amz-date', timestamp); headers.set('x-amz-content-sha256', payload);
  if (sessionToken !== undefined) headers.set('x-amz-security-token', sessionToken);
  const entries = Array.from(headers.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonical = [method, target.pathname, '', entries.map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, ' ')}\n`).join(''), signedHeaders, payload].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await hash(canonical)}`;
  let key = await hmac(encode('AWS4' + secretAccessKey), date);
  for (const part of [region, 's3', 'aws4_request']) key = await hmac(key, part);
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${hex(await hmac(key, toSign))}`);
  return { ...init, headers, method, ...(body !== undefined ? { body } : {}) };
}

export function createSignedFetch({ credentials, region, fetch: transport, now = () => Date.now() }) {
  return async (url, init) => {
    // Snapshot the exact wire operation before credential loading can yield.
    const captured = { ...init, headers: new Headers(init.headers) };
    return transport(url, await signRequest(url, captured, await credentials(), region, now()));
  };
}
