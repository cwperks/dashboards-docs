/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const PLUGIN_ID = 'dashboardsDocs';
export const PLUGIN_NAME = 'Docs';
export const DASHBOARDS_DOCS_API_BASE = '/api/_plugins/_dashboards_docs';
export const OPENSEARCH_DOCS_API_BASE = '/_plugins/_docs';

export interface DocumentSummary {
  id: string;
  title: string;
  excerpt: string;
  lastUpdatedBy: string;
  updatedAt: number;
  seqNo: number;
  primaryTerm: number;
}

export interface DocumentRecord extends DocumentSummary {
  content: string;
  owner: string;
  createdAt: number;
}

export interface ListDocumentsResponse {
  documents: DocumentSummary[];
}

export interface GetDocumentResponse {
  document: DocumentRecord;
}

export interface UpsertDocumentPayload {
  title: string;
  content: string;
  seqNo?: number;
  primaryTerm?: number;
}

export interface UpsertDocumentResponse {
  created: boolean;
  document: DocumentRecord;
}
