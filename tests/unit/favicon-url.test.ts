import { describe, expect, it } from 'vitest';
import { faviconCandidatesFor, faviconUrlFor } from '../../src/shared/url';

const FIRST_PARTY_PATHS = [
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
];

describe('favicon candidate URLs', () => {
  it('normalizes a bare domain and tries its root icon paths in order', () => {
    expect(faviconCandidatesFor('  example.net/docs/page  ').slice(0, 6)).toEqual(
      FIRST_PARTY_PATHS.map((path) => `https://example.net${path}`),
    );
    expect(faviconUrlFor('example.net/docs')).toBe('https://example.net/favicon.ico');
  });

  it('appends public favicon services using only the hostname', () => {
    const candidates = faviconCandidatesFor('https://alice:secret@my-public-site.net:8443/private/path?token=secret#section');

    expect(candidates).toHaveLength(8);
    expect(candidates.slice(0, 6)).toEqual(FIRST_PARTY_PATHS.map((path) => `https://my-public-site.net:8443${path}`));
    expect(candidates[6]).toBe('https://www.google.com/s2/favicons?domain=my-public-site.net&sz=64');
    expect(candidates[7]).toBe('https://icons.duckduckgo.com/ip3/my-public-site.net.ico');
    expect(candidates.slice(6).join('\n')).not.toMatch(/alice|secret|8443|private|token|section/i);
  });

  it('does not treat a double trailing dot as a public hostname', () => {
    const candidates = faviconCandidatesFor('https://foo.com../path');

    expect(candidates.some((candidate) => candidate.includes('google.com') || candidate.includes('duckduckgo.com'))).toBe(false);
  });

  it.each([
    'http://localhost:8788/path',
    'https://app.localhost/path',
    'http://router.local/',
    'https://service.internal/path',
    'https://nas.lan/path',
    'http://desktop.home/path',
    'https://test-host.test/path',
    'https://service.invalid/path',
    'https://service.example/path',
    'http://hidden.onion/path',
    'http://host.arpa/path',
    'http://machine.alt/path',
    'http://server.localdomain/path',
    'http://server.intranet/path',
    'http://server.corp/path',
    'http://localhost./path',
    'http://router.local./path',
    'https://example.com/path',
    'https://sub.example.net/path',
    'https://deep.sub.example.org/path',
    'http://192.168.1.20:8080/path',
    'http://10.0.1.2/path',
    'http://127.1/path',
    'http://2130706433/path',
    'http://0x7f000001/path',
    'http://[::1]:8788/path',
    'http://[2001:db8::1]/path',
    'http://[::ffff:192.0.2.1]/path',
    'https://singlelabel/path',
    'https://public..com/path',
    'https://_service.example.net/path',
    'https://-service.example.net/path',
    'https://service-.example.net/path',
  ])('keeps third-party fallbacks off non-public host %s', (url) => {
    const candidates = faviconCandidatesFor(url);

    expect(candidates).toHaveLength(6);
    expect(candidates.every((candidate) => !candidate.includes('google.com') && !candidate.includes('duckduckgo.com'))).toBe(true);
  });

  it('returns no candidates for malformed or non-HTTP URLs', () => {
    expect(faviconCandidatesFor('javascript:alert(1)')).toEqual([]);
    expect(faviconCandidatesFor('not a valid host with spaces')).toEqual([]);
  });
});
