import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../js/auth.js', () => ({ currentUser: null, auth: { onAuthStateChanged: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  delete global.window;
  delete global.document;
  delete global.localStorage;
  delete global.history;
});

describe('initTabs (TV only)', () => {
  function setupStorage(savedPanel) {
    const store = new Map();
    if (savedPanel) store.set('lastPanel', savedPanel);
    return {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); },
      clear: () => { store.clear(); }
    };
  }

  async function initTabsWithDom(savedPanel) {
    const dom = new JSDOM(`
      <button class="tab-button" data-target="tvPanel"></button>
      <div id="tvPanel"></div>
    `, { url: 'http://localhost/' });

    global.window = dom.window;
    global.document = dom.window.document;
    global.history = dom.window.history;
    global.localStorage = setupStorage(savedPanel);

    global.window.initTvPanel = vi.fn();

    const mod = await import('../js/tabs.js');
    await mod.initTabs(null, {});
    dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    return dom;
  }

  it('activates the tv panel when saved', async () => {
    const dom = await initTabsWithDom('tvPanel');
    const active = dom.window.document.querySelector('.tab-button.active');
    expect(active?.dataset.target).toBe('tvPanel');
    expect(dom.window.document.getElementById('tvPanel').style.display).toBe('flex');
    expect(dom.window.initTvPanel).toHaveBeenCalled();
  });

  it('defaults to tvPanel when saved panel is missing', async () => {
    const dom = await initTabsWithDom('unknownPanel');
    const active = dom.window.document.querySelector('.tab-button.active');
    expect(active?.dataset.target).toBe('tvPanel');
    expect(dom.window.document.getElementById('tvPanel').style.display).toBe('flex');
    expect(dom.window.initTvPanel).toHaveBeenCalled();
  });
});
