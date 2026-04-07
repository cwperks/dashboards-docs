/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreSetup, CoreStart, Logger, Plugin, PluginInitializerContext } from '../../../src/core/server';
import { CollaborationService } from './collaboration_service';
import { defineRoutes, defineWebSocketRoute } from './routes';

export class DashboardsDocsServerPlugin implements Plugin<void, void> {
  private readonly logger: Logger;
  private readonly collaborationService: CollaborationService;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
    this.collaborationService = new CollaborationService();
  }

  public setup(core: CoreSetup) {
    this.logger.debug('dashboards-docs: setup');
    const router = core.http.createRouter();
    defineRoutes(router, this.logger, this.collaborationService);
    defineWebSocketRoute(core.http.registerWebSocketRoute, this.logger, this.collaborationService);
  }

  public start(core: CoreStart) {
    this.logger.debug('dashboards-docs: start');
  }

  public stop() {}
}
