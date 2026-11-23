// Normalization version 1: NFKC, lower case, strip diacritics and most punctuation, collapse space.
// Artist aliases also drop a leading "the ".
export const NORM_VERSION = 1;

function stripDiacritics(s) {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

export function normalizeText(s) {
  if (s == null) return '';
  let t = stripDiacritics(String(s)).normalize('NFKC').toLowerCase();
  t = t.replace(/&/g, ' and ');
  t = t.replace(/['’]/g, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function normalizeTitle(s) {
  return normalizeText(s);
}

export function normalizeArtist(s) {
  let t = normalizeText(s);
  if (t.startsWith('the ')) t = t.slice(4);
  return t;
}

export function normalizeMsid(s) {
  if (s == null || s === '') return null;
  return String(s).trim().toLowerCase();
}

export function normalizeMbid(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (!t) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return t;
  return t;
}

export function normalizeIsrc(s) {
  if (s == null) return null;
  const t = String(s).trim().toUpperCase().replace(/[\s-]/g, '');
  return t || null;
}
