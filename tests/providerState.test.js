const assert = require('node:assert/strict');
const test = require('node:test');
const { parseProviderState } = require('../out/providerState');
const { providerState } = require('./helpers/providerState');

test('preserves bounded Responses items, original arguments and message phase in order', () => {
  const state = providerState();
  assert.deepEqual(parseProviderState(state), state);
  const withoutOptionalFields = providerState();
  delete withoutOptionalFields.outputItems[1].id;
  delete withoutOptionalFields.outputItems[1].phase;
  delete withoutOptionalFields.outputItems[2].id;
  assert.deepEqual(parseProviderState(withoutOptionalFields), withoutOptionalFields);
});

test('rejects malformed, unsupported and oversized provider continuation data', () => {
  const state = providerState();
  const reasoning = state.outputItems[0];
  const message = state.outputItems[1];
  const call = state.outputItems[2];
  const badItems = [
    { ...reasoning, id: '' },
    { ...reasoning, id: 'x'.repeat(201) },
    { ...reasoning, encrypted_content: 'x'.repeat(1_000_001) },
    { ...reasoning, summary: [{ text: 'Do not expose reasoning' }] },
    { ...reasoning, extra: 'unsupported' },
    { ...call, arguments: 'x'.repeat(1_200_001) },
    { ...call, call_id: 'x'.repeat(121) },
    { ...call, name: '' },
    { ...call, id: null },
    { ...message, role: 'user' },
    { ...message, phase: 'unknown' },
    { ...message, content: Array(9).fill(message.content[0]) },
    { ...message, content: [{ ...message.content[0], text: 'x'.repeat(400_001) }] },
    { ...message, content: [{ ...message.content[0], annotations: [{}] }] },
    { ...message, content: [{ ...message.content[0], extra: 'unsupported' }] },
    { type: 'web_search_call' }
  ];
  const invalid = [
    null, [], {},
    { ...state, endpoint: '' },
    { ...state, endpoint: 'x'.repeat(2049) },
    { ...state, model: 'x'.repeat(121) },
    { ...state, extra: 'unsupported' },
    { ...state, outputItems: Array(17).fill(call) },
    { ...state, outputItems: [
      { ...reasoning, encrypted_content: 'x'.repeat(1_000_000) },
      { ...reasoning, id: 'rs_two', encrypted_content: 'x'.repeat(1_000_000) }
    ] },
    ...badItems.map((item) => ({ ...state, outputItems: [item] }))
  ];
  for (const candidate of invalid) {
    assert.equal(parseProviderState(candidate), undefined);
  }
});
