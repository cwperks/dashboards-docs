/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpStart } from '../../../../src/core/public';
import {
  DASHBOARDS_DOCS_API_BASE,
  ResourceAccessResponse,
  ResourceSharingConfig,
  ResourceSharingResponse,
  ShareWith,
} from '../../common';

export async function getSharingConfig(http: HttpStart): Promise<ResourceSharingConfig> {
  return http.get<ResourceSharingConfig>(`${DASHBOARDS_DOCS_API_BASE}/resourceSharing/config`);
}

export async function getSharingInfo(
  http: HttpStart,
  resourceId: string,
  resourceType: string
): Promise<ResourceSharingResponse> {
  return http.get<ResourceSharingResponse>(`${DASHBOARDS_DOCS_API_BASE}/resourceSharing/view`, {
    query: {
      resourceId,
      resourceType,
    },
  });
}

export async function getResourceAccess(
  http: HttpStart,
  resourceId: string,
  resourceType: string
): Promise<ResourceAccessResponse> {
  return http.get<ResourceAccessResponse>(`${DASHBOARDS_DOCS_API_BASE}/resourceSharing/access`, {
    query: {
      resourceId,
      resourceType,
    },
  });
}

export async function createSharingInfo(
  http: HttpStart,
  resourceId: string,
  resourceType: string,
  shareWith: ShareWith
): Promise<ResourceSharingResponse> {
  return http.put<ResourceSharingResponse>(`${DASHBOARDS_DOCS_API_BASE}/resourceSharing/share`, {
    body: JSON.stringify({
      resource_id: resourceId,
      resource_type: resourceType,
      share_with: shareWith,
    }),
  });
}

export async function updateSharingInfo(
  http: HttpStart,
  resourceId: string,
  resourceType: string,
  generalAccess: string | null
): Promise<ResourceSharingResponse> {
  return http.post<ResourceSharingResponse>(`${DASHBOARDS_DOCS_API_BASE}/resourceSharing/update`, {
    body: JSON.stringify({
      resource_id: resourceId,
      resource_type: resourceType,
      general_access: generalAccess,
    }),
  });
}
