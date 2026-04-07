/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  EuiAvatar,
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiConfirmModal,
  EuiFieldSearch,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiMarkdownFormat,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import { monaco } from '@osd/monaco';
import { CodeEditor } from '../../../../src/plugins/opensearch_dashboards_react/public';
import { CoreStart } from '../../../../src/core/public';
import {
  CollaborationParticipant,
  CollaborationReplaceOperation,
  DASHBOARDS_DOCS_API_BASE,
  DOC_DELETE_ACTION,
  DOC_RESOURCE_TYPE,
  DOC_UPSERT_ACTION,
  DocumentRecord,
  DocumentSummary,
  EMPTY_RESOURCE_SHARING_CONFIG,
  getAccessLevelsForType,
  PLUGIN_NAME,
  supportsResourceSharingForType,
} from '../../common';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../services/documents';
import {
  joinCollaborationSession,
  leaveCollaborationSession,
  syncCollaborationSession,
} from '../services/collaboration';
import { ShareModal } from './share_modal';
import { getResourceAccess, getSharingConfig } from '../services/sharing';

type ViewMode = 'write' | 'split' | 'preview';

interface DocsAppProps {
  coreStart: CoreStart;
}

function upsertSummary(documents: DocumentSummary[], document: DocumentRecord): DocumentSummary[] {
  const normalizedExcerpt = document.content.trim().replace(/\s+/g, ' ');
  const nextSummary: DocumentSummary = {
    id: document.id,
    title: document.title,
    excerpt: normalizedExcerpt.slice(0, 180) + (normalizedExcerpt.length > 180 ? '...' : ''),
    lastUpdatedBy: document.lastUpdatedBy,
    updatedAt: document.updatedAt,
    seqNo: document.seqNo,
    primaryTerm: document.primaryTerm,
  };

  const filtered = documents.filter((item) => item.id !== document.id);
  return [nextSummary, ...filtered].sort((left, right) => right.updatedAt - left.updatedAt);
}

