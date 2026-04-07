/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { IRouter, Logger } from '../../../../src/core/server';
import {
  DASHBOARDS_DOCS_API_BASE,
  DeleteDocumentResponse,
  OPENSEARCH_DOCS_API_BASE,
} from '../../common';

const SECURITY_DASHBOARDS_INFO_API = '/_plugins/_security/dashboardsinfo';
const SECURITY_RESOURCE_TYPES_API = '/_plugins/_security/api/resource/types';
const SECURITY_RESOURCE_SHARE_API = '/_plugins/_security/api/resource/share';
const SECURITY_RESOURCE_ACCESS_API = '/_plugins/_security/api/resource/access';

const upsertSchema = schema.object({
  title: schema.string({ minLength: 1 }),
  content: schema.string(),
  seqNo: schema.maybe(schema.number()),
  primaryTerm: schema.maybe(schema.number()),
});

const shareWithSchema = schema.recordOf(schema.string(), schema.any());

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

export function defineRoutes(router: IRouter, logger: Logger) {
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
}
