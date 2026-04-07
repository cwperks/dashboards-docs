/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PluginInitializerContext } from '../../../src/core/server';
import { DashboardsDocsServerPlugin } from './plugin';

export function plugin(initializerContext: PluginInitializerContext) {
  return new DashboardsDocsServerPlugin(initializerContext);
}
