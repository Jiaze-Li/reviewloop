import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSafeAgyEnvelopeMetadata } from '../src/agy/agyErrorEnvelope.js';

test('empty / missing stdout', () => {
  const r = extractSafeAgyEnvelopeMetadata('');
  assert.equal(r.parsed, false);
  assert.deepEqual(r.fields, {});
  assert.equal(r.usageEvidenceState, 'absent');
});

test('non-JSON stdout is never echoed', () => {
  const r = extractSafeAgyEnvelopeMetadata('Here is the answer: the file looks correct and passes.');
  assert.equal(r.parsed, false);
  assert.equal(r.jsonObject, false);
  assert.deepEqual(r.fields, {});
  assert.equal(r.usageEvidenceState, 'unknown');
  assert.match(r.note, /not echoed/);
});

test('extracts whitelisted operational scalars only', () => {
  const stdout = JSON.stringify({
    status: 'error',
    error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'x'.repeat(5000) },
    model: 'gpt-oss-120b-medium',
    response: 'THIS IS GENERATED MODEL TEXT THAT MUST NOT LEAK',
    text: 'also generated text',
    usage: { prompt_tokens: 131072, completion_tokens: 0, nested: { deep: 5 } },
  });
  const r = extractSafeAgyEnvelopeMetadata(stdout);
  assert.equal(r.jsonObject, true);
  assert.equal(r.fields.status, 'error');
  assert.equal(r.fields.code, 'context_length_exceeded');
  assert.equal(r.fields.type, 'invalid_request_error');
  assert.equal(r.fields.model, 'gpt-oss-120b-medium');
  assert.deepEqual(r.fields.usage, { prompt_tokens: 131072, completion_tokens: 0, nested: { deep: 5 } });
  // generated text fields are dropped entirely
  assert.equal('response' in r.fields, false);
  assert.equal('text' in r.fields, false);
  // free-form 'message' is not whitelisted — never echoed
  assert.equal('message' in r.fields, false);
});

test('JSON array stdout is not treated as an envelope', () => {
  const r = extractSafeAgyEnvelopeMetadata('["generated", "text"]');
  assert.equal(r.parsed, true);
  assert.equal(r.jsonObject, false);
  assert.deepEqual(r.fields, {});
});

test('usage object with string values is refused (no text smuggling)', () => {
  const stdout = JSON.stringify({ status: 'ok', usage: { note: 'the answer is 42', prompt_tokens: 10 } });
  const r = extractSafeAgyEnvelopeMetadata(stdout);
  assert.deepEqual(r.fields.usage, { prompt_tokens: 10 });
});


test('nested and unresolved usage is preserved as a content-free evidence state even when fields are dropped', () => {
  const nested = extractSafeAgyEnvelopeMetadata(JSON.stringify({
    error: {
      status: 'UNAUTHENTICATED',
      code: 401,
      usage: { input_tokens: 5 },
    },
  }));
  assert.equal(nested.usageEvidenceState, 'present');
  assert.equal(nested.fields.status, 'UNAUTHENTICATED');
  assert.equal(nested.fields.code, 401);
  assert.equal('usage' in nested.fields, false, 'nested usage need not be copied to mark evidence present');

  const unresolved = extractSafeAgyEnvelopeMetadata(JSON.stringify({
    status: 'UNAUTHENTICATED',
    code: 401,
    usage: 'unknown',
  }));
  assert.equal(unresolved.usageEvidenceState, 'present');
  assert.equal('usage' in unresolved.fields, false, 'string usage remains private/dropped');
});
