/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppMountParameters,
  CoreSetup,
  CoreStart,
  DEFAULT_NAV_GROUPS,
  Plugin,
  WorkspaceAvailability,
} from '../../../src/core/public';
import { PLUGIN_ID, PLUGIN_NAME } from '../common';
import { DashboardsDocsPluginSetup, DashboardsDocsPluginStart } from './types';

export class DashboardsDocsPlugin
  implements Plugin<DashboardsDocsPluginSetup, DashboardsDocsPluginStart> {
  public setup(core: CoreSetup): DashboardsDocsPluginSetup {
    core.application.register({
      id: PLUGIN_ID,
      title: PLUGIN_NAME,
      order: 2200,
      workspaceAvailability: WorkspaceAvailability.insideWorkspace,
      async mount(params: AppMountParameters) {
        const { renderApp } = await import('./application');
        const [coreStart] = await core.getStartServices();
        return renderApp(coreStart, params);
      },
    });

    core.chrome.navGroup.addNavLinksToGroup(DEFAULT_NAV_GROUPS.essentials, [
      {
        id: PLUGIN_ID,
        order: 220,
      },
    ]);

    core.chrome.navGroup.addNavLinksToGroup(DEFAULT_NAV_GROUPS.all, [
      {
        id: PLUGIN_ID,
        order: 220,
      },
    ]);

    return {};
  }

  public start(core: CoreStart): DashboardsDocsPluginStart {
    return {};
  }

  public stop() {}
}
