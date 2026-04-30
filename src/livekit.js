const { AccessToken } = require('livekit-server-sdk');

function calculateExpiresAt(now, tokenTtlSeconds) {
  return new Date(new Date(now).getTime() + tokenTtlSeconds * 1000);
}

function decodeTokenExpiration(token) {
  const segments = String(token).split('.');
  if (segments.length !== 3) {
    throw new Error('LiveKit token is not a valid JWT');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error('LiveKit token payload could not be decoded');
  }

  if (!Number.isInteger(payload.exp) || payload.exp <= 0) {
    throw new Error('LiveKit token payload is missing a valid exp claim');
  }

  return new Date(payload.exp * 1000);
}

async function mintParticipantToken({
  apiKey,
  apiSecret,
  roomName,
  identity,
  tokenTtlSeconds,
  now = new Date(),
}) {
  const accessToken = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: tokenTtlSeconds,
  });

  accessToken.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });

  const token = await accessToken.toJwt();
  const expiresAt = decodeTokenExpiration(token);

  return {
    token,
    expiresAt,
  };
}

module.exports = {
  calculateExpiresAt,
  decodeTokenExpiration,
  mintParticipantToken,
};
