import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadStoredPage, nav, PAGE_STORAGE_KEY, resolveStoredPage, storePage } from '../src/client/navigation';
import { ContactPage } from '../src/client/ContactPage';

const memoryStorage = (initial?: string) => {
  const values = new Map<string, string>(initial === undefined ? [] : [[PAGE_STORAGE_KEY, initial]]);
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

describe('navigation principale', () => {
  it('expose Contact et aucun libellé Exploitation', () => {
    expect(nav.map(([id]) => id)).toEqual(['home', 'prospection', 'contact', 'database', 'settings']);
    expect(nav.find(([id]) => id === 'contact')?.[1]).toBe('Contact');
    expect(nav.some(([id, label]) => /exploitation/i.test(id + label))).toBe(false);
  });

  it('résout la page mémorisée, redirige exploitation vers contact', () => {
    expect(resolveStoredPage('contact')).toBe('contact');
    expect(resolveStoredPage('prospection')).toBe('prospection');
    expect(resolveStoredPage('exploitation')).toBe('contact');
    for (const value of [null, undefined, '', 'inconnue', 'toString', '__proto__']) expect(resolveStoredPage(value)).toBe('home');
  });

  it('migre l’ancienne valeur localStorage et conserve la page après rechargement', () => {
    const legacy = memoryStorage('exploitation');
    expect(loadStoredPage(legacy)).toBe('contact');
    expect(legacy.values.get(PAGE_STORAGE_KEY)).toBe('contact');
    expect(loadStoredPage(legacy)).toBe('contact');

    const storage = memoryStorage();
    expect(loadStoredPage(storage)).toBe('home');
    expect(storage.values.has(PAGE_STORAGE_KEY)).toBe(false);
    storePage(storage, 'contact');
    expect(loadStoredPage(storage)).toBe('contact');

    const unknown = memoryStorage('inconnue');
    expect(loadStoredPage(unknown)).toBe('home');
    expect(unknown.values.get(PAGE_STORAGE_KEY)).toBe('inconnue');
  });

  it('ne casse pas si le stockage est indisponible', () => {
    const broken = { getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('bloqué'); } };
    expect(loadStoredPage(broken)).toBe('home');
    expect(() => storePage(broken, 'contact')).not.toThrow();
  });
});

describe('page Contact', () => {
  it('affiche la coquille Contact sans Coming soon ni donnée', () => {
    const markup = renderToStaticMarkup(createElement(ContactPage, { onPlanInProspection: () => undefined }));
    expect(markup).toContain('<h1>Contact</h1>');
    expect(markup).toContain('contact-list');
    expect(markup).toContain('contact-main');
    expect(markup).not.toMatch(/coming soon|exploitation/i);
    expect(markup).not.toContain('<b>');
    expect(markup).not.toMatch(/class="(cards|filters)/);
  });
});
