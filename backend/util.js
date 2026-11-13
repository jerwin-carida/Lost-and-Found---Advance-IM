export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Postgres returns lowercase column names; map the ones the API exposes back to camelCase.
const NAMES = ['userId', 'roleId', 'userRole', 'itemId', 'requestId', 'transactionId',
  'reportedAt', 'changedAt', 'proposedSchedule', 'submittedAt', 'handledBy'];
const MAP = Object.fromEntries(NAMES.map((n) => [n.toLowerCase(), n]));
export const camel = (row) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [MAP[k] ?? k, v]));

export const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export function int(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid number.');
  return n;
}

// ---------- Item descriptions ----------
// Descriptions are built as "<size> <color> <item>", e.g. "Small blue water bottle".
// This follows the English adjective order: size comes before color, and both come before the noun.
export const ITEM_SIZES = ['Small', 'Medium', 'Large', 'Extra large', 'Not applicable'];
export const ITEM_COLORS = ['Black', 'White', 'Gray', 'Silver', 'Red', 'Orange', 'Yellow', 'Green', 'Blue',
  'Purple', 'Pink', 'Brown', 'Beige', 'Gold', 'Multicolor', 'Unknown'];
const SKIPPED = new Set(['Not applicable', 'Unknown']);   // chosen, but left out of the sentence

export function buildDescription(b = {}) {
  const size = String(b.size ?? '').trim();
  const color = String(b.color ?? '').trim();
  if (!ITEM_SIZES.includes(size)) throw new HttpError(400, 'Choose a size.');
  if (!ITEM_COLORS.includes(color)) throw new HttpError(400, 'Choose a color.');

  // The item is one token with underscores in place of spaces, e.g. "water_bottle".
  const raw = clean(b.item, 100);
  if (!raw) throw new HttpError(400, 'Enter the item, for example "water_bottle".');
  if (!/^[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*$/.test(raw)) {
    throw new HttpError(400, 'Use letters, numbers and - only, with _ between words (no spaces), e.g. "water_bottle".');
  }
  let item = raw.split('_').join(' ');

  const adjectives = [];
  if (!SKIPPED.has(size)) adjectives.push(size.toLowerCase());
  if (!SKIPPED.has(color)) adjectives.push(color.toLowerCase());

  // If the item repeats a chosen adjective ("blue bottle" with Blue), drop the repeat.
  const repeats = new Set(adjectives.flatMap((a) => a.split(' ')));
  const words = item.split(' ');
  while (words.length > 1 && repeats.has(words[0].toLowerCase())) words.shift();
  item = words.join(' ');

  // Lowercase the noun after the adjectives, but keep acronyms like "USB" as typed.
  const noun = adjectives.length && !/^[A-Z]{2,}/.test(item) ? item[0].toLowerCase() + item.slice(1) : item;
  const text = [...adjectives, noun].join(' ');
  return text[0].toUpperCase() + text.slice(1);
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Postgres returns lowercase column names; map the ones the API exposes back to camelCase.
const NAMES = ['userId', 'roleId', 'userRole', 'itemId', 'requestId', 'transactionId',
  'reportedAt', 'changedAt', 'proposedSchedule', 'submittedAt', 'handledBy'];
const MAP = Object.fromEntries(NAMES.map((n) => [n.toLowerCase(), n]));
export const camel = (row) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [MAP[k] ?? k, v]));

export const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export function int(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid number.');
  return n;
}

// ---------- Item descriptions ----------
// Descriptions are built as "<size> <color> <item>", e.g. "Small blue water bottle".
// This follows the English adjective order: size comes before color, and both come before the noun.
export const ITEM_SIZES = ['Small', 'Medium', 'Large', 'Extra large', 'Not applicable'];
export const ITEM_COLORS = ['Black', 'White', 'Gray', 'Silver', 'Red', 'Orange', 'Yellow', 'Green', 'Blue',
  'Purple', 'Pink', 'Brown', 'Beige', 'Gold', 'Multicolor', 'Unknown'];
const SKIPPED = new Set(['Not applicable', 'Unknown']);   // chosen, but left out of the sentence

export function buildDescription(b = {}) {
  const size = String(b.size ?? '').trim();
  const color = String(b.color ?? '').trim();
  if (!ITEM_SIZES.includes(size)) throw new HttpError(400, 'Choose a size.');
  if (!ITEM_COLORS.includes(color)) throw new HttpError(400, 'Choose a color.');

  // The item is one token with underscores in place of spaces, e.g. "water_bottle".
  const raw = clean(b.item, 100);
  if (!raw) throw new HttpError(400, 'Enter the item, for example "water_bottle".');
  if (!/^[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*$/.test(raw)) {
    throw new HttpError(400, 'Use letters, numbers and - only, with _ between words (no spaces), e.g. "water_bottle".');
  }
  let item = raw.split('_').join(' ');

  const adjectives = [];
  if (!SKIPPED.has(size)) adjectives.push(size.toLowerCase());
  if (!SKIPPED.has(color)) adjectives.push(color.toLowerCase());

  // If the item repeats a chosen adjective ("blue bottle" with Blue), drop the repeat.
  const repeats = new Set(adjectives.flatMap((a) => a.split(' ')));
  const words = item.split(' ');
  while (words.length > 1 && repeats.has(words[0].toLowerCase())) words.shift();
  item = words.join(' ');

  // Lowercase the noun after the adjectives, but keep acronyms like "USB" as typed.
  const noun = adjectives.length && !/^[A-Z]{2,}/.test(item) ? item[0].toLowerCase() + item.slice(1) : item;
  const text = [...adjectives, noun].join(' ');
  return text[0].toUpperCase() + text.slice(1);
}
