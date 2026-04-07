/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import {
  IRouter,
  IOpenSearchDashboardsWebSocket,
  Logger,
  OpenSearchDashboardsWebSocketRequest,
} from '../../../../src/core/server';
import {
  DOC_UPSERT_ACTION,
  DASHBOARDS_DOCS_API_BASE,
  DeleteDocumentResponse,
  OPENSEARCH_DOCS_API_BASE,
} from '../../common';
import { CollaborationService } from '../collaboration_service';

const SECURITY_DASHBOARDS_INFO_API = '/_plugins/_security/dashboardsinfo';
const SECURITY_RESOURCE_TYPES_API = '/_plugins/_security/api/resource/types';
const SECURITY_RESOURCE_SHARE_API = '/_plugins/_security/api/resource/share';
const SECURITY_RESOURCE_ACCESS_API = '/_plugins/_security/api/resource/access';
const SECURITY_AUTHINFO_API = '/_plugins/_security/authinfo';

const upsertSchema = schema.object({
  title: schema.string({ minLength: 1 }),
  content: schema.string(),
  folderId: schema.maybe(schema.nullable(schema.string())),
  seqNo: schema.maybe(schema.number()),
  primaryTerm: schema.maybe(schema.number()),
});

const upsertFolderSchema = schema.object({
  name: schema.string({ minLength: 1 }),
  parentId: schema.maybe(schema.nullable(schema.string())),
  seqNo: schema.maybe(schema.number()),
  primaryTerm: schema.maybe(schema.number()),
});

const shareWithSchema = schema.recordOf(schema.string(), schema.any());
const collaborationOperationSchema = schema.object({
  baseVersion: schema.number({ min: 0 }),
  start: schema.number({ min: 0 }),
  end: schema.number({ min: 0 }),
  text: schema.string(),
});

function getErrorPayload(error: any) {
  return {
    statusCode: error?.statusCode ?? error?.body?.status ?? error?.body?.statusCode ?? 500,
    body: {
      message:
        error?.body?.message ??
        error?.message ??
        'Unexpected error while proxying to the docs backend.',
    },
  };
}

function getResponseBody<T>(response: { body?: T } | T): T {
  return typeof response === 'object' && response !== null && 'body' in response
    ? ((response as { body?: T }).body as T)
    : (response as T);
}

function sendCollaborationState(
  sockets: Map<string, IOpenSearchDashboardsWebSocket>,
  collaborationService: CollaborationService,
  documentId: string
) {
  sockets.forEach((webSocket, sessionId) => {
    if (webSocket.readyState !== 1) {
      return;
    }

    try {
      webSocket.send(
        JSON.stringify({
          type: 'state',
          payload: collaborationService.getState(documentId, sessionId),
        })
      );
    } catch (error) {
      // Ignore send failures here; the connection cleanup path will remove stale sockets.
    }
  });
}

async function getCurrentUserName(context: any): Promise<string> {
  try {
    const authInfoResponse = await context.core.opensearch.client.asCurrentUser.transport.request({
      method: 'GET',
      path: SECURITY_AUTHINFO_API,
    });
    const authInfo = getResponseBody<any>(authInfoResponse);
    return authInfo?.user_name ?? authInfo?.user ?? 'Someone';
  } catch (error) {
    return 'Someone';
  }
}

async function canCurrentUserEditResource(
  context: any,
  resourceId: string,
  resourceType: string
): Promise<boolean> {
  try {
    const accessResponse = await context.core.opensearch.client.asCurrentUser.transport.request({
      method: 'GET',
      path: SECURITY_RESOURCE_ACCESS_API,
      querystring: {
        resource_id: resourceId,
        resource_type: resourceType,
      },
    });
    const access = getResponseBody<any>(accessResponse)?.access;
    const allowedActions = Array.isArray(access?.allowed_actions) ? access.allowed_actions : [];
    return allowedActions.includes(DOC_UPSERT_ACTION);
  } catch (error: any) {
    if (error?.statusCode === 403 || error?.body?.statusCode === 403) {
      return false;
    }

    throw error;
  }
}

