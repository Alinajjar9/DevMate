const assert = require('node:assert/strict');
const test = require('node:test');

const {
  emptyResponseRecoveryAction,
  isRetryableProviderFailure,
  providerRetryDelay
} = require('../out/retryPolicy');

test('escalates empty model responses through bounded recovery stages', () => {
  const message = 'The model provider returned an empty final answer.';
  assert.equal(emptyResponseRecoveryAction(message, false, false), 'retry-without-thinking');
  assert.equal(emptyResponseRecoveryAction(message, true, false), 'force-final');
  assert.equal(emptyResponseRecoveryAction(message, true, true), 'none');
  assert.equal(emptyResponseRecoveryAction('Authentication failed.', false, false), 'none');
});

test('retries only transient provider HTTP failures', () => {
  for (const statusCode of [429, 502, 503, 504]) {
    assert.equal(isRetryableProviderFailure({
      status: 'error',
      statusCode,
      errorKind: 'http',
      message: 'Provider unavailable'
    }), true);
  }

  for (const statusCode of [400, 401, 403, 404]) {
    assert.equal(isRetryableProviderFailure({
      status: 'error',
      statusCode,
      errorKind: 'http',
      message: 'Permanent provider error'
    }), false);
  }
  assert.equal(isRetryableProviderFailure({
    status: 'error',
    errorKind: 'timeout',
    message: 'Client timeout'
  }), false);
  assert.equal(isRetryableProviderFailure({
    status: 'error',
    statusCode: 502,
    errorKind: 'http',
    message: 'The model used its response budget for reasoning without producing a final answer.'
  }), false);
  assert.equal(isRetryableProviderFailure({
    status: 'error',
    statusCode: 502,
    errorKind: 'http',
    message: 'The model requested another tool when DevMate required a final answer.'
  }), false);
  assert.equal(isRetryableProviderFailure({
    status: 'error',
    statusCode: 401,
    errorKind: 'http',
    message: 'ResourceExhausted'
  }), false);
});

test('uses three bounded provider retry delays', () => {
  assert.equal(providerRetryDelay(1), 2_000);
  assert.equal(providerRetryDelay(2), 5_000);
  assert.equal(providerRetryDelay(3), 10_000);
  assert.equal(providerRetryDelay(4), undefined);
});
