import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAgySupervisorModel,
  resolveAgyReviewerModel,
  resolveAgySupervisorFamily,
  resolveAgyReviewerFamily,
  resolveAgyModel,
  resolveAgyOpusModel,
  resolveAgyOpusFamily,
  agyModelLabel,
} from '../src/agy/agyConfig.js';

test('no concrete version pin by default — provider-default resolution', () => {
  assert.equal(resolveAgySupervisorModel({}), null);
  assert.equal(resolveAgyReviewerModel({}), null);
  assert.equal(resolveAgySupervisorFamily({}).resolvedFrom, 'provider_default');
  assert.equal(resolveAgyReviewerFamily({}).resolvedFrom, 'provider_default');
  assert.equal(resolveAgySupervisorFamily({}).concreteVersionPinned, false);
});

test('explicit env override pins a concrete model (Supervisor precedence)', () => {
  assert.equal(resolveAgySupervisorModel({ AGY_MODEL: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  assert.equal(
    resolveAgySupervisorModel({ AGY_MODEL: 'gemini-3.1-pro-high', AGY_GEMINI_SUPERVISOR_MODEL: 'gemini-3.6-flash-low' }),
    'gemini-3.6-flash-low',
  );
  assert.equal(
    resolveAgySupervisorModel({ REVIEWLOOP_GEMINI_SUPERVISOR_MODEL: 'gemini-9.9-flash-high', AGY_GEMINI_SUPERVISOR_MODEL: 'x' }),
    'gemini-9.9-flash-high',
  );
  assert.equal(resolveAgySupervisorModel({ AGY_GEMINI_SUPERVISOR_MODEL: '   ' }), null);
  assert.equal(resolveAgySupervisorFamily({ AGY_MODEL: 'gemini-3.1-pro-high' }).pinnedByEnv, true);
});

test('explicit env override pins a concrete model (Reviewer precedence)', () => {
  assert.equal(resolveAgyReviewerModel({ AGY_MODEL: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  assert.equal(
    resolveAgyReviewerModel({ AGY_MODEL: 'gemini-3.1-pro-high', AGY_GEMINI_REVIEWER_MODEL: 'gemini-3.6-flash-low' }),
    'gemini-3.6-flash-low',
  );
});

test('runtime catalog resolves the newest family entry at the role-fixed effort', () => {
  const agyCatalog = [
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  ];
  // Supervisor head is fixed to -medium, Reviewer head to -low.
  assert.equal(resolveAgySupervisorModel({}, { agyCatalog }), 'gemini-3.8-flash-medium');
  assert.equal(resolveAgyReviewerModel({}, { agyCatalog }), 'gemini-3.8-flash-low');
  assert.equal(resolveAgySupervisorFamily({}, { agyCatalog }).resolvedFrom, 'runtime_catalog');

  // a newer catalog -> a different concrete model, still zero config edits
  const newer = [...agyCatalog, 'gemini-4.1-flash-medium', 'gemini-4.1-flash-low'];
  assert.equal(resolveAgySupervisorModel({}, { agyCatalog: newer }), 'gemini-4.1-flash-medium');
  assert.equal(resolveAgyReviewerModel({}, { agyCatalog: newer }), 'gemini-4.1-flash-low');
});

test('per-role vars are independent of each other', () => {
  const env = { AGY_GEMINI_SUPERVISOR_MODEL: 'gemini-3.5-flash-medium', AGY_GEMINI_REVIEWER_MODEL: 'gemini-3.5-flash-low' };
  assert.equal(resolveAgySupervisorModel(env), 'gemini-3.5-flash-medium');
  assert.equal(resolveAgyReviewerModel(env), 'gemini-3.5-flash-low');
});

test('resolveAgyOpus* resolves AGY Claude Opus dynamically from the catalog, never pinned by default', () => {
  assert.equal(resolveAgyOpusModel({}), null);
  assert.equal(resolveAgyOpusFamily({}).resolvedFrom, 'provider_default');
  assert.equal(resolveAgyOpusFamily({}).concreteVersionPinned, false);
  assert.equal(resolveAgyOpusFamily({}).provider, 'agy-claude-gpt');
  const cat = ['claude-opus-4-6', 'claude-opus-5-0', 'claude-sonnet-4-6'];
  assert.equal(resolveAgyOpusModel({}, { agyCatalog: cat }), 'claude-opus-5-0');
  const effortCat = ['claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high'];
  assert.equal(resolveAgyOpusModel({}, { agyCatalog: effortCat }), 'claude-opus-5-5-medium');
  assert.equal(resolveAgyOpusFamily({}, { agyCatalog: cat }).resolvedFrom, 'runtime_catalog');
  assert.equal(resolveAgyOpusModel({ REVIEWLOOP_AGY_OPUS_MODEL: 'claude-opus-4-6' }, { agyCatalog: cat }), 'claude-opus-4-6');
});

test('resolveAgyModel is an AGY_MODEL-only shared fallback (null otherwise)', () => {
  assert.equal(resolveAgyModel({}), null);
  assert.equal(resolveAgyModel({ AGY_MODEL: 'gemini-3.6-flash-medium' }), 'gemini-3.6-flash-medium');
});

test('agyModelLabel prettifies an id', () => {
  assert.equal(agyModelLabel('gemini-3.7-flash-high'), 'Gemini 3.7 Flash High');
  assert.equal(agyModelLabel(''), '(unknown model)');
});
