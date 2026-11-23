export class DjdbError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'DjdbError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export function errorPayload(e) {
  const out = { error: { code: e?.code || 'internal_error', message: e?.message || String(e) } };
  if (e?.hint) out.error.hint = e.hint;
  return out;
}
