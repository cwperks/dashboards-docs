/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpStart } from '../../../../src/core/public';
import {
  CreateCommentResponse,
  DASHBOARDS_DOCS_API_BASE,
  DeleteCommentResponse,
  ListCommentsResponse,
} from '../../common';

export async function listComments(
  http: HttpStart,
  documentId: string
): Promise<ListCommentsResponse> {
  return http.get<ListCommentsResponse>(`${DASHBOARDS_DOCS_API_BASE}/comments`, {
    query: { documentId },
  });
}

export async function createComment(
  http: HttpStart,
  payload: {
    documentId: string;
    threadId?: string | null;
    commentText: string;
    startOffset: number;
    endOffset: number;
  }
): Promise<CreateCommentResponse> {
  return http.put<CreateCommentResponse>(`${DASHBOARDS_DOCS_API_BASE}/comments`, {
    body: JSON.stringify(payload),
  });
}

export async function deleteComment(
  http: HttpStart,
  commentId: string,
  seqNo: number,
  primaryTerm: number
): Promise<DeleteCommentResponse> {
  return http.delete<DeleteCommentResponse>(`${DASHBOARDS_DOCS_API_BASE}/comments/${commentId}`, {
    query: { seqNo, primaryTerm },
  });
}
