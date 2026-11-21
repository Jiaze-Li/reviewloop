// Test stand-in for a model that honours the adjudication prompt's receipt rule:
// echo every delivery receipt line, in order. `drop`/`mutate` let a test simulate
// a transport that lost part of the prompt.
export const RECEIPT_RE = /⟦RL:\d+:[0-9a-f]{8}⟧/g;

export function receiptsIn(prompt) {
  return String(prompt ?? '').match(RECEIPT_RE) ?? [];
}

export function withReceipts(prompt, value, mutate = (list) => list) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const list = receiptsIn(prompt);
  if (list.length === 0) return value;
  return { ...value, receipts: mutate(list) };
}
