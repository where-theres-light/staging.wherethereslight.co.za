// IP → coarse location, shared by the edge functions.
//
// Calls an external IP-geolocation service (default ipapi.co, free, no key —
// override with the GEO_API_URL / GEO_API_KEY env vars). Best-effort: any
// failure, timeout, or un-geolocatable IP returns an empty object so the caller
// can record the session without a location rather than fail.

export interface Geo {
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

const GEO_URL = (Deno.env.get('GEO_API_URL') ?? 'https://ipapi.co').replace(/\/$/, '');
const GEO_KEY = Deno.env.get('GEO_API_KEY') ?? '';

// Private / loopback / link-local / unknown addresses can't be geolocated.
function locatable(ip: string): boolean {
  if (!ip || ip === 'unknown') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (/^(10\.|192\.168\.|169\.254\.|fc|fd|fe80:)/i.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}

export async function geolocate(ip: string): Promise<Geo> {
  if (!locatable(ip)) return {};
  try {
    const url = `${GEO_URL}/${encodeURIComponent(ip)}/json/${GEO_KEY ? `?key=${GEO_KEY}` : ''}`;
    // Don't let a slow lookup hold the request open.
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wtl-metrics/1.0' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return {};
    const d: any = await res.json();
    if (d?.error) return {};   // ipapi.co signals failure with { error: true }
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      country:      str(d.country_name),
      country_code: str(d.country_code ?? d.country),
      region:       str(d.region),
      city:         str(d.city),
      latitude:     num(d.latitude),
      longitude:    num(d.longitude),
      timezone:     str(d.timezone),
    };
  } catch {
    return {};
  }
}
