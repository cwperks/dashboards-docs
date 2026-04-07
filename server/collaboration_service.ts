/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import {
  CollaborationJoinResponse,
  CollaborationParticipant,
  CollaborationReplaceOperation,
  CollaborationSyncResponse,
} from '../common';

interface StoredOperation {
  version: number;
  sessionId: string;
  start: number;
  end: number;
  text: string;
}

interface StoredParticipant {
  sessionId: string;
  userName: string;
  color: string;
  canEdit: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  updatedAt: number;
}

interface CollaborationSession {
  documentId: string;
  content: string;
  version: number;
  operations: StoredOperation[];
  participants: Map<string, StoredParticipant>;
}

const PARTICIPANT_TTL_MS = 30_000;
const OPERATION_HISTORY_LIMIT = 250;
const COLORS = ['coral', 'amber', 'teal', 'blue', 'violet', 'mint'];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function transformIndex(
  index: number,
  operation: StoredOperation,
  affinity: 'left' | 'right'
): number {
  const removedLength = operation.end - operation.start;
  const insertedLength = operation.text.length;

  if (index < operation.start) {
    return index;
  }

  if (index > operation.end) {
    return index + insertedLength - removedLength;
  }

  if (index === operation.start) {
    return affinity === 'left' ? operation.start : operation.start + insertedLength;
  }

  return operation.start + insertedLength;
}

function transformOperation(
  input: CollaborationReplaceOperation,
  operations: StoredOperation[],
  currentLength: number
): CollaborationReplaceOperation {
  let start = clamp(input.start, 0, currentLength);
  let end = clamp(input.end, start, currentLength);

  operations.forEach((operation) => {
    start = transformIndex(start, operation, 'left');
    end = transformIndex(end, operation, 'right');
    end = Math.max(start, end);
  });

  return {
    ...input,
    start,
    end,
  };
}

function toParticipant(
  participant: StoredParticipant,
  sessionId: string
): CollaborationParticipant {
  return {
    session_id: participant.sessionId,
    user_name: participant.userName,
    color: participant.color,
    selection_start: participant.selectionStart,
    selection_end: participant.selectionEnd,
    is_self: participant.sessionId === sessionId,
  };
}

function getColorForUser(userName: string): string {
  const hash = Array.from(userName).reduce((value, character) => value + character.charCodeAt(0), 0);
  return COLORS[hash % COLORS.length];
}

export class CollaborationService {
  private readonly sessions = new Map<string, CollaborationSession>();

  private pruneSession(session: CollaborationSession) {
    const cutoff = Date.now() - PARTICIPANT_TTL_MS;

    Array.from(session.participants.values()).forEach((participant) => {
      if (participant.updatedAt < cutoff) {
        session.participants.delete(participant.sessionId);
      }
    });

    if (session.operations.length > OPERATION_HISTORY_LIMIT) {
      session.operations = session.operations.slice(session.operations.length - OPERATION_HISTORY_LIMIT);
    }

    if (session.participants.size === 0) {
      this.sessions.delete(session.documentId);
    }
  }

  private getOrCreateSession(documentId: string, content: string): CollaborationSession {
    const existing = this.sessions.get(documentId);
    if (existing) {
      this.pruneSession(existing);
      return this.sessions.get(documentId) ?? existing;
    }

    const session: CollaborationSession = {
      documentId,
      content,
      version: 0,
      operations: [],
      participants: new Map(),
    };
    this.sessions.set(documentId, session);
    return session;
  }

  private getCoordinatorSessionId(session: CollaborationSession): string | null {
    const participantIds = Array.from(session.participants.keys()).sort((left, right) =>
      left.localeCompare(right)
    );
    return participantIds[0] ?? null;
  }

  joinDocument(
    documentId: string,
    initialContent: string,
    userName: string,
    canEdit: boolean
  ): CollaborationJoinResponse {
    const session = this.getOrCreateSession(documentId, initialContent);
    const sessionId = randomUUID();

    session.participants.set(sessionId, {
      sessionId,
      userName,
      color: getColorForUser(userName),
      canEdit,
      selectionStart: null,
      selectionEnd: null,
      updatedAt: Date.now(),
    });

    const coordinatorSessionId = this.getCoordinatorSessionId(session);

    return {
      document_id: documentId,
      session_id: sessionId,
      content: session.content,
      version: session.version,
      participants: Array.from(session.participants.values()).map((participant) =>
        toParticipant(participant, sessionId)
      ),
      can_edit: canEdit,
      coordinator_session_id: coordinatorSessionId,
    };
  }

  syncDocument(params: {
    documentId: string;
    sessionId: string;
    operation?: CollaborationReplaceOperation;
    selectionStart: number | null;
    selectionEnd: number | null;
  }): CollaborationSyncResponse {
    const session = this.sessions.get(params.documentId);

    if (!session) {
      throw new Error(`No collaboration session found for document ${params.documentId}`);
    }

    this.pruneSession(session);

    const participant = session.participants.get(params.sessionId);
    if (!participant) {
      throw new Error(`No participant found for session ${params.sessionId}`);
    }

    participant.selectionStart = params.selectionStart;
    participant.selectionEnd = params.selectionEnd;
    participant.updatedAt = Date.now();

    if (params.operation && participant.canEdit) {
      const transformed = transformOperation(
        params.operation,
        session.operations.filter((operation) => operation.version > params.operation!.baseVersion),
        session.content.length
      );
      const start = clamp(transformed.start, 0, session.content.length);
      const end = clamp(transformed.end, start, session.content.length);

      session.content =
        session.content.slice(0, start) + transformed.text + session.content.slice(end);
      session.version += 1;
      session.operations.push({
        version: session.version,
        sessionId: params.sessionId,
        start,
        end,
        text: transformed.text,
      });
    }

    const coordinatorSessionId = this.getCoordinatorSessionId(session);

    return {
      document_id: session.documentId,
      content: session.content,
      version: session.version,
      participants: Array.from(session.participants.values()).map((entry) =>
        toParticipant(entry, params.sessionId)
      ),
      can_edit: participant.canEdit,
      coordinator_session_id: coordinatorSessionId,
    };
  }

  getState(documentId: string, sessionId: string): CollaborationSyncResponse {
    const session = this.sessions.get(documentId);
    if (!session) {
      throw new Error(`No collaboration session found for document ${documentId}`);
    }

    const participant = session.participants.get(sessionId);
    if (!participant) {
      throw new Error(`No participant found for session ${sessionId}`);
    }

    const coordinatorSessionId = this.getCoordinatorSessionId(session);

    return {
      document_id: session.documentId,
      content: session.content,
      version: session.version,
      participants: Array.from(session.participants.values()).map((entry) =>
        toParticipant(entry, sessionId)
      ),
      can_edit: participant.canEdit,
      coordinator_session_id: coordinatorSessionId,
    };
  }

  leaveDocument(documentId: string, sessionId: string) {
    const session = this.sessions.get(documentId);
    if (!session) {
      return;
    }

    session.participants.delete(sessionId);
    this.pruneSession(session);
  }
}
