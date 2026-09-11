export function preferHls({ protocol, hostname }) {
  if (protocol !== 'http:') return true;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return false;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || !octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return true;
  return !(octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
}