function formatTimestamp(value: number): string {
  if (!value) {
    return 'Just now';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

function getErrorMessage(error: any): string {
  return (
    error?.body?.message ??
    error?.message ??
    'Something went wrong while talking to the docs service.'
  );
}

function getStatusCode(error: any): number | undefined {
  return error?.body?.statusCode ?? error?.statusCode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hasUnsavedChanges(
  persistedDocument: DocumentRecord | null,
  draftTitle: string,
  draftContent: string
): boolean {
  if (!persistedDocument) {
    return draftTitle.trim().length > 0 || draftContent.length > 0;
  }

  return draftTitle !== persistedDocument.title || draftContent !== persistedDocument.content;
}

function computeReplaceOperation(
  previousValue: string,
  nextValue: string,
  baseVersion: number
): CollaborationReplaceOperation | undefined {
  if (previousValue === nextValue) {
    return undefined;
  }

  let prefixLength = 0;
  const maxPrefix = Math.min(previousValue.length, nextValue.length);
  while (
    prefixLength < maxPrefix &&
    previousValue.charCodeAt(prefixLength) === nextValue.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let previousSuffix = previousValue.length;
  let nextSuffix = nextValue.length;
  while (
    previousSuffix > prefixLength &&
    nextSuffix > prefixLength &&
    previousValue.charCodeAt(previousSuffix - 1) === nextValue.charCodeAt(nextSuffix - 1)
  ) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }

  return {
    baseVersion,
    start: prefixLength,
    end: previousSuffix,
    text: nextValue.slice(prefixLength, nextSuffix),
  };
}

function getCollaborationSocketUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

function getEditorOffsets(editor: monaco.editor.IStandaloneCodeEditor | null): {
  start: number | null;
  end: number | null;
} {
  if (!editor) {
    return {
      start: null,
      end: null,
    };
  }

  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    return {
      start: null,
      end: null,
    };
  }

  return {
    start: model.getOffsetAt(selection.getStartPosition()),
    end: model.getOffsetAt(selection.getEndPosition()),
  };
}

function replaceEditorContent(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  nextValue: string
) {
  const model = editor?.getModel();
  if (!editor || !model || model.getValue() === nextValue) {
    return;
  }

  const selection = editor.getSelection();
  const startOffset = selection ? model.getOffsetAt(selection.getStartPosition()) : null;
  const endOffset = selection ? model.getOffsetAt(selection.getEndPosition()) : null;
  const scrollTop = editor.getScrollTop();
  const scrollLeft = editor.getScrollLeft();

  model.setValue(nextValue);

  if (startOffset !== null && endOffset !== null) {
    const nextLength = model.getValueLength();
    const nextStart = model.getPositionAt(clamp(startOffset, 0, nextLength));
    const nextEnd = model.getPositionAt(clamp(endOffset, 0, nextLength));
    editor.setSelection(
      new monaco.Range(nextStart.lineNumber, nextStart.column, nextEnd.lineNumber, nextEnd.column)
    );
  }

  editor.setScrollTop(scrollTop);
  editor.setScrollLeft(scrollLeft);
  editor.layout();
}

export function DocsApp({ coreStart }: DocsAppProps) {
  const { chrome, http, notifications } = coreStart;
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const [isShareModalVisible, setIsShareModalVisible] = useState(false);
  const [showSwitchOverlay, setShowSwitchOverlay] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Ready to write');
  const [conflictDocument, setConflictDocument] = useState<DocumentRecord | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [canDeleteDocument, setCanDeleteDocument] = useState(true);
  const [canShareDocument, setCanShareDocument] = useState(true);
  const [sharingConfig, setSharingConfig] = useState(EMPTY_RESOURCE_SHARING_CONFIG);
  const [collaborationSessionId, setCollaborationSessionId] = useState<string | null>(null);
  const [collaborationParticipants, setCollaborationParticipants] = useState<
    CollaborationParticipant[]
  >([]);
  const [coordinatorSessionId, setCoordinatorSessionId] = useState<string | null>(null);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const remoteDecorationIdsRef = useRef<string[]>([]);
  const suppressEditorChangeRef = useRef(false);
  const draftContentRef = useRef(draftContent);
  const serverShadowContentRef = useRef('');
  const serverVersionRef = useRef(0);
  const collaborationSessionIdRef = useRef<string | null>(null);
  const collaborationSocketRef = useRef<WebSocket | null>(null);

  const isSwitchingDocuments =
    isLoadingDocument && selectedDocument !== null && selectedDocument.id !== selectedId;
  const supportsSharing = supportsResourceSharingForType(sharingConfig, DOC_RESOURCE_TYPE);
  const shareAccessLevels = getAccessLevelsForType(sharingConfig, DOC_RESOURCE_TYPE);
  const isReadOnly = readOnlyReason !== null;
  const isCollaborationCoordinator =
    collaborationSessionId !== null && collaborationSessionId === coordinatorSessionId;
  const canPersistCurrentDocument =
    selectedDocument === null || collaborationSessionId === null || isCollaborationCoordinator;
  const titleIsReadOnly = isSwitchingDocuments || isReadOnly || canPersistCurrentDocument === false;

  function applyCollaborationState(payload: {
    content: string;
    version: number;
    can_edit: boolean;
    coordinator_session_id: string | null;
    participants: CollaborationParticipant[];
  }) {
    if (payload.version < serverVersionRef.current) {
      return;
    }

    serverShadowContentRef.current = payload.content;
    serverVersionRef.current = payload.version;
    setCoordinatorSessionId(payload.coordinator_session_id);
    setCollaborationParticipants(
      payload.participants.filter((participant) => participant.is_self !== true)
    );

    if (payload.can_edit === false) {
      setReadOnlyReason('You have view access to this document, but not edit access.');
      setStatusMessage('Live read-only session');
    }

    if (payload.content !== draftContentRef.current) {
      applyRemoteContent(payload.content);
    }

    if (payload.can_edit !== false) {
      setStatusMessage(
        payload.participants.length > 1 ? 'Live collaboration updated' : 'Live collaboration ready'
      );
    }
  }

  function applyRemoteContent(nextContent: string) {
    suppressEditorChangeRef.current = true;
    replaceEditorContent(editorRef.current, nextContent);
    setDraftContent(nextContent);
    draftContentRef.current = nextContent;
    suppressEditorChangeRef.current = false;
  }

  function sendCollaborationOperation(
    operation: CollaborationReplaceOperation,
    nextSelectionOffset: number
  ) {
    if (!selectedDocument || !collaborationSessionId) {
      return;
    }

    const socket = collaborationSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'operation',
          selectionStart: nextSelectionOffset,
          selectionEnd: nextSelectionOffset,
          operation,
        })
      );
      return;
    }

    void syncCollaborationSession(
      http,
      selectedDocument.id,
      collaborationSessionId,
      nextSelectionOffset,
      nextSelectionOffset,
      operation
    )
      .then((response) => {
        applyCollaborationState(response);
      })
      .catch(() => {
        setStatusMessage('Collaboration reconnecting...');
      });
  }

  useEffect(() => {
    draftContentRef.current = draftContent;
  }, [draftContent]);

  useEffect(() => {
    collaborationSessionIdRef.current = collaborationSessionId;
  }, [collaborationSessionId]);

  useEffect(() => {
    chrome.docTitle.change([PLUGIN_NAME]);
    chrome.setBreadcrumbs([{ text: PLUGIN_NAME }]);

    return () => {
      chrome.docTitle.reset();
    };
  }, [chrome]);

  useEffect(() => {
    let cancelled = false;

    async function loadSharingConfig() {
      try {
        const response = await getSharingConfig(http);
        if (!cancelled) {
          setSharingConfig(response);
        }
      } catch (error) {
        if (!cancelled) {
          setSharingConfig(EMPTY_RESOURCE_SHARING_CONFIG);
        }
      }
    }

    void loadSharingConfig();

    return () => {
      cancelled = true;
    };
  }, [http]);

  useEffect(() => {
    setIsDirty(hasUnsavedChanges(selectedDocument, draftTitle, draftContent));
  }, [draftContent, draftTitle, selectedDocument]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsLoadingList(true);

      try {
        const response = await listDocuments(http, search);
        if (cancelled) {
          return;
        }

        setDocuments(response.documents);

        if (!selectedId && !isCreatingNew && response.documents.length > 0) {
          setSelectedId(response.documents[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          setInlineError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingList(false);
        }
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [http, isCreatingNew, search, selectedId]);

  useEffect(() => {
    if (!isSwitchingDocuments) {
      setShowSwitchOverlay(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowSwitchOverlay(true);
    }, 120);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isSwitchingDocuments]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    const documentId = selectedId;

    if (selectedDocument?.id === documentId) {
      setIsLoadingDocument(false);
      return;
    }

    let cancelled = false;

    async function loadSelectedDocument() {
      setIsLoadingDocument(true);
      setInlineError(null);
      setStatusMessage('Opening document...');

      try {
        const [documentResponse, accessResponse] = await Promise.all([
          getDocument(http, documentId),
          supportsSharing
            ? getResourceAccess(http, documentId, DOC_RESOURCE_TYPE).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) {
          return;
        }

        const allowedActions = accessResponse?.access.allowed_actions ?? [];
        const canEdit = accessResponse ? allowedActions.includes(DOC_UPSERT_ACTION) : true;
        const canDelete = accessResponse ? allowedActions.includes(DOC_DELETE_ACTION) : true;
        const canShare = accessResponse ? accessResponse.access.can_share === true : true;

        setSelectedDocument(documentResponse.document);
        setDraftTitle(documentResponse.document.title);
        setDraftContent(documentResponse.document.content);
        draftContentRef.current = documentResponse.document.content;
        serverShadowContentRef.current = documentResponse.document.content;
        serverVersionRef.current = 0;
        setIsCreatingNew(false);
        setConflictDocument(null);
        setReadOnlyReason(
          canEdit ? null : 'You have view access to this document, but not edit access.'
        );
        setCanDeleteDocument(canDelete);
        setCanShareDocument(canShare);
        setStatusMessage(canEdit ? 'All changes saved' : 'Read-only access');
      } catch (error) {
        if (!cancelled) {
          setInlineError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDocument(false);
        }
      }
    }

    void loadSelectedDocument();

    return () => {
      cancelled = true;
    };
  }, [http, selectedDocument, selectedId, supportsSharing]);

  useEffect(() => {
    if (!selectedDocument) {
      setCollaborationSessionId(null);
      setCollaborationParticipants([]);
      setCoordinatorSessionId(null);
      remoteDecorationIdsRef.current = [];
      collaborationSocketRef.current?.close();
      collaborationSocketRef.current = null;
      return;
    }

    const activeDocument = selectedDocument;
    let cancelled = false;
    let joinedSessionId: string | null = null;

    async function joinSession() {
      try {
        const response = await joinCollaborationSession(http, activeDocument.id, activeDocument.content);

        if (cancelled) {
          return;
        }

        joinedSessionId = response.session_id;
        setCollaborationSessionId(response.session_id);
        setCoordinatorSessionId(response.coordinator_session_id);
        setCollaborationParticipants(
          response.participants.filter((participant) => participant.is_self !== true)
        );
        serverShadowContentRef.current = response.content;
        serverVersionRef.current = response.version;

        if (response.content !== draftContentRef.current) {
          applyRemoteContent(response.content);
        }

        if (response.can_edit === false) {
          setReadOnlyReason('You have view access to this document, but not edit access.');
          setStatusMessage('Live read-only session');
        } else {
          setStatusMessage(
            response.participants.length > 1 ? 'Live collaboration connected' : 'Live collaboration ready'
          );
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage('Collaboration unavailable');
        }
      }
    }

    void joinSession();

    return () => {
      cancelled = true;
      if (joinedSessionId) {
        void leaveCollaborationSession(http, activeDocument.id, joinedSessionId).catch(() => {
          // Presence will expire server-side if the best-effort leave fails.
        });
      }
    };
  }, [http, selectedDocument?.id]);

  useEffect(() => {
    if (!selectedDocument || !collaborationSessionId) {
      return;
    }

    const socketPath = coreStart.http.basePath.prepend(
      `${DASHBOARDS_DOCS_API_BASE}/collaboration/socket?documentId=${encodeURIComponent(
        selectedDocument.id
      )}&sessionId=${encodeURIComponent(collaborationSessionId)}`
    );
    const socket = new WebSocket(getCollaborationSocketUrl(socketPath));
    collaborationSocketRef.current = socket;

    socket.onopen = () => {
      setStatusMessage('Live collaboration connected');
      const selection = getEditorOffsets(editorRef.current);
      socket.send(
        JSON.stringify({
          type: 'selection',
          selectionStart: selection.start,
          selectionEnd: selection.end,
        })
      );
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          type?: string;
          payload?: {
            content: string;
            version: number;
            can_edit: boolean;
            coordinator_session_id: string | null;
            participants: CollaborationParticipant[];
          };
        };

        if (message.type !== 'state' || !message.payload) {
          return;
        }

        applyCollaborationState(message.payload);
      } catch (error) {
        setStatusMessage('Collaboration update failed');
      }
    };

    socket.onerror = () => {
      setStatusMessage('Collaboration reconnecting...');
    };

    socket.onclose = () => {
      if (collaborationSessionIdRef.current === collaborationSessionId) {
        setStatusMessage('Collaboration disconnected');
      }
    };

    return () => {
      socket.close();
      if (collaborationSocketRef.current === socket) {
        collaborationSocketRef.current = null;
      }
    };
  }, [collaborationSessionId, coreStart.http.basePath, selectedDocument]);

  useEffect(() => {
    if (!selectedDocument || !collaborationSessionId) {
      return;
    }

    let cancelled = false;

    const interval = window.setInterval(async () => {
      try {
        const selection = getEditorOffsets(editorRef.current);
        const response = await syncCollaborationSession(
          http,
          selectedDocument.id,
          collaborationSessionId,
          selection.start,
          selection.end
        );

        if (!cancelled) {
          applyCollaborationState(response);
        }
      } catch (error) {
        // Keep the fast reconciliation quiet; websocket remains the primary transport.
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [collaborationSessionId, http, selectedDocument]);

  useEffect(() => {
    if (!selectedId || !selectedDocument || !collaborationSessionId) {
      return;
    }

    let cancelled = false;

    const interval = window.setInterval(async () => {
      try {
        const response = await getDocument(http, selectedId);
        const latestDocument = response.document;
        const liveContent = serverShadowContentRef.current;
        const titleIsAligned =
          latestDocument.title === draftTitle || canPersistCurrentDocument === false;

        if (
          latestDocument.content === liveContent &&
          titleIsAligned &&
          (latestDocument.seqNo !== selectedDocument.seqNo ||
            latestDocument.primaryTerm !== selectedDocument.primaryTerm)
        ) {
          if (cancelled) {
            return;
          }

          setSelectedDocument(latestDocument);
          setDocuments((current) => upsertSummary(current, latestDocument));
          setConflictDocument(null);

          if (latestDocument.title !== draftTitle && canPersistCurrentDocument === false) {
            setDraftTitle(latestDocument.title);
          }

          if (hasUnsavedChanges(latestDocument, draftTitle, draftContentRef.current) === false) {
            setStatusMessage('All changes saved');
          }
        }
      } catch (error) {
        // Keep revision refresh quiet while collaboration continues.
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    canPersistCurrentDocument,
    collaborationSessionId,
    draftTitle,
    http,
    selectedDocument,
    selectedId,
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();

    if (!editor || !model) {
      return;
    }

    const decorations: monaco.editor.IModelDeltaDecoration[] = collaborationParticipants
      .filter(
        (participant) =>
          participant.selection_start !== null && participant.selection_end !== null
      )
      .flatMap((participant) => {
        const startOffset = clamp(participant.selection_start ?? 0, 0, model.getValueLength());
        const endOffset = clamp(participant.selection_end ?? startOffset, startOffset, model.getValueLength());
        const startPosition = model.getPositionAt(startOffset);
        const endPosition = model.getPositionAt(endOffset);
        const cursorRange = new monaco.Range(
          endPosition.lineNumber,
          endPosition.column,
          endPosition.lineNumber,
          endPosition.column
        );
        const entries: monaco.editor.IModelDeltaDecoration[] = [
          {
            range: cursorRange,
            options: {
              beforeContentClassName: `docsRemoteCursorMarker docsRemoteCursorMarker--${participant.color}`,
              after: {
                content: ` ${participant.user_name} `,
                inlineClassName: `docsRemoteCursorLabel docsRemoteCursorLabel--${participant.color}`,
                inlineClassNameAffectsLetterSpacing: true,
              },
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ];

        if (startOffset !== endOffset) {
          entries.push({
            range: new monaco.Range(
              startPosition.lineNumber,
              startPosition.column,
              endPosition.lineNumber,
              endPosition.column
            ),
            options: {
              className: `docsRemoteSelection docsRemoteSelection--${participant.color}`,
            },
          });
        }

        return entries;
      });

    remoteDecorationIdsRef.current = editor.deltaDecorations(
      remoteDecorationIdsRef.current,
      decorations
    );
  }, [collaborationParticipants, draftContent, viewMode]);

  useEffect(() => {
    if (!selectedId || isDirty === false || isReadOnly || collaborationSessionId !== null) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const response = await getDocument(http, selectedId);
        if (
          selectedDocument &&
          response.document.seqNo === selectedDocument.seqNo &&
          response.document.primaryTerm === selectedDocument.primaryTerm
        ) {
          return;
        }

        setDocuments((current) => upsertSummary(current, response.document));

        if (isDirty) {
          setConflictDocument(response.document);
          setStatusMessage('A newer version is available');
          return;
        }

        setSelectedDocument(response.document);
        setDraftTitle(response.document.title);
        applyRemoteContent(response.document.content);
        setStatusMessage('Document refreshed');
      } catch (error) {
        // Keep polling quiet in the background until the user acts.
      }
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [collaborationSessionId, http, isDirty, isReadOnly, selectedDocument, selectedId]);

  useEffect(() => {
    if (isDirty === false || isSaving || isReadOnly) {
      return;
    }

    if (selectedDocument && canPersistCurrentDocument === false) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void saveDocument(true);
    }, 1800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [canPersistCurrentDocument, isDirty, isReadOnly, isSaving, selectedDocument, draftContent, draftTitle]);

  async function enterReadOnlyMode() {
    if (!selectedId) {
      return;
    }

    try {
      const response = await getDocument(http, selectedId);
      setSelectedDocument(response.document);
      setDraftTitle(response.document.title);
      applyRemoteContent(response.document.content);
      serverShadowContentRef.current = response.document.content;
      setDocuments((current) => upsertSummary(current, response.document));
    } catch (error) {
      // If reload fails, keep the current document visible and still lock editing.
    }

    setConflictDocument(null);
    setInlineError(null);
    setReadOnlyReason('You have view access to this document, but not edit access.');
    setCanDeleteDocument(false);
    setCanShareDocument(false);
    setStatusMessage('Read-only access');
  }

  async function saveDocument(silent?: boolean) {
    if (isSaving || isReadOnly) {
      return;
    }

    if (selectedDocument && canPersistCurrentDocument === false) {
      if (!silent) {
        notifications.toasts.addWarning(
          'Another live editor is coordinating autosave right now. Keep typing and your changes will still sync.'
        );
      }
      return;
    }

    setIsSaving(true);
    setInlineError(null);
    setStatusMessage(selectedId ? 'Saving changes...' : 'Creating document...');

    try {
      const resolvedTitle = draftTitle.trim() || 'Untitled document';
      const payload = {
        title: resolvedTitle,
        content: draftContentRef.current,
        ...(selectedDocument
          ? {
              seqNo: selectedDocument.seqNo,
              primaryTerm: selectedDocument.primaryTerm,
            }
          : {}),
      };

      const response = selectedId
        ? await updateDocument(http, selectedId, payload)
        : await createDocument(http, payload);

      setSelectedId(response.document.id);
      setSelectedDocument(response.document);
      setDraftTitle(response.document.title);
      applyRemoteContent(response.document.content);
      serverShadowContentRef.current = response.document.content;
      setIsCreatingNew(false);
      setDocuments((current) => upsertSummary(current, response.document));
      setConflictDocument(null);
      setStatusMessage('All changes saved');
    } catch (error) {
      const statusCode = getStatusCode(error);
      if (statusCode === 409 && selectedId) {
        if (collaborationSessionId !== null) {
          const latestDocument = (await getDocument(http, selectedId)).document;

          if (
            latestDocument.content === serverShadowContentRef.current &&
            latestDocument.title === draftTitle
          ) {
            setSelectedDocument(latestDocument);
            setDocuments((current) => upsertSummary(current, latestDocument));
            setConflictDocument(null);
            setStatusMessage('Live session caught up to the latest saved version');
            return;
          }
        }

        setStatusMessage('Save conflict detected');
        setConflictDocument((await getDocument(http, selectedId)).document);
        return;
      }
      if (statusCode === 403 && selectedId) {
        await enterReadOnlyMode();
        if (!silent) {
          notifications.toasts.addWarning(
            'This document is view-only for your account. Editing has been disabled.'
          );
        }
        return;
      }

      const message = getErrorMessage(error);
      setInlineError(message);
      setStatusMessage('Save failed');
      if (!silent) {
        notifications.toasts.addDanger(message);
      }
    } finally {
      setIsSaving(false);
    }
  }

  function startNewDocument() {
    setIsCreatingNew(true);
    setSelectedId(null);
    setSelectedDocument(null);
    setDraftTitle('');
    setDraftContent('');
    draftContentRef.current = '';
    serverShadowContentRef.current = '';
    serverVersionRef.current = 0;
    setConflictDocument(null);
    setInlineError(null);
    setReadOnlyReason(null);
    setCanDeleteDocument(true);
    setCanShareDocument(true);
    setCollaborationSessionId(null);
    setCollaborationParticipants([]);
    setCoordinatorSessionId(null);
    setStatusMessage('New draft ready');
  }

  function selectDocument(documentId: string) {
    if (documentId === selectedId) {
      return;
    }

    setIsCreatingNew(false);
    setSelectedId(documentId);
    setReadOnlyReason(null);
    setCanDeleteDocument(true);
    setCanShareDocument(true);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      editorRef.current?.focus();
    }
  }

  function loadRemoteVersion() {
    if (!conflictDocument) {
      return;
    }

    setSelectedDocument(conflictDocument);
    setDraftTitle(conflictDocument.title);
    applyRemoteContent(conflictDocument.content);
    serverShadowContentRef.current = conflictDocument.content;
    setDocuments((current) => upsertSummary(current, conflictDocument));
    setConflictDocument(null);
    setStatusMessage('Loaded the latest version');
  }

  async function confirmDeleteDocument() {
    if (!selectedDocument || isDeleting) {
      return;
    }

    const documentToDelete = selectedDocument;
    const remainingDocuments = documents.filter((document) => document.id !== documentToDelete.id);

    setIsDeleting(true);
    setInlineError(null);

    try {
      await deleteDocument(
        http,
        documentToDelete.id,
        documentToDelete.seqNo,
        documentToDelete.primaryTerm
      );

      setDocuments(remainingDocuments);
      setConflictDocument(null);
      setIsDeleteModalVisible(false);
      setReadOnlyReason(null);
      setCanDeleteDocument(true);
      setCanShareDocument(true);
      notifications.toasts.addSuccess(`Deleted "${documentToDelete.title}".`);

      if (remainingDocuments.length > 0) {
        setSelectedDocument(null);
        setSelectedId(remainingDocuments[0].id);
        setIsCreatingNew(false);
        setStatusMessage('Document deleted');
        return;
      }

      setIsCreatingNew(true);
      setSelectedId(null);
      setSelectedDocument(null);
      setDraftTitle('');
      setDraftContent('');
      draftContentRef.current = '';
      setStatusMessage('Document deleted');
    } catch (error) {
      const message = getErrorMessage(error);
      setInlineError(message);
      notifications.toasts.addDanger(message);
    } finally {
      setIsDeleting(false);
    }
  }

  function handleEditorDidMount(editor: monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor;
    editor.onDidChangeCursorSelection(() => {
      const selection = getEditorOffsets(editor);
      const socket = collaborationSocketRef.current;

      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'selection',
            selectionStart: selection.start,
            selectionEnd: selection.end,
          })
        );
      }
    });
  }

  return (
    <div className="docsApp">
      <EuiPanel hasShadow={false} className="docsHero">
        <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiTitle size="l">
              <h1>Collaborative docs for Dashboards</h1>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiText color="subdued" size="s">
              Quip-style notes, markdown-ish writing, autosave, sharing, and live body editing on
              a dedicated system index.
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton fill iconType="plusInCircle" onClick={startNewDocument}>
              New document
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <div className="docsShell">
        <aside className="docsSidebar">
          <EuiPanel paddingSize="m" className="docsSidebarPanel">
            <EuiFieldSearch
              fullWidth
              compressed
              placeholder="Search documents"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <EuiSpacer size="m" />
            {isLoadingList ? (
              <div className="docsSidebarEmpty">
                <EuiLoadingSpinner size="m" />
              </div>
            ) : null}
            {!isLoadingList && documents.length === 0 ? (
              <div className="docsSidebarEmpty">
                <EuiText size="s" color="subdued">
                  No documents yet. Start the first draft.
                </EuiText>
              </div>
            ) : null}
            <div className="docsSidebarList">
              {documents.map((document) => (
                <button
                  key={document.id}
                  className={`docsSidebarItem ${
                    document.id === selectedId ? 'docsSidebarItem--active' : ''
                  }`}
                  onClick={() => selectDocument(document.id)}
                >
                  <span className="docsSidebarItemTitle">{document.title}</span>
                  <span className="docsSidebarItemMeta">
                    {document.lastUpdatedBy || 'unknown'} · {formatTimestamp(document.updatedAt)}
                  </span>
                  <span className="docsSidebarItemExcerpt">
                    {document.excerpt || 'No preview yet'}
                  </span>
                </button>
              ))}
            </div>
          </EuiPanel>
        </aside>

        <main className="docsMain">
          <EuiPanel paddingSize="l" className="docsEditorPanel">
            <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
              <EuiFlexItem>
                <EuiFieldText
                  fullWidth
                  aria-label="Document title"
                  className="docsTitleInput"
                  value={draftTitle}
                  placeholder="Untitled document"
                  readOnly={titleIsReadOnly}
                  onKeyDown={handleTitleKeyDown}
                  onChange={(event) => {
                    setDraftTitle(event.target.value);
                    setStatusMessage('Draft updated');
                  }}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <div className="docsModeSwitch">
                  <button
                    className={
                      viewMode === 'write' ? 'docsModeSwitchButton isActive' : 'docsModeSwitchButton'
                    }
                    onClick={() => setViewMode('write')}
                  >
                    Write
                  </button>
                  <button
                    className={
                      viewMode === 'split' ? 'docsModeSwitchButton isActive' : 'docsModeSwitchButton'
                    }
                    onClick={() => setViewMode('split')}
                  >
                    Split
                  </button>
                  <button
                    className={
                      viewMode === 'preview' ? 'docsModeSwitchButton isActive' : 'docsModeSwitchButton'
                    }
                    onClick={() => setViewMode('preview')}
                  >
                    Preview
                  </button>
                </div>
              </EuiFlexItem>
            </EuiFlexGroup>

            <EuiSpacer size="m" />

            <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
              <EuiFlexItem>
                <div className="docsStatusStack">
                  <div className="docsStatusRow">
                    <EuiBadge color={isDirty ? 'warning' : 'secondary'}>
                      {isReadOnly ? 'Read only' : isDirty ? 'Unsaved changes' : 'Saved'}
                    </EuiBadge>
                    {collaborationSessionId ? (
                      <EuiBadge color="primary">
                        {collaborationParticipants.length > 0
                          ? `${collaborationParticipants.length + 1} live`
                          : 'Live'}
                      </EuiBadge>
                    ) : null}
                    <span className="docsStatusText">
                      {statusMessage}
                      {selectedDocument ? ` · ${formatTimestamp(selectedDocument.updatedAt)}` : ''}
                    </span>
                  </div>

                  {collaborationSessionId ? (
                    <div className="docsPresenceRow">
                      {collaborationParticipants.length === 0 ? (
                        <span className="docsPresenceText">Only you are in this document.</span>
                      ) : (
                        <>
                          <span className="docsPresenceText">
                            {isCollaborationCoordinator
                              ? 'You are coordinating autosave for this live session.'
                              : 'Another live editor is coordinating autosave while you keep typing.'}
                          </span>
                          <div className="docsPresenceAvatars">
                            {collaborationParticipants.map((participant) => (
                              <EuiToolTip
                                key={participant.session_id}
                                content={`${participant.user_name} is editing`}
                              >
                                <EuiAvatar
                                  size="s"
                                  name={participant.user_name}
                                  initialsLength={1}
                                  className={`docsPresenceAvatar docsPresenceAvatar--${participant.color}`}
                                />
                              </EuiToolTip>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </EuiFlexItem>

              <EuiFlexItem grow={false}>
                <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                  {selectedDocument && supportsSharing ? (
                    <EuiFlexItem grow={false}>
                      <EuiButtonEmpty
                        size="s"
                        iconType="share"
                        isDisabled={isReadOnly || canShareDocument === false}
                        onClick={() => setIsShareModalVisible(true)}
                      >
                        Share
                      </EuiButtonEmpty>
                    </EuiFlexItem>
                  ) : null}
                  {selectedDocument ? (
                    <EuiFlexItem grow={false}>
                      <EuiButtonEmpty
                        color="danger"
                        size="s"
                        isDisabled={isReadOnly || canDeleteDocument === false}
                        onClick={() => setIsDeleteModalVisible(true)}
                      >
                        Delete
                      </EuiButtonEmpty>
                    </EuiFlexItem>
                  ) : null}
                  <EuiFlexItem grow={false}>
                    <EuiButton
                      fill
                      size="s"
                      isLoading={isSaving}
                      isDisabled={isReadOnly || (selectedDocument !== null && canPersistCurrentDocument === false)}
                      onClick={() => {
                        void saveDocument(false);
                      }}
                    >
                      {selectedId ? 'Save now' : 'Create document'}
                    </EuiButton>
                  </EuiFlexItem>
                </EuiFlexGroup>
              </EuiFlexItem>
            </EuiFlexGroup>

            {inlineError ? (
              <>
                <EuiSpacer size="m" />
                <EuiCallOut color="danger" iconType="alert" title={inlineError} />
              </>
            ) : null}

            {conflictDocument ? (
              <>
                <EuiSpacer size="m" />
                <EuiCallOut
                  color="warning"
                  iconType="alert"
                  title="Another editor saved a newer version of this document."
                >
                  <EuiText size="s">
                    Reload the latest version to continue editing, or keep your draft open until
                    you are ready to reconcile the changes.
                  </EuiText>
                  <EuiSpacer size="s" />
                  <EuiButtonEmpty size="s" flush="left" onClick={loadRemoteVersion}>
                    Load latest version
                  </EuiButtonEmpty>
                </EuiCallOut>
              </>
            ) : null}

            {readOnlyReason ? (
              <>
                <EuiSpacer size="m" />
                <EuiCallOut color="primary" iconType="lock" title={readOnlyReason}>
                  <EuiText size="s">
                    You can still read and preview this document, but save, delete, and sharing
                    actions are disabled for this session.
                  </EuiText>
                </EuiCallOut>
              </>
            ) : null}

            <EuiSpacer size="m" />

            <div className={`docsEditorShell docsEditorShell--${viewMode}`}>
              {viewMode !== 'preview' ? (
                <section className="docsComposerPane">
                  <div className="docsComposer">
                    {draftContent.length === 0 ? (
                      <div className="docsComposerPlaceholder">
                        Start writing markdown-ish notes with live cursors.
                      </div>
                    ) : null}
                    <CodeEditor
                      height="100%"
                      languageId="markdown"
                      value={draftContent}
                      onChange={(value) => {
                        if (suppressEditorChangeRef.current) {
                          return;
                        }

                        const previousValue = draftContentRef.current;
                        const nextValue = value ?? '';
                        draftContentRef.current = nextValue;
                        setDraftContent(nextValue);
                        const socket = collaborationSocketRef.current;
                        const operation =
                          isReadOnly || socket?.readyState !== WebSocket.OPEN
                            ? computeReplaceOperation(
                                previousValue,
                                nextValue,
                                serverVersionRef.current
                              )
                            : computeReplaceOperation(
                                previousValue,
                                nextValue,
                                serverVersionRef.current
                              );

                        if (operation) {
                          sendCollaborationOperation(
                            operation,
                            operation.start + operation.text.length
                          );
                          serverShadowContentRef.current = nextValue;
                          serverVersionRef.current += 1;
                        }

                        setStatusMessage(collaborationSessionId ? 'Live draft updated' : 'Draft updated');
                      }}
                      editorDidMount={handleEditorDidMount}
                      options={{
                        readOnly: isSwitchingDocuments || isReadOnly,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        lineNumbers: 'off',
                        glyphMargin: false,
                        folding: false,
                        wordWrap: 'on',
                        lineDecorationsWidth: 12,
                        lineNumbersMinChars: 0,
                        fontSize: 15,
                        lineHeight: 26,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        overviewRulerLanes: 0,
                        renderLineHighlight: 'none',
                        padding: {
                          top: 18,
                          bottom: 18,
                        },
                      }}
                    />
                  </div>
                </section>
              ) : null}

              {viewMode !== 'write' ? (
                <section className="docsPreviewPane">
                  <div className="docsPreviewHeader">Preview</div>
                  <div className="docsPreviewBody">
                    <EuiMarkdownFormat>
                      {draftContent || '_Nothing to preview yet. Start writing in markdown-ish text._'}
                    </EuiMarkdownFormat>
                  </div>
                </section>
              ) : null}

              {showSwitchOverlay ? (
                <div className="docsEditorOverlay" aria-live="polite">
                  <EuiLoadingSpinner size="l" />
                  <span>Opening document...</span>
                </div>
              ) : null}
              {isLoadingDocument && !isSwitchingDocuments ? (
                <div className="docsLoadingState">
                  <EuiLoadingSpinner size="xl" />
                </div>
              ) : null}
            </div>
          </EuiPanel>
        </main>
      </div>

      {isDeleteModalVisible && selectedDocument ? (
        <EuiConfirmModal
          title="Delete document?"
          onCancel={() => {
            if (!isDeleting) {
              setIsDeleteModalVisible(false);
            }
          }}
          onConfirm={() => {
            void confirmDeleteDocument();
          }}
          cancelButtonText="Keep document"
          confirmButtonText={isDeleting ? 'Deleting...' : 'Delete document'}
          buttonColor="danger"
          defaultFocusedButton="confirm"
        >
          <EuiText size="s">
            This removes <strong>{selectedDocument.title}</strong> from the docs app. The backend
            uses soft delete now, so we can preserve the record for follow-up recovery work.
          </EuiText>
        </EuiConfirmModal>
      ) : null}

      {isShareModalVisible && selectedDocument ? (
        <ShareModal
          http={http}
          isOpen={isShareModalVisible}
          resourceId={selectedDocument.id}
          resourceName={selectedDocument.title}
          resourceType={DOC_RESOURCE_TYPE}
          accessLevels={shareAccessLevels}
          onClose={() => setIsShareModalVisible(false)}
          onSave={() => {
            notifications.toasts.addSuccess(`Updated sharing for "${selectedDocument.title}".`);
          }}
        />
      ) : null}
    </div>
  );
}
