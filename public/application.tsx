/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@osd/i18n/react';
import { AppMountParameters, CoreStart } from '../../../src/core/public';
import { DocsApp } from './components/app';

export function renderApp(coreStart: CoreStart, params: AppMountParameters) {
  const root = createRoot(params.element);

  root.render(
    <I18nProvider>
      <DocsApp coreStart={coreStart} />
    </I18nProvider>
  );

  return () => {
    root.unmount();
  };
}
