import { faviconCandidatesFor } from './url';

export interface IconCacheResult {
  status: 'ready' | 'pending' | 'failed' | 'unsupported';
  retryAfterSeconds?: number;
  refreshed?: boolean;
}

/**
 * Returns the public hostname whose favicon may be cached for a saved link.
 * An empty favicon override means "automatic"; custom icon URLs are never
 * fetched by the cache API.
 */
export function cachedIconHostname(url: string, iconType: string, iconValue: string): string | null {
  if (iconType !== 'auto' && !(iconType === 'favicon' && iconValue === '')) return null;

  // faviconCandidatesFor is the shared source of truth for public-host checks.
  // Read the hostname back from its provider URL so this helper cannot drift
  // from those checks or accidentally accept an arbitrary caller-supplied host.
  for (const candidate of faviconCandidatesFor(url)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') continue;
      if (parsed.hostname === 'www.google.com' && parsed.pathname === '/s2/favicons') {
        const hostname = parsed.searchParams.get('domain');
        if (hostname) return hostname.toLowerCase().replace(/\.$/, '');
      }
      if (parsed.hostname === 'icons.duckduckgo.com' && parsed.pathname.startsWith('/ip3/')) {
        const encoded = parsed.pathname.slice('/ip3/'.length).replace(/\.ico$/i, '');
        const hostname = decodeURIComponent(encoded);
        if (hostname) return hostname.toLowerCase().replace(/\.$/, '');
      }
    } catch {
      // Ignore malformed candidates; the public favicon helper normally
      // returns well-formed URLs, but this keeps the boundary defensive.
    }
  }

  return null;
}
