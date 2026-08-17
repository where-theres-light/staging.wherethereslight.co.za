// One-way IP hashing, shared by the edge functions.
//
// The raw client IP is used only transiently (rate-limit key, geolocation) and
// never stored; what lands in the database is this salted SHA-256 hash. The
// salt is a secret (function env `IP_HASH_SALT`) so the small IPv4 space cannot
// simply be brute-forced back from a hash — set it in production. Without it the
// hash still removes plaintext IPs, but offers no real pre-image resistance.

const SALT = Deno.env.get('IP_HASH_SALT') ?? '';

export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${SALT}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
