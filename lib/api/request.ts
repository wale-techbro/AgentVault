export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return { ok: false, status: 413, error: 'Request body is too large.' };
  if (!request.body) return { ok: false, status: 400, error: 'Request body must be valid JSON.' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'Request body is too large.' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'Request body could not be read.' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try { return { ok: true, value: JSON.parse(text) as unknown }; }
  catch { return { ok: false, status: 400, error: 'Request body must be valid JSON.' }; }
}

export function validIdempotencyKey(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}
