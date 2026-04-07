/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const PLUGIN_ID = 'dashboardsDocs';
export const PLUGIN_NAME = 'Docs';
export const DASHBOARDS_DOCS_API_BASE = '/api/_plugins/_dashboards_docs';
export const OPENSEARCH_DOCS_API_BASE = '/_plugins/_docs';
export const DOC_RESOURCE_TYPE = 'docs-document';
export const DOC_GET_ACTION = 'docs:document/get';
export const DOC_UPSERT_ACTION = 'docs:document/upsert';
export const DOC_DELETE_ACTION = 'docs:document/delete';
export const RESOURCE_SHARE_ACTION = 'cluster:admin/security/resource/share';

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

export interface DeleteDocumentResponse {
  deleted: boolean;
  documentId: string;
}

export interface ResourceSharingTypeEntry {
  type: string;
  access_levels: string[];
}

export interface ResourceSharingConfig {
  enabled: boolean;
  types: ResourceSharingTypeEntry[];
}

export interface ShareRecipients {
  users?: string[];
  roles?: string[];
  backend_roles?: string[];
}

export interface ShareWith {
  general_access?: string | null;
  [accessLevel: string]: ShareRecipients | string | null | undefined;
}

export interface ResourceSharingInfo {
  resource_id: string;
  resource_type: string;
  can_share?: boolean;
  share_with?: ShareWith;
}

export interface ResourceSharingResponse {
  sharing_info?: ResourceSharingInfo;
}

export interface ResourceAccessInfo {
  resource_id: string;
  resource_type: string;
  is_owner: boolean;
  is_admin: boolean;
  effective_access_level?: string;
  access_levels: string[];
  allowed_actions: string[];
  can_share: boolean;
}

export interface ResourceAccessResponse {
  access: ResourceAccessInfo;
}

export const EMPTY_RESOURCE_SHARING_CONFIG: ResourceSharingConfig = {
  enabled: false,
  types: [],
};

export function getAccessLevelsForType(
  sharingConfig: ResourceSharingConfig,
  resourceType: string
): string[] {
  return (
    sharingConfig.types.find((entry) => entry.type === resourceType)?.access_levels ?? []
  );
}

export function supportsResourceSharingForType(
  sharingConfig: ResourceSharingConfig,
  resourceType: string
): boolean {
  return sharingConfig.enabled && getAccessLevelsForType(sharingConfig, resourceType).length > 0;
}

export function isShareCapableAccessLevel(accessLevel: string): boolean {
  return accessLevel.toLowerCase().includes('full_access');
}

export function formatAccessLevelLabel(accessLevel: string): string {
  const suffix = accessLevel.includes('_')
    ? accessLevel.slice(accessLevel.indexOf('_') + 1)
    : accessLevel;
  const normalized = suffix.replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
