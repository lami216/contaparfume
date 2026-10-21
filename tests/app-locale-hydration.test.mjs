import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import ContaApp from '../app/conta-app.tsx';
import { LocaleProvider } from '../app/i18n/provider.tsx';
import { translate } from '../app/i18n/messages.ts';

test('initial app markup uses provider locale before browser-only workspace hydration', () => {
  for (const [locale,dir] of [['ar','rtl'],['fr','ltr']]) {
    const markup=renderToString(createElement(LocaleProvider,{initialLocale:locale},createElement(ContaApp)));
    assert.ok(markup.includes(translate(locale,'جاري تحميل السجلات…')));
    assert.match(markup,new RegExp(`dir="${dir}"`));
    assert.match(markup,/role="status"/);
    assert.doesNotMatch(markup,/app-shell|sidebar/);
  }
});
