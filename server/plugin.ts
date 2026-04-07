/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreSetup, CoreStart, Logger, Plugin, PluginInitializerContext } from '../../../src/core/server';
import { defineRoutes } from './routes';

export class DashboardsDocsServerPlugin implements Plugin<void, void> {
  private readonly logger: Logger;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }

  public setup(core: CoreSetup) {
    this.logger.debug('dashboards-docs: setup');
    const router = core.http.createRouter();
    defineRoutes(router, this.logger);
  }

  public start(core: CoreStart) {
    this.logger.debug('dashboards-docs: start');
  }

  public stop() {}
}