export function defineRoutes(
  router: IRouter,
  logger: Logger,
  collaborationService: CollaborationService
) {
  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/documents`,
      validate: {
        query: schema.object({
          query: schema.maybe(schema.string()),
          size: schema.maybe(schema.number({ min: 1, max: 200 })),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const query = new URLSearchParams();
        if (request.query.query) {
          query.set('query', request.query.query);
        }
        if (request.query.size) {
          query.set('size', String(request.query.size));
        }

        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'GET',
          path: `${OPENSEARCH_DOCS_API_BASE}/documents${query.toString() ? `?${query}` : ''}`,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to list docs: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/documents/{documentId}`,
      validate: {
        params: schema.object({
          documentId: schema.string(),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'GET',
          path: `${OPENSEARCH_DOCS_API_BASE}/documents/${request.params.documentId}`,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to get doc ${request.params.documentId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.put(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/documents`,
      validate: {
        body: upsertSchema,
      },
    },
    async (context, request, response) => {
      try {
        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'PUT',
          path: `${OPENSEARCH_DOCS_API_BASE}/documents`,
          body: request.body,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to create doc: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.post(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/documents/{documentId}`,
      validate: {
        params: schema.object({
          documentId: schema.string(),
        }),
        body: upsertSchema,
      },
    },
    async (context, request, response) => {
      try {
        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'POST',
          path: `${OPENSEARCH_DOCS_API_BASE}/documents/${request.params.documentId}`,
          body: request.body,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to update doc ${request.params.documentId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.delete(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/documents/{documentId}`,
      validate: {
        params: schema.object({
          documentId: schema.string(),
        }),
        query: schema.object({
          seqNo: schema.number(),
          primaryTerm: schema.number(),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const query = new URLSearchParams({
          seqNo: String(request.query.seqNo),
          primaryTerm: String(request.query.primaryTerm),
        });

        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'DELETE',
          path: `${OPENSEARCH_DOCS_API_BASE}/documents/${request.params.documentId}?${query}`,
        });

        return response.ok({ body: result.body as DeleteDocumentResponse });
      } catch (error) {
        logger.warn(`Failed to delete doc ${request.params.documentId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/folders`,
      validate: {
        query: schema.object({
          query: schema.maybe(schema.string()),
          size: schema.maybe(schema.number({ min: 1, max: 500 })),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const query = new URLSearchParams();
        if (request.query.query) {
          query.set('query', request.query.query);
        }
        if (request.query.size) {
          query.set('size', String(request.query.size));
        }

        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'GET',
          path: `${OPENSEARCH_DOCS_API_BASE}/folders${query.toString() ? `?${query}` : ''}`,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to list folders: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/folders/{folderId}`,
      validate: {
        params: schema.object({
          folderId: schema.string(),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'GET',
          path: `${OPENSEARCH_DOCS_API_BASE}/folders/${request.params.folderId}`,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to get folder ${request.params.folderId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.put(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/folders`,
      validate: {
        body: upsertFolderSchema,
      },
    },
    async (context, request, response) => {
      try {
        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'PUT',
          path: `${OPENSEARCH_DOCS_API_BASE}/folders`,
          body: request.body,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to create folder: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.post(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/folders/{folderId}`,
      validate: {
        params: schema.object({
          folderId: schema.string(),
        }),
        body: upsertFolderSchema,
      },
    },
    async (context, request, response) => {
      try {
        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'POST',
          path: `${OPENSEARCH_DOCS_API_BASE}/folders/${request.params.folderId}`,
          body: request.body,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to update folder ${request.params.folderId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.delete(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/folders/{folderId}`,
      validate: {
        params: schema.object({
          folderId: schema.string(),
        }),
        query: schema.object({
          seqNo: schema.number(),
          primaryTerm: schema.number(),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const query = new URLSearchParams({
          seqNo: String(request.query.seqNo),
          primaryTerm: String(request.query.primaryTerm),
        });

        const result = await context.core.opensearch.client.asCurrentUser.transport.request({
          method: 'DELETE',
          path: `${OPENSEARCH_DOCS_API_BASE}/folders/${request.params.folderId}?${query}`,
        });

        return response.ok({ body: result.body });
      } catch (error) {
        logger.warn(`Failed to delete folder ${request.params.folderId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/resourceSharing/config`,
      validate: false,
    },
    async (context, _request, response) => {
      const client = context.core.opensearch.client.asCurrentUser;

      try {
        const dashboardsInfoResponse = await client.transport.request({
          method: 'GET',
          path: SECURITY_DASHBOARDS_INFO_API,
        });
        const dashboardsInfo = getResponseBody<any>(dashboardsInfoResponse);
        const enabled = dashboardsInfo?.resource_sharing_enabled === true;

        if (!enabled) {
          return response.ok({ body: { enabled: false, types: [] } });
        }

        try {
          const typesResponse = await client.transport.request({
            method: 'GET',
            path: SECURITY_RESOURCE_TYPES_API,
          });
          const typesBody = getResponseBody<any>(typesResponse);
          return response.ok({
            body: {
              enabled: true,
              types: Array.isArray(typesBody) ? typesBody : typesBody?.types ?? [],
            },
          });
        } catch (error) {
          logger.warn(`Failed to fetch resource sharing types: ${error}`);
          return response.ok({ body: { enabled: true, types: [] } });
        }
      } catch (error) {
        logger.warn(`Failed to fetch resource sharing config: ${error}`);
        return response.ok({ body: { enabled: false, types: [] } });
      }
    }
  );

  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/resourceSharing/view`,
      validate: {
        query: schema.object({
          resourceId: schema.string(),
          resourceType: schema.string(),
        }),
      },
    },
    async (context, request, response) => {
      const client = context.core.opensearch.client.asCurrentUser;

      try {
        const sharingResponse = await client.transport.request({
          method: 'GET',
          path: SECURITY_RESOURCE_SHARE_API,
          querystring: {
            resource_id: request.query.resourceId,
            resource_type: request.query.resourceType,
          },
        });

        return response.ok({
          body: {
            exists: true,
            ...getResponseBody(sharingResponse),
          },
        });
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.body?.statusCode === 404) {
          return response.ok({
            body: {
              exists: false,
              sharing_info: {
                resource_id: request.query.resourceId,
                resource_type: request.query.resourceType,
                share_with: {},
              },
            },
          });
        }

        logger.warn(`Failed to fetch sharing info for ${request.query.resourceId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.get(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/resourceSharing/access`,
      validate: {
        query: schema.object({
          resourceId: schema.string(),
          resourceType: schema.string(),
        }),
      },
    },
    async (context, request, response) => {
      const client = context.core.opensearch.client.asCurrentUser;

      try {
        const accessResponse = await client.transport.request({
          method: 'GET',
          path: SECURITY_RESOURCE_ACCESS_API,
          querystring: {
            resource_id: request.query.resourceId,
            resource_type: request.query.resourceType,
          },
        });

        return response.ok({ body: getResponseBody(accessResponse) });
      } catch (error) {
        logger.warn(`Failed to fetch access info for ${request.query.resourceId}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.put(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/resourceSharing/share`,
      validate: {
        body: schema.object({
          resource_id: schema.string(),
          resource_type: schema.string(),
          share_with: shareWithSchema,
        }),
      },
    },
    async (context, request, response) => {
      const client = context.core.opensearch.client.asCurrentUser;

      try {
        const shareResponse = await client.transport.request({
          method: 'PUT',
          path: SECURITY_RESOURCE_SHARE_API,
          body: request.body,
        });

        return response.ok({ body: getResponseBody(shareResponse) });
      } catch (error) {
        logger.warn(`Failed to create sharing info for ${request.body.resource_id}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.post(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/resourceSharing/update`,
      validate: {
        body: schema.object({
          resource_id: schema.string(),
          resource_type: schema.string(),
          add: schema.maybe(shareWithSchema),
          revoke: schema.maybe(shareWithSchema),
          general_access: schema.maybe(schema.nullable(schema.string())),
        }),
      },
    },
    async (context, request, response) => {
      const client = context.core.opensearch.client.asCurrentUser;

      try {
        const shareResponse = await client.transport.request({
          method: 'POST',
          path: SECURITY_RESOURCE_SHARE_API,
          body: request.body,
        });

        return response.ok({ body: getResponseBody(shareResponse) });
      } catch (error) {
        logger.warn(`Failed to update sharing info for ${request.body.resource_id}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.post(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/collaboration/join`,
      validate: {
        body: schema.object({
          document_id: schema.string(),
          resource_type: schema.string(),
          content: schema.string(),
        }),
      },
    },
    async (context, request, response) => {
      try {
        const [userName, canEdit] = await Promise.all([
          getCurrentUserName(context),
          canCurrentUserEditResource(context, request.body.document_id, request.body.resource_type),
        ]);

        return response.ok({
          body: collaborationService.joinDocument(
            request.body.document_id,
            request.body.content,
            userName,
            canEdit
          ),
        });
      } catch (error) {
        logger.warn(`Failed to join collaboration session for ${request.body.document_id}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.post(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/collaboration/sync`,
      validate: {
        body: schema.object({
          document_id: schema.string(),
          resource_type: schema.string(),
          session_id: schema.string(),
          selection_start: schema.nullable(schema.number({ min: 0 })),
          selection_end: schema.nullable(schema.number({ min: 0 })),
          operation: schema.maybe(collaborationOperationSchema),
        }),
      },
    },
    async (context, request, response) => {
      try {
        return response.ok({
          body: collaborationService.syncDocument({
            documentId: request.body.document_id,
            sessionId: request.body.session_id,
            operation: request.body.operation,
            selectionStart: request.body.selection_start,
            selectionEnd: request.body.selection_end,
          }),
        });
      } catch (error) {
        logger.warn(`Failed to sync collaboration session for ${request.body.document_id}: ${error}`);
        return response.customError(getErrorPayload(error));
      }
    }
  );

  router.post(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/collaboration/leave`,
      validate: {
        body: schema.object({
          document_id: schema.string(),
          session_id: schema.string(),
        }),
      },
    },
    async (_context, request, response) => {
      collaborationService.leaveDocument(request.body.document_id, request.body.session_id);
      return response.ok({ body: { left: true } });
    }
  );
}

export function defineWebSocketRoute(
  registerWebSocketRoute: (
    config: { path: string },
    handler: (
      socket: IOpenSearchDashboardsWebSocket,
      request: OpenSearchDashboardsWebSocketRequest
    ) => void
  ) => void,
  logger: Logger,
  collaborationService: CollaborationService
) {
  const socketsByDocument = new Map<string, Map<string, IOpenSearchDashboardsWebSocket>>();

  registerWebSocketRoute(
    {
      path: `${DASHBOARDS_DOCS_API_BASE}/collaboration/socket`,
    },
    (webSocket, request) => {
      try {
        const requestUrl = new URL(request.url, 'http://localhost');
        const documentId = requestUrl.searchParams.get('documentId');
        const sessionId = requestUrl.searchParams.get('sessionId');

        if (!documentId || !sessionId) {
          webSocket.close(1008, 'Missing collaboration identifiers.');
          return;
        }

        let documentSockets = socketsByDocument.get(documentId);
        if (!documentSockets) {
          documentSockets = new Map();
          socketsByDocument.set(documentId, documentSockets);
        }
        documentSockets.set(sessionId, webSocket);

        sendCollaborationState(documentSockets, collaborationService, documentId);

        webSocket.onMessage((message) => {
          try {
            const payload = JSON.parse(message) as {
              type?: 'selection' | 'operation';
              selectionStart?: number | null;
              selectionEnd?: number | null;
              operation?: {
                baseVersion: number;
                start: number;
                end: number;
                text: string;
              };
            };

            collaborationService.syncDocument({
              documentId,
              sessionId,
              selectionStart: payload.selectionStart ?? null,
              selectionEnd: payload.selectionEnd ?? null,
              operation: payload.type === 'operation' ? payload.operation : undefined,
            });

            sendCollaborationState(documentSockets!, collaborationService, documentId);
          } catch (error) {
            logger.warn(`Failed to process collaboration websocket message for ${documentId}: ${error}`);
          }
        });

        webSocket.onClose(() => {
          const activeSockets = socketsByDocument.get(documentId);
          if (!activeSockets) {
            return;
          }

          activeSockets.delete(sessionId);
          collaborationService.leaveDocument(documentId, sessionId);

          if (activeSockets.size === 0) {
            socketsByDocument.delete(documentId);
            return;
          }

          sendCollaborationState(activeSockets, collaborationService, documentId);
        });

        webSocket.onError((error) => {
          logger.warn(`Collaboration websocket error for ${documentId}: ${error}`);
        });
      } catch (error) {
        logger.warn(`Failed to open collaboration websocket: ${error}`);
        webSocket.close(1011, 'Unable to open collaboration session.');
      }
    }
  );
}
