/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpStart } from '../../../../src/core/public';
import {
  DASHBOARDS_DOCS_API_BASE,
  DeleteDocumentResponse,
  GetDocumentResponse,
  ListDocumentsResponse,
  UpsertDocumentPayload,
  UpsertDocumentResponse,
} from '../../common';

export async function listDocuments(
  http: HttpStart,
  query?: string
): Promise<ListDocumentsResponse> {
  return http.get<ListDocumentsResponse>(`${DASHBOARDS_DOCS_API_BASE}/documents`, {
    query: {
      ...(query ? { query } : {}),
    },
  });
}

export async function getDocument(
  http: HttpStart,
  documentId: string
): Promise<GetDocumentResponse> {
  return http.get<GetDocumentResponse>(`${DASHBOARDS_DOCS_API_BASE}/documents/${documentId}`);
}

export async function createDocument(
  http: HttpStart,
  payload: UpsertDocumentPayload
): Promise<UpsertDocumentResponse> {
  return http.put<UpsertDocumentResponse>(`${DASHBOARDS_DOCS_API_BASE}/documents`, {
    body: JSON.stringify(payload),
  });
}

export async function updateDocument(
  http: HttpStart,
  documentId: string,
  payload: UpsertDocumentPayload
): Promise<UpsertDocumentResponse> {
  return http.post<UpsertDocumentResponse>(`${DASHBOARDS_DOCS_API_BASE}/documents/${documentId}`, {
    body: JSON.stringify(payload),
  });
}

export async function deleteDocument(
  http: HttpStart,
  documentId: string,
  seqNo: number,
  primaryTerm: number
): Promise<DeleteDocumentResponse> {
  return http.delete<DeleteDocumentResponse>(`${DASHBOARDS_DOCS_API_BASE}/documents/${documentId}`, {
    query: {
      seqNo,
      primaryTerm,
    },
  });
}
