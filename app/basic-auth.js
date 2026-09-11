import { timingSafeEqual } from 'node:crypto';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function isBasicAuthorized(header, username, password) {
  if (!header?.startsWith('Basic ') || !username || !password) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), username)
    && safeEqual(decoded.slice(separator + 1), password);
}
