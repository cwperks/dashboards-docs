/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpStart } from '../../../../src/core/public';
import {
  CollaborationJoinResponse,
  CollaborationReplaceOperation,
  CollaborationSyncResponse,
  DASHBOARDS_DOCS_API_BASE,
  DOC_RESOURCE_TYPE,
} from '../../common';

export async function joinCollaborationSession(
  http: HttpStart,
  documentId: string,
  content: string
): Promise<CollaborationJoinResponse> {
  return http.post<CollaborationJoinResponse>(`${DASHBOARDS_DOCS_API_BASE}/collaboration/join`, {
    body: JSON.stringify({
      document_id: documentId,
      resource_type: DOC_RESOURCE_TYPE,
      content,
    }),
  });
}

export async function syncCollaborationSession(
  http: HttpStart,
  documentId: string,
  sessionId: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  operation?: CollaborationReplaceOperation
): Promise<CollaborationSyncResponse> {
  return http.post<CollaborationSyncResponse>(`${DASHBOARDS_DOCS_API_BASE}/collaboration/sync`, {
    body: JSON.stringify({
      document_id: documentId,
      resource_type: DOC_RESOURCE_TYPE,
      session_id: sessionId,
      selection_start: selectionStart,
      selection_end: selectionEnd,
      ...(operation ? { operation } : {}),
    }),
  });
}

export async function leaveCollaborationSession(
  http: HttpStart,
  documentId: string,
  sessionId: string
): Promise<{ left: boolean }> {
  return http.post<{ left: boolean }>(`${DASHBOARDS_DOCS_API_BASE}/collaboration/leave`, {
    body: JSON.stringify({
      document_id: documentId,
      session_id: sessionId,
    }),
  });
}
