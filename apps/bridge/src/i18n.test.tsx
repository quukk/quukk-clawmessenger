import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { LocaleProvider, useI18n } from './i18n';

function LocaleProbe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <span>{locale}</span>
      <span>{t('nav.setup')}</span>
      <button type="button" onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>
        switch
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('bridge localization', () => {
  it('defaults to Simplified Chinese and updates the document language', () => {
    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);

    expect(screen.getByText('设置向导')).toBeVisible();
    expect(screen.getByText('zh-CN')).toBeVisible();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('switches to English and restores the explicit choice', async () => {
    const user = userEvent.setup();
    const first = render(<LocaleProvider><LocaleProbe /></LocaleProvider>);
    await user.click(screen.getByRole('button', { name: 'switch' }));
    expect(screen.getByText('Setup')).toBeVisible();
    expect(window.localStorage.getItem('quukk-clawmessenger.locale')).toBe('en');
    first.unmount();

    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);
    expect(screen.getByText('en')).toBeVisible();
    expect(screen.getByText('Setup')).toBeVisible();
    expect(document.documentElement.lang).toBe('en');
  });
});
