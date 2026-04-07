/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import './index.scss';

import { DashboardsDocsPlugin } from './plugin';

export function plugin() {
  return new DashboardsDocsPlugin();
}

export { DashboardsDocsPluginSetup, DashboardsDocsPluginStart } from './types';
