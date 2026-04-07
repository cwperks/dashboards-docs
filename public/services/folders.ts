/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpStart } from '../../../../src/core/public';
import {
  DASHBOARDS_DOCS_API_BASE,
  DeleteFolderResponse,
  GetFolderResponse,
  ListFoldersResponse,
  UpsertFolderPayload,
  UpsertFolderResponse,
} from '../../common';

export async function listFolders(http: HttpStart, query?: string): Promise<ListFoldersResponse> {
  return http.get<ListFoldersResponse>(`${DASHBOARDS_DOCS_API_BASE}/folders`, {
    query: {
      ...(query ? { query } : {}),
    },
  });
}

export async function getFolder(http: HttpStart, folderId: string): Promise<GetFolderResponse> {
  return http.get<GetFolderResponse>(`${DASHBOARDS_DOCS_API_BASE}/folders/${folderId}`);
}

export async function createFolder(
  http: HttpStart,
  payload: UpsertFolderPayload
): Promise<UpsertFolderResponse> {
  return http.put<UpsertFolderResponse>(`${DASHBOARDS_DOCS_API_BASE}/folders`, {
    body: JSON.stringify(payload),
  });
}

export async function updateFolder(
  http: HttpStart,
  folderId: string,
  payload: UpsertFolderPayload
): Promise<UpsertFolderResponse> {
  return http.post<UpsertFolderResponse>(`${DASHBOARDS_DOCS_API_BASE}/folders/${folderId}`, {
    body: JSON.stringify(payload),
  });
}

export async function deleteFolder(
  http: HttpStart,
  folderId: string,
  seqNo: number,
  primaryTerm: number
): Promise<DeleteFolderResponse> {
  return http.delete<DeleteFolderResponse>(`${DASHBOARDS_DOCS_API_BASE}/folders/${folderId}`, {
    query: {
      seqNo,
      primaryTerm,
    },
  });
}
