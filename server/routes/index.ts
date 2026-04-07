/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { IRouter, Logger } from '../../../../src/core/server';
import { DASHBOARDS_DOCS_API_BASE, OPENSEARCH_DOCS_API_BASE } from '../../common';

const upsertSchema = schema.object({
  title: schema.string({ minLength: 1 }),
  content: schema.string(),
  seqNo: schema.maybe(schema.number()),
  primaryTerm: schema.maybe(schema.number()),
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
}
