const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateExpiresAt,
  decodeTokenExpiration,
  mintParticipantToken,
} = require('../src/livekit');

test('calculateExpiresAt adds the configured TTL', () => {
  const now = new Date('2026-04-24T15:00:00.000Z');
  const expiresAt = calculateExpiresAt(now, 900);

  assert.equal(expiresAt.toISOString(), '2026-04-24T15:15:00.000Z');
});

test('mintParticipantToken returns a JWT whose exp matches the response expiry', async () => {
  const result = await mintParticipantToken({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    roomName: 'whiterun-test',
    identity: 'test-user',
    tokenTtlSeconds: 900,
    now: new Date('2026-04-24T15:00:00.000Z'),
  });

  assert.equal(typeof result.token, 'string');
  assert.equal(result.token.split('.').length, 3);
  assert.equal(
    decodeTokenExpiration(result.token).toISOString(),
    result.expiresAt.toISOString(),
  );
  assert.ok(result.expiresAt.getTime() > Date.now());
});
