import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IconView from '../../src/components/IconView.vue';
import LinkCard from '../../src/components/LinkCard.vue';
import { bumpSessionEpoch } from '../../src/api/client';
import { faviconCandidatesFor } from '../../src/shared/url';
import type { IconType, NavLink } from '../../src/shared/types';
import { uiState } from '../../src/stores/ui';

const wrappers: { unmount: () => void }[] = [];

function mountIcon(props: { iconType: IconType; iconValue: string; linkId?: string; name?: string; url?: string }) {
  const wrapper = mount(IconView, {
    props: {
      name: props.name ?? 'Example site',
      url: props.url ?? 'https://example.com/path',
      iconType: props.iconType,
      iconValue: props.iconValue,
      linkId: props.linkId,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  uiState.toasts.splice(0);
});

function iconCacheResponse(result: { status: 'ready' | 'pending' | 'failed' | 'unsupported'; refreshed?: boolean }): Response {
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const savedPublicLink: NavLink = {
  id: 'saved-link-1',
  groupId: 'group-1',
  name: 'Example site',
  url: 'https://www.wikipedia.org/wiki/Main_Page',
  description: '',
  iconType: 'auto',
  iconValue: '',
  target: '_blank',
  position: 0,
  createdAt: '',
  updatedAt: '',
};

describe('IconView favicon handling', () => {
  it('auto mode starts with the first same-origin favicon candidate', () => {
    const wrapper = mountIcon({ iconType: 'auto', iconValue: '', url: 'example.com/page?token=private' });

    expect(wrapper.get('img').attributes('src')).toBe('https://example.com/favicon.ico');
    expect(wrapper.find('.icon-initial').exists()).toBe(false);
  });

  it('uses only the same-origin saved icon endpoint for supported saved auto icons', () => {
    const wrapper = mountIcon({ iconType: 'auto', iconValue: '', linkId: 'saved-link-1', url: savedPublicLink.url });

    expect(wrapper.get('img').attributes('src')).toBe('/api/links/saved-link-1/icon?v=0');
  });

  it('resolves a failed saved icon once and does not loop after a decode failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(iconCacheResponse({ status: 'ready' }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountIcon({ iconType: 'auto', iconValue: '', linkId: 'saved-link-1', url: savedPublicLink.url });

    await wrapper.get('img').trigger('error');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/links/saved-link-1/icon');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(wrapper.get('img').attributes('src')).toBe('/api/links/saved-link-1/icon?v=1');

    await wrapper.get('img').trigger('error');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.icon-initial').exists()).toBe(true);
  });

  it('keeps the previous saved image when a manual refresh fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(iconCacheResponse({ status: 'failed' }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LinkCard, {
      props: { link: savedPublicLink, index: 0, editing: true, canMoveUp: false, canMoveDown: false },
    });
    wrappers.push(wrapper);
    const originalSource = wrapper.get('img').attributes('src');

    await wrapper.get('button[title="刷新图标"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"refresh":true}' });
    expect(wrapper.get('img').attributes('src')).toBe(originalSource);
    expect(uiState.toasts.at(-1)?.type).toBe('error');
    expect(uiState.toasts.at(-1)?.message).toContain('当前显示保持不变');
  });

  it('resumes bounded image polling when a manual refresh finds work in progress', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(iconCacheResponse({ status: 'failed' }))
      .mockResolvedValueOnce(iconCacheResponse({ status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LinkCard, {
      props: { link: savedPublicLink, index: 0, editing: true, canMoveUp: false, canMoveDown: false },
    });
    wrappers.push(wrapper);

    await wrapper.get('img').trigger('error');
    await flushPromises();
    expect(wrapper.find('img').exists()).toBe(false);

    await wrapper.get('button[title="刷新图标"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('img').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await nextTick();
    expect(wrapper.get('img').attributes('src')).toBe('/api/links/saved-link-1/icon?v=1');

    await wrapper.get('img').trigger('error');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a saved icon response after its link props change', async () => {
    let completeRequest!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => {
        completeRequest = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountIcon({ iconType: 'auto', iconValue: '', linkId: 'old-link', url: savedPublicLink.url });

    await wrapper.get('img').trigger('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ linkId: 'new-link', url: 'https://www.mozilla.org/' });
    completeRequest(iconCacheResponse({ status: 'ready' }));
    await flushPromises();

    expect(wrapper.get('img').attributes('src')).toBe('/api/links/new-link/icon?v=0');
  });

  it('drops a saved icon response when the session epoch changes', async () => {
    let completeRequest!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => {
        completeRequest = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountIcon({ iconType: 'auto', iconValue: '', linkId: 'logout-link', url: savedPublicLink.url });

    await wrapper.get('img').trigger('error');
    bumpSessionEpoch();
    completeRequest(iconCacheResponse({ status: 'ready' }));
    await flushPromises();

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.icon-initial').exists()).toBe(true);
  });

  it('tries blank favicon candidates in order and ends at initials after exhaustion', async () => {
    const wrapper = mountIcon({ iconType: 'favicon', iconValue: '', url: 'https://site.example.net/page' });
    const candidates = faviconCandidatesFor('https://site.example.net/page');

    expect(wrapper.get('img').attributes('src')).toBe(candidates[0]);
    for (let index = 0; index < candidates.length; index += 1) {
      await wrapper.get('img').trigger('error');
      await nextTick();
      if (index + 1 < candidates.length) {
        expect(wrapper.get('img').attributes('src')).toBe(candidates[index + 1]);
      }
    }

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('.icon-initial').text()).toBe('E');
  });

  it('keeps custom image and nonempty favicon URLs exact and does not chain fallbacks', async () => {
    const customImage = 'https://cdn.example.net/icons/site.png?size=128';
    const wrapper = mountIcon({ iconType: 'image', iconValue: customImage });

    expect(wrapper.get('img').attributes('src')).toBe(customImage);
    await wrapper.get('img').trigger('error');
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('.icon-initial').text()).toBe('E');

    const customFavicon = 'https://icons.example.net/custom.svg?theme=dark';
    await wrapper.setProps({ iconType: 'favicon', iconValue: customFavicon });
    expect(wrapper.get('img').attributes('src')).toBe(customFavicon);
    await wrapper.get('img').trigger('error');
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('.icon-initial').text()).toBe('E');
  });

  it('does not render a network image for built-in icons', () => {
    const wrapper = mountIcon({ iconType: 'builtin', iconValue: 'star' });

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('svg').exists()).toBe(true);
  });

  it('resets candidates on URL and mode changes and ignores stale image errors', async () => {
    const wrapper = mountIcon({ iconType: 'auto', iconValue: '', url: 'https://first.example.net/path' });
    const staleImage = wrapper.get('img').element;
    const staleSource = wrapper.get('img').attributes('src');

    await wrapper.get('img').trigger('error');
    await nextTick();
    expect(wrapper.get('img').attributes('src')).toBe('https://first.example.net/favicon.svg');

    await wrapper.setProps({ url: 'https://second.example.net/other' });
    expect(wrapper.get('img').attributes('src')).toBe('https://second.example.net/favicon.ico');
    staleImage.dispatchEvent(new Event('error'));
    await nextTick();
    expect(wrapper.get('img').attributes('src')).toBe('https://second.example.net/favicon.ico');

    await wrapper.setProps({ iconType: 'builtin', iconValue: 'home' });
    expect(wrapper.find('img').exists()).toBe(false);
    await wrapper.setProps({ iconType: 'auto', iconValue: '' });
    expect(wrapper.get('img').attributes('src')).toBe('https://second.example.net/favicon.ico');

    await wrapper.setProps({ url: 'https://first.example.net/another-path' });
    expect(wrapper.get('img').attributes('src')).toBe(staleSource);
    staleImage.dispatchEvent(new Event('error'));
    await nextTick();
    expect(wrapper.get('img').attributes('src')).toBe(staleSource);
  });
});
