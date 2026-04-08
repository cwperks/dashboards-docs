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
  EuiIcon,
  EuiLoadingSpinner,
  EuiMarkdownFormat,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiOverlayMask,
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
  Comment,
  COMMENT_CREATE_ACTION,
  DASHBOARDS_DOCS_API_BASE,
  DOC_DELETE_ACTION,
  DOC_RESOURCE_TYPE,
  DOC_UPSERT_ACTION,
  DocumentRecord,
  DocumentSummary,
  EMPTY_RESOURCE_SHARING_CONFIG,
  FOLDER_RESOURCE_TYPE,
  FolderSummary,
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
import { createFolder, deleteFolder, listFolders } from '../services/folders';
import {
  joinCollaborationSession,
  leaveCollaborationSession,
  syncCollaborationSession,
} from '../services/collaboration';
import { ShareModal } from './share_modal';
import { CommentPanel } from './comment_panel';
import { getResourceAccess, getSharingConfig } from '../services/sharing';
import { listComments, createComment, deleteComment } from '../services/comments';

type ViewMode = 'write' | 'split' | 'preview';

interface DocsAppProps {
  coreStart: CoreStart;
}

interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
  parentId: string;
  depth: number;
  documents: DocumentSummary[];
  children: FolderTreeNode[];
}

interface FolderTree {
  ungroupedDocuments: DocumentSummary[];
  rootFolders: FolderTreeNode[];
}

function normalizeFolderName(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

function buildFolderTree(folders: FolderSummary[], documents: DocumentSummary[]): FolderTree {
  const ungroupedDocuments: DocumentSummary[] = [];
  const rootFolders: FolderTreeNode[] = [];
  const nodesById = new Map<string, FolderTreeNode>();

  folders.forEach((folder) => {
    nodesById.set(folder.id, {
      id: folder.id,
      name: folder.name,
      path: folder.path,
      parentId: folder.parentId,
      depth: Math.max(folder.path.split('/').length - 1, 0),
      documents: [],
      children: [],
    });
  });

  folders.forEach((folder) => {
    const node = nodesById.get(folder.id);
    if (!node) {
      return;
    }

    if (folder.parentId) {
      const parentNode = nodesById.get(folder.parentId);
      if (parentNode) {
        parentNode.children.push(node);
        return;
      }
    }

    rootFolders.push(node);
  });

  documents.forEach((document) => {
    if (!document.folderId) {
      ungroupedDocuments.push(document);
      return;
    }

    const folderNode = nodesById.get(document.folderId);
    if (!folderNode) {
      ungroupedDocuments.push(document);
      return;
    }

    folderNode.documents.push(document);
  });

  function sortNode(node: FolderTreeNode) {
    node.children.sort((left, right) => left.name.localeCompare(right.name));
    node.children.forEach(sortNode);
  }

  rootFolders.sort((left, right) => left.name.localeCompare(right.name));
  rootFolders.forEach(sortNode);

  return {
    ungroupedDocuments,
    rootFolders,
  };
}

function upsertSummary(documents: DocumentSummary[], document: DocumentRecord): DocumentSummary[] {
  const normalizedExcerpt = document.content.trim().replace(/\s+/g, ' ');
  const nextSummary: DocumentSummary = {
    id: document.id,
    title: document.title,
    folderId: document.folderId,
    folderPath: document.folderPath,
    excerpt: normalizedExcerpt.slice(0, 180) + (normalizedExcerpt.length > 180 ? '...' : ''),
    lastUpdatedBy: document.lastUpdatedBy,
    updatedAt: document.updatedAt,
    seqNo: document.seqNo,
    primaryTerm: document.primaryTerm,
  };

  const filtered = documents.filter((item) => item.id !== document.id);
  return [nextSummary, ...filtered].sort((left, right) => right.updatedAt - left.updatedAt);
}

function upsertFolderSummary(folders: FolderSummary[], folder: FolderSummary): FolderSummary[] {
  const filtered = folders.filter((item) => item.id !== folder.id);
  return [...filtered, folder].sort((left, right) => left.path.localeCompare(right.path));
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
  draftContent: string,
  draftFolderId: string
): boolean {
  if (!persistedDocument) {
    return draftTitle.trim().length > 0 || draftContent.length > 0 || draftFolderId.length > 0;
  }

  return (
    draftTitle !== persistedDocument.title ||
    draftContent !== persistedDocument.content ||
    draftFolderId !== persistedDocument.folderId
  );
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
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftFolder, setDraftFolder] = useState('');
  const [draftFolderId, setDraftFolderId] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMovingDocument, setIsMovingDocument] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const [isMoveModalVisible, setIsMoveModalVisible] = useState(false);
  const [isShareModalVisible, setIsShareModalVisible] = useState(false);
  const [shareFolderId, setShareFolderId] = useState<string | null>(null);
  const [shareFolderName, setShareFolderName] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [dragDocumentId, setDragDocumentId] = useState<string | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; parentId: string | null; documentId?: string | null } | null>(null);
  const [createDocInFolderId, setCreateDocInFolderId] = useState<string | null>(null);
  const [isCreatingDocInline, setIsCreatingDocInline] = useState(false);
  const [inlineDocFolderId, setInlineDocFolderId] = useState<string | null>(null);
  const [inlineDocName, setInlineDocName] = useState('');
  const [moveFolderValue, setMoveFolderValue] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [showSwitchOverlay, setShowSwitchOverlay] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Ready to write');
  const [conflictDocument, setConflictDocument] = useState<DocumentRecord | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [canDeleteDocument, setCanDeleteDocument] = useState(true);
  const [canShareDocument, setCanShareDocument] = useState(true);
  const [canComment, setCanComment] = useState(true);
  const canCommentRef = useRef(true);
  const [comments, setComments] = useState<Comment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [editorSelection, setEditorSelection] = useState<{ start: number; end: number; lineLabel?: string; anchorType: 'doc' | 'line' | 'range' } | null>(null);
  const [currentUserName, setCurrentUserName] = useState('unknown');
  const [sharingConfig, setSharingConfig] = useState(EMPTY_RESOURCE_SHARING_CONFIG);
  const [collaborationSessionId, setCollaborationSessionId] = useState<string | null>(null);
  const [collaborationParticipants, setCollaborationParticipants] = useState<
    CollaborationParticipant[]
  >([]);
  const [coordinatorSessionId, setCoordinatorSessionId] = useState<string | null>(null);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const remoteDecorationIdsRef = useRef<string[]>([]);
  const commentDecorationIdsRef = useRef<string[]>([]);
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
  const folderTree = buildFolderTree(folders, documents);
  const existingFolderNames = Array.from(
    new Set(folders.map((folder) => normalizeFolderName(folder.path)).filter((name) => name.length > 0))
  ).sort((left, right) => left.localeCompare(right));

  function isFolderExpanded(path: string): boolean {
    return expandedFolders[path] ?? true;
  }

  function toggleFolderExpanded(path: string) {
    setExpandedFolders((current) => ({
      ...current,
      [path]: !(current[path] ?? true),
    }));
  }

  const currentFolder = currentFolderId ? folders.find((f) => f.id === currentFolderId) : null;

  async function handleCreateDocInline() {
    const title = inlineDocName.trim() || 'Untitled document';
    try {
      const response = await createDocument(http, {
        title,
        content: '',
        folderId: inlineDocFolderId || null,
      });
      setDocuments((current) => upsertSummary(current, response.document));
      setInlineDocName('');
      setIsCreatingDocInline(false);
      setInlineDocFolderId(null);
      selectDocument(response.document.id);
    } catch (error: any) {
      const message = error?.body?.message || error?.message || String(error);
      notifications.toasts.addDanger(`Failed to create document: ${message}`);
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const parentId = newFolderParentId ?? currentFolderId;
      const response = await createFolder(http, { name, parentId });
      setFolders((current) => [...current, response.folder]);
      setNewFolderName('');
      setIsCreatingFolder(false);
      setContextMenu(null);
    } catch (error: any) {
      const message = error?.body?.message || error?.message || String(error);
      if (message.toLowerCase().includes('already exists')) {
        notifications.toasts.addWarning(`A folder named "${name}" already exists here.`);
      } else {
        notifications.toasts.addDanger(`Failed to create folder: ${message}`);
      }
    }
  }

  async function handleDropDocumentOnFolder(documentId: string, folderId: string) {
    const doc = documents.find((d) => d.id === documentId);
    const folder = folders.find((f) => f.id === folderId);
    if (!doc || !folder) return;
    try {
      const response = await updateDocument(http, documentId, {
        title: doc.title,
        content: '', // content is not in summary, will be preserved by backend
        folderId,
        seqNo: doc.seqNo,
        primaryTerm: doc.primaryTerm,
      });
      setDocuments((current) => upsertSummary(current, response.document));
      notifications.toasts.addSuccess(`Moved "${doc.title}" to "${folder.path}".`);
    } catch (error) {
      notifications.toasts.addDanger(`Failed to move document: ${error}`);
    }
    setDragDocumentId(null);
    setDropTargetFolderId(null);
  }
  const currentFolderDocs = currentFolderId
    ? documents.filter((d) => d.folderId === currentFolderId)
    : [];
  const currentSubfolders = currentFolderId
    ? folders.filter((f) => f.parentId === currentFolderId)
    : [];

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
    let cancelled = false;

    async function loadFolderList() {
      try {
        const response = await listFolders(http);
        if (!cancelled) {
          setFolders(response.folders);
        }
      } catch (error) {
        if (!cancelled) {
          setInlineError(getErrorMessage(error));
        }
      }
    }

    void loadFolderList();

    return () => {
      cancelled = true;
    };
  }, [http]);

  useEffect(() => {
    setIsDirty(hasUnsavedChanges(selectedDocument, draftTitle, draftContent, draftFolderId));
  }, [draftContent, draftFolderId, draftTitle, selectedDocument]);

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
        const userCanComment = accessResponse ? allowedActions.includes(COMMENT_CREATE_ACTION) : true;

        setSelectedDocument(documentResponse.document);
        setCanComment(userCanComment);
        canCommentRef.current = userCanComment;
        setDraftTitle(documentResponse.document.title);
        setDraftContent(documentResponse.document.content);
        setDraftFolder(documentResponse.document.folderPath);
        setDraftFolderId(documentResponse.document.folderId);
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
        const selfParticipant = response.participants.find((p) => p.is_self === true);
        if (selfParticipant) setCurrentUserName(selfParticipant.user_name);
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

  // Load comments when document changes
  useEffect(() => {
    if (!selectedDocument) {
      setComments([]);
      return;
    }
    let cancelled = false;
    listComments(http, selectedDocument.id)
      .then((response) => {
        if (!cancelled) setComments(response.comments);
      })
      .catch(() => {
        if (!cancelled) setComments([]);
      });
    return () => { cancelled = true; };
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
          if (latestDocument.folderPath !== draftFolder && canPersistCurrentDocument === false) {
            setDraftFolder(latestDocument.folderPath);
            setDraftFolderId(latestDocument.folderId);
          }

          if (
            hasUnsavedChanges(
              latestDocument,
              draftTitle,
              draftContentRef.current,
              draftFolderId
            ) === false
          ) {
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
    draftFolder,
    draftFolderId,
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

  // Render comment highlight decorations
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (comments.length === 0) {
      if (editor) {
        commentDecorationIdsRef.current = editor.deltaDecorations(commentDecorationIdsRef.current, []);
      }
      return;
    }
    const model = editor.getModel();
    if (!model) return;

    const inlineDecorations: monaco.editor.IModelDeltaDecoration[] = comments
      .filter((c) => c.startOffset !== c.endOffset && c.startOffset >= 0 && c.endOffset <= model.getValueLength())
      .map((comment) => {
        const startPos = model.getPositionAt(comment.startOffset);
        const endPos = model.getPositionAt(comment.endOffset);
        return {
          range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
          options: {
            className: 'docsCommentHighlight',
            hoverMessage: { value: `**${comment.owner}**: ${comment.commentText}` },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      });

    // Add glyph icons on lines that have comments
    const commentedLines = new Set<number>();
    comments.forEach((c) => {
      if (c.startOffset !== c.endOffset && c.startOffset >= 0 && c.endOffset <= model.getValueLength()) {
        commentedLines.add(model.getPositionAt(c.startOffset).lineNumber);
      }
    });
    const glyphDecorations: monaco.editor.IModelDeltaDecoration[] = Array.from(commentedLines).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'docsCommentGlyph',
        glyphMarginHoverMessage: { value: 'Click to view comments' },
      },
    }));

    commentDecorationIdsRef.current = editor.deltaDecorations(
      commentDecorationIdsRef.current,
      [...inlineDecorations, ...glyphDecorations]
    );
  }, [comments, draftContent]);

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
        setDraftFolder(response.document.folderPath);
        setDraftFolderId(response.document.folderId);
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
  }, [
    canPersistCurrentDocument,
    draftContent,
    draftFolder,
    draftFolderId,
    draftTitle,
    isDirty,
    isReadOnly,
    isSaving,
    selectedDocument,
  ]);

  async function enterReadOnlyMode() {
    if (!selectedId) {
      return;
    }

    try {
      const response = await getDocument(http, selectedId);
      setSelectedDocument(response.document);
      setDraftTitle(response.document.title);
      setDraftFolder(response.document.folderPath);
      setDraftFolderId(response.document.folderId);
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
        folderId: draftFolderId || null,
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
      setDraftFolder(response.document.folderPath);
      setDraftFolderId(response.document.folderId);
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
            latestDocument.title === draftTitle &&
            latestDocument.folderId === draftFolderId
          ) {
            setSelectedDocument(latestDocument);
            setDocuments((current) => upsertSummary(current, latestDocument));
            setDraftFolder(latestDocument.folderPath);
            setDraftFolderId(latestDocument.folderId);
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
    setDraftFolder('');
    setDraftFolderId('');
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
    setDraftFolder(conflictDocument.folderPath);
    setDraftFolderId(conflictDocument.folderId);
    applyRemoteContent(conflictDocument.content);
    serverShadowContentRef.current = conflictDocument.content;
    setDocuments((current) => upsertSummary(current, conflictDocument));
    setConflictDocument(null);
    setStatusMessage('Loaded the latest version');
  }

  function openMoveModal() {
    if (!selectedDocument) {
      return;
    }

    setMoveFolderValue(draftFolder);
    setIsMoveModalVisible(true);
  }

  async function resolveOrCreateFolderPath(targetPath: string): Promise<FolderSummary | null> {
    const normalizedPath = normalizeFolderName(targetPath);
    if (!normalizedPath) {
      return null;
    }

    let knownFolders = [...folders];
    let parentId = '';
    let currentPath = '';
    let currentFolder: FolderSummary | null = null;

    for (const segment of normalizedPath.split('/')) {
      const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
      let nextFolder =
        knownFolders.find(
          (folder) => folder.path === nextPath && (folder.parentId || '') === parentId
        ) ?? null;

      if (!nextFolder) {
        const response = await createFolder(http, {
          name: segment,
          parentId: parentId || null,
        });
        nextFolder = response.folder;
        knownFolders = upsertFolderSummary(knownFolders, nextFolder);
        setFolders((current) => upsertFolderSummary(current, nextFolder!));
      }

      currentFolder = nextFolder;
      parentId = nextFolder.id;
      currentPath = nextFolder.path;
    }

    return currentFolder;
  }

  async function confirmMoveDocument() {
    if (!selectedDocument || isMovingDocument || isReadOnly) {
      return;
    }

    if (isSaving) {
      notifications.toasts.addWarning(
        'A save is still finishing. Try moving the document again in a moment.'
      );
      return;
    }

    setIsMovingDocument(true);
    setInlineError(null);

    try {
      const nextFolderPath = normalizeFolderName(moveFolderValue);
      const nextFolder = await resolveOrCreateFolderPath(nextFolderPath);
      const latestDocument = (await getDocument(http, selectedDocument.id)).document;

      setSelectedDocument(latestDocument);
      setDocuments((current) => upsertSummary(current, latestDocument));

      const response = await updateDocument(http, selectedDocument.id, {
        title: draftTitle.trim() || 'Untitled document',
        content: draftContentRef.current,
        folderId: nextFolder?.id ?? null,
        seqNo: latestDocument.seqNo,
        primaryTerm: latestDocument.primaryTerm,
      });

      setSelectedDocument(response.document);
      setDraftTitle(response.document.title);
      setDraftFolder(response.document.folderPath);
      setDraftFolderId(response.document.folderId);
      applyRemoteContent(response.document.content);
      serverShadowContentRef.current = response.document.content;
      setDocuments((current) => upsertSummary(current, response.document));
      setIsMoveModalVisible(false);
      setMoveFolderValue(response.document.folderPath);
      setConflictDocument(null);
      setCanShareDocument(true);
      setStatusMessage(response.document.folderPath ? 'Moved to folder' : 'Moved back to Ungrouped');
      notifications.toasts.addSuccess(
        response.document.folderPath
          ? `Moved "${response.document.title}" to "${response.document.folderPath}".`
          : `Moved "${response.document.title}" to Ungrouped.`
      );
    } catch (error) {
      const statusCode = getStatusCode(error);
      if (statusCode === 403) {
        await enterReadOnlyMode();
      } else if (statusCode === 409 && selectedDocument) {
        setStatusMessage('Move conflict detected');
        setConflictDocument((await getDocument(http, selectedDocument.id)).document);
      } else {
        const message = getErrorMessage(error);
        setInlineError(message);
        setStatusMessage('Move failed');
        notifications.toasts.addDanger(message);
      }
    } finally {
      setIsMovingDocument(false);
    }
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
      setDraftFolder('');
      setDraftFolderId('');
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
    let gutterClickActive = false;

    editor.onDidChangeCursorSelection(() => {
      if (gutterClickActive) {
        gutterClickActive = false;
        return;
      }
      const selection = getEditorOffsets(editor);
      setEditorSelection(
        selection.start !== null && selection.end !== null && selection.start !== selection.end
          ? { start: selection.start, end: selection.end, anchorType: 'range' }
          : null
      );
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

    // Comment glyph on line number click
    editor.onMouseDown((e) => {
      const targetType = e.target.type;
      // Debug: uncomment to see what type glyph clicks produce
      // console.log('mouseDown type:', targetType, 'position:', e.target.position, 'range:', e.target.range);

      if (
        targetType === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        targetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        targetType === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      ) {
        const target = e.target as any;
        const lineNumber = target.position?.lineNumber as number | undefined;
        if (!lineNumber) return;
        const model = editor.getModel();
        if (!model) return;
        const lineStart = model.getOffsetAt({ lineNumber, column: 1 });
        const lineEnd = model.getOffsetAt({ lineNumber, column: model.getLineMaxColumn(lineNumber) });
        gutterClickActive = true;
        setEditorSelection({ start: lineStart, end: lineEnd, lineLabel: `Line ${lineNumber}`, anchorType: 'line' });
        setShowComments(true);
        editor.setSelection(new monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)));
      }
    });

    // Show + icon on gutter hover
    let hoverDecorations: string[] = [];
    editor.onMouseMove((e) => {
      if (
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      ) {
        const line = e.target.position?.lineNumber;
        if (line) {
          hoverDecorations = editor.deltaDecorations(hoverDecorations, [{
            range: new monaco.Range(line, 1, line, 1),
            options: { glyphMarginClassName: 'docsCommentGlyphHover' },
          }]);
          return;
        }
      }
      hoverDecorations = editor.deltaDecorations(hoverDecorations, []);
    });

    editor.onMouseLeave(() => {
      hoverDecorations = editor.deltaDecorations(hoverDecorations, []);
    });
  }

  function renderSidebarDocument(document: DocumentSummary, depth: number) {
    return (
      <button
        key={document.id}
        className={`docsSidebarItem ${
          document.id === selectedId ? 'docsSidebarItem--active' : ''
        }`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', document.id);
          setDragDocumentId(document.id);
        }}
        onDragEnd={() => {
          setDragDocumentId(null);
          setDropTargetFolderId(null);
        }}
        onClick={() => selectDocument(document.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, parentId: null, documentId: document.id });
        }}
        style={{ marginLeft: `${depth * 18}px` }}
      >
        <span className="docsSidebarItemTitle">{document.title}</span>
        <span className="docsSidebarItemMeta">
          {document.lastUpdatedBy || 'unknown'} · {formatTimestamp(document.updatedAt)}
        </span>
        <span className="docsSidebarItemExcerpt">{document.excerpt || 'No preview yet'}</span>
      </button>
    );
  }

  function renderFolderNode(node: FolderTreeNode) {
    const expanded = isFolderExpanded(node.path);

    return (
      <div key={node.path} className="docsSidebarTreeBranch">
        <div className="docsSidebarFolderHeader" style={{ marginLeft: `${node.depth * 18}px` }}>
          <button
            type="button"
            className={`docsSidebarFolderRow ${dropTargetFolderId === node.id ? 'docsSidebarFolderRow--dropTarget' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, parentId: node.id });
            }}
            onDoubleClick={() => setCurrentFolderId(node.id)}
            onClick={() => toggleFolderExpanded(node.path)}
            onDragOver={(e) => {
              e.preventDefault();
              setDropTargetFolderId(node.id);
            }}
            onDragLeave={() => setDropTargetFolderId(null)}
            onDrop={(e) => {
              e.preventDefault();
              const docId = e.dataTransfer.getData('text/plain');
              if (docId) handleDropDocumentOnFolder(docId, node.id);
            }}
          >
            <EuiIcon
              type={expanded ? 'arrowDown' : 'arrowRight'}
              size="s"
              className="docsSidebarFolderChevron"
            />
            <EuiIcon type="folderClosed" size="s" className="docsSidebarFolderIcon" />
            <span className="docsSidebarFolderLabel">{node.name}</span>
            <span className="docsSidebarFolderCount">
              {node.documents.length + node.children.length}
            </span>
          </button>
        </div>
        {expanded ? (
          <div className="docsSidebarTreeChildren">
            {isCreatingDocInline && inlineDocFolderId === node.id ? (
              <div className="docsSidebarInlineInput" style={{ marginLeft: `${(node.depth + 1) * 18}px` }}>
                <EuiIcon type="document" size="s" className="docsSidebarInlineInputIcon" />
                <input className="docsSidebarInlineInputField" placeholder="Document name" value={inlineDocName}
                  onChange={(e) => setInlineDocName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDocInline(); if (e.key === 'Escape') { setIsCreatingDocInline(false); setInlineDocName(''); } }}
                  autoFocus />
                <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingDocInline(false); setInlineDocName(''); }}><EuiIcon type="cross" size="s" /></button>
              </div>
            ) : null}
            {isCreatingFolder && newFolderParentId === node.id ? (
              <div className="docsSidebarInlineInput" style={{ marginLeft: `${(node.depth + 1) * 18}px` }}>
                <EuiIcon type="folderClosed" size="s" className="docsSidebarInlineInputIcon" />
                <input className="docsSidebarInlineInputField" placeholder="Folder name" value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); } }}
                  autoFocus />
                <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}><EuiIcon type="cross" size="s" /></button>
              </div>
            ) : null}
            {node.documents.map((document) => renderSidebarDocument(document, node.depth + 1))}
            {node.children.map((childNode) => renderFolderNode(childNode))}
          </div>
        ) : null}
      </div>
    );
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
            <div
              className="docsSidebarList"
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, parentId: currentFolderId });
              }}
            >
              {currentFolderId && currentFolder ? (
                <div className="docsSidebarSection">
                  <div className="docsFolderNav">
                    <button
                      type="button"
                      className="docsFolderNavBack"
                      onClick={() => setCurrentFolderId(currentFolder.parentId || null)}
                    >
                      <EuiIcon type="arrowLeft" size="s" />
                      <span>Back</span>
                    </button>
                    <span className="docsFolderNavTitle">{currentFolder.path}</span>
                    {supportsResourceSharingForType(sharingConfig, FOLDER_RESOURCE_TYPE) ? (
                      <button
                        type="button"
                        className="docsFolderNavShare"
                        onClick={() => {
                          setShareFolderId(currentFolder.id);
                          setShareFolderName(currentFolder.path);
                        }}
                      >
                        <EuiIcon type="share" size="s" />
                        <span>Share</span>
                      </button>
                    ) : null}
                  </div>
                  {currentSubfolders.length > 0 ? (
                    <div className="docsSidebarSectionItems">
                      {currentSubfolders.map((subfolder) => (
                        <div key={subfolder.id}>
                          <button
                            type="button"
                            className="docsSidebarFolderRow"
                            onClick={() => setCurrentFolderId(subfolder.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setContextMenu({ x: e.clientX, y: e.clientY, parentId: subfolder.id });
                            }}
                          >
                            <EuiIcon type="folderClosed" size="s" className="docsSidebarFolderIcon" />
                            <span className="docsSidebarFolderLabel">{subfolder.name}</span>
                            <EuiIcon type="arrowRight" size="s" className="docsSidebarFolderChevron" />
                          </button>
                          {isCreatingDocInline && inlineDocFolderId === subfolder.id ? (
                            <div className="docsSidebarInlineInput" style={{ paddingLeft: '18px' }}>
                              <EuiIcon type="document" size="s" className="docsSidebarInlineInputIcon" />
                              <input className="docsSidebarInlineInputField" placeholder="Document name" value={inlineDocName}
                                onChange={(e) => setInlineDocName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDocInline(); if (e.key === 'Escape') { setIsCreatingDocInline(false); setInlineDocName(''); } }}
                                autoFocus />
                              <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingDocInline(false); setInlineDocName(''); }}><EuiIcon type="cross" size="s" /></button>
                            </div>
                          ) : null}
                          {isCreatingFolder && newFolderParentId === subfolder.id ? (
                            <div className="docsSidebarInlineInput" style={{ paddingLeft: '18px' }}>
                              <EuiIcon type="folderClosed" size="s" className="docsSidebarInlineInputIcon" />
                              <input className="docsSidebarInlineInputField" placeholder="Folder name" value={newFolderName}
                                onChange={(e) => setNewFolderName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); } }}
                                autoFocus />
                              <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}><EuiIcon type="cross" size="s" /></button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="docsSidebarSectionItems">
                    {currentFolderDocs.map((document) => renderSidebarDocument(document, 0))}
                    {isCreatingDocInline && inlineDocFolderId === currentFolderId ? (
                      <div className="docsSidebarInlineInput">
                        <EuiIcon type="document" size="s" className="docsSidebarInlineInputIcon" />
                        <input className="docsSidebarInlineInputField" placeholder="Document name" value={inlineDocName}
                          onChange={(e) => setInlineDocName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDocInline(); if (e.key === 'Escape') { setIsCreatingDocInline(false); setInlineDocName(''); } }}
                          autoFocus />
                        <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingDocInline(false); setInlineDocName(''); }}><EuiIcon type="cross" size="s" /></button>
                      </div>
                    ) : null}
                  </div>
                  {isCreatingFolder && newFolderParentId === currentFolderId ? (
                    <div className="docsSidebarInlineInput">
                      <EuiIcon type="folderClosed" size="s" className="docsSidebarInlineInputIcon" />
                      <input className="docsSidebarInlineInputField" placeholder="Folder name" value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); } }}
                        autoFocus />
                      <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}><EuiIcon type="cross" size="s" /></button>
                    </div>
                  ) : null}
                  {currentFolderDocs.length === 0 && currentSubfolders.length === 0 && !isCreatingDocInline && !isCreatingFolder ? (
                    <div className="docsSidebarEmpty">
                      <EuiText size="s" color="subdued">This folder is empty.</EuiText>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {folderTree.ungroupedDocuments.length > 0 || (isCreatingDocInline && !inlineDocFolderId) ? (
                    <div className="docsSidebarSection">
                      <div className="docsSidebarSectionLabel">Ungrouped</div>
                      <div className="docsSidebarSectionItems">
                        {folderTree.ungroupedDocuments.map((document) =>
                          renderSidebarDocument(document, 0)
                        )}
                        {isCreatingDocInline && !inlineDocFolderId ? (
                          <div className="docsSidebarInlineInput">
                            <EuiIcon type="document" size="s" className="docsSidebarInlineInputIcon" />
                            <input
                              className="docsSidebarInlineInputField"
                              placeholder="Document name"
                              value={inlineDocName}
                              onChange={(e) => setInlineDocName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCreateDocInline();
                                if (e.key === 'Escape') { setIsCreatingDocInline(false); setInlineDocName(''); }
                              }}
                              autoFocus
                            />
                            <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingDocInline(false); setInlineDocName(''); }}>
                              <EuiIcon type="cross" size="s" />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  <div className="docsSidebarSection">
                    <div className="docsSidebarSectionLabel">
                      Folders
                      <button
                        type="button"
                        className="docsSidebarNewFolderButton"
                        onClick={() => setIsCreatingFolder(true)}
                      >
                        + New
                      </button>
                    </div>
                    {isCreatingFolder && !newFolderParentId ? (
                      <div className="docsSidebarInlineInput">
                        <EuiIcon type="folderClosed" size="s" className="docsSidebarInlineInputIcon" />
                        <input
                          className="docsSidebarInlineInputField"
                          placeholder="Folder name"
                          value={newFolderName}
                          onChange={(e) => setNewFolderName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreateFolder();
                            if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); }
                          }}
                          autoFocus
                        />
                        <button type="button" className="docsSidebarInlineInputCancel" onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}>
                          <EuiIcon type="cross" size="s" />
                        </button>
                      </div>
                    ) : null}
                    {folderTree.rootFolders.length > 0 ? (
                      <div className="docsSidebarTree">{folderTree.rootFolders.map(renderFolderNode)}</div>
                    ) : null}
                  </div>
                </>
              )}
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
                    {selectedDocument ? (
                      <EuiBadge color="hollow">
                        {normalizeFolderName(draftFolder) || 'Ungrouped'}
                      </EuiBadge>
                    ) : null}
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
                        size="s"
                        iconType="editorComment"
                        onClick={() => setShowComments((v) => !v)}
                        color={showComments ? 'primary' : 'text'}
                      >
                        Comments{comments.length > 0 ? ` (${comments.length})` : ''}
                      </EuiButtonEmpty>
                    </EuiFlexItem>
                  ) : null}
                  {selectedDocument ? (
                    <EuiFlexItem grow={false}>
                      <EuiButtonEmpty
                        size="s"
                        iconType="folderClosed"
                        isDisabled={isReadOnly || canPersistCurrentDocument === false}
                        onClick={openMoveModal}
                      >
                        Move
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
                        lineNumbers: 'on',
                        glyphMargin: true,
                        glyphMarginWidth: 20,
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

        {showComments && selectedDocument ? (
          <CommentPanel
            comments={comments}
            currentUser={currentUserName}
            canComment={canComment}
            selectionRange={editorSelection}
            onClearSelection={() => setEditorSelection(null)}
            onAddComment={async (text, startOffset, endOffset) => {
              try {
                const response = await createComment(http, {
                  documentId: selectedDocument.id,
                  commentText: text,
                  startOffset,
                  endOffset,
                });
                setComments((current) => [...current, response.comment]);
              } catch (error: any) {
                notifications.toasts.addDanger(`Failed to add comment: ${error?.message || error}`);
              }
            }}
            onReply={async (threadId, text) => {
              // Inherit the root comment's anchor
              const rootComment = comments.find((c) => c.threadId === threadId && c.id === threadId);
              try {
                const response = await createComment(http, {
                  documentId: selectedDocument.id,
                  threadId,
                  commentText: text,
                  startOffset: rootComment?.startOffset ?? 0,
                  endOffset: rootComment?.endOffset ?? 0,
                });
                setComments((current) => [...current, response.comment]);
              } catch (error: any) {
                notifications.toasts.addDanger(`Failed to reply: ${error?.message || error}`);
              }
            }}
            onDelete={async (comment) => {
              try {
                await deleteComment(http, comment.id, comment.seqNo, comment.primaryTerm);
                setComments((current) => current.filter((c) => c.id !== comment.id));
              } catch (error: any) {
                notifications.toasts.addDanger(`Failed to delete comment: ${error?.message || error}`);
              }
            }}
            onScrollTo={(comment) => {
              const editor = editorRef.current;
              if (!editor || comment.startOffset === comment.endOffset) return;
              const model = editor.getModel();
              if (!model) return;
              const pos = model.getPositionAt(comment.startOffset);
              editor.revealLineInCenter(pos.lineNumber);
              editor.setSelection(
                new monaco.Range(
                  model.getPositionAt(comment.startOffset).lineNumber,
                  model.getPositionAt(comment.startOffset).column,
                  model.getPositionAt(comment.endOffset).lineNumber,
                  model.getPositionAt(comment.endOffset).column
                )
              );
            }}
          />
        ) : null}
      </div>

      {isMoveModalVisible && selectedDocument ? (
        <EuiOverlayMask>
          <EuiModal
            onClose={() => {
              if (!isMovingDocument) {
                setIsMoveModalVisible(false);
              }
            }}
            initialFocus="[name=folderName]"
          >
            <EuiModalHeader>
              <EuiModalHeaderTitle>Move document</EuiModalHeaderTitle>
            </EuiModalHeader>
            <EuiModalBody>
              <EuiText size="s">
                Move <strong>{selectedDocument.title}</strong> into a folder. Leave the field
                blank to keep it ungrouped, or use <code>/</code> to create nested folders like{' '}
                <code>Team/Plans/Q2</code>.
              </EuiText>
              <EuiSpacer size="m" />
              <EuiFieldText
                fullWidth
                name="folderName"
                value={moveFolderValue}
                placeholder="Folder path, e.g. Team/Plans/Q2"
                onChange={(event) => setMoveFolderValue(event.target.value)}
                disabled={isMovingDocument}
              />
              {existingFolderNames.length > 0 ? (
                <>
                  <EuiSpacer size="m" />
                  <div className="docsFolderSuggestions">
                    {existingFolderNames.map((folderName) => (
                      <button
                        key={folderName}
                        className="docsFolderSuggestion"
                        onClick={() => setMoveFolderValue(folderName)}
                        type="button"
                      >
                        {folderName}
                      </button>
                    ))}
                    <button
                      className="docsFolderSuggestion"
                      onClick={() => setMoveFolderValue('')}
                      type="button"
                    >
                      Ungrouped
                    </button>
                  </div>
                </>
              ) : null}
            </EuiModalBody>
            <EuiModalFooter>
              <EuiButtonEmpty
                onClick={() => {
                  if (!isMovingDocument) {
                    setIsMoveModalVisible(false);
                  }
                }}
                disabled={isMovingDocument}
              >
                Cancel
              </EuiButtonEmpty>
              <EuiButton
                fill
                onClick={() => {
                  void confirmMoveDocument();
                }}
                isLoading={isMovingDocument}
              >
                Move document
              </EuiButton>
            </EuiModalFooter>
          </EuiModal>
        </EuiOverlayMask>
      ) : null}

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

      {shareFolderId && shareFolderName ? (
        <ShareModal
          http={http}
          isOpen={true}
          resourceId={shareFolderId}
          resourceName={shareFolderName}
          resourceType={FOLDER_RESOURCE_TYPE}
          accessLevels={getAccessLevelsForType(sharingConfig, FOLDER_RESOURCE_TYPE)}
          onClose={() => {
            setShareFolderId(null);
            setShareFolderName(null);
          }}
          onSave={() => {
            notifications.toasts.addSuccess(`Updated sharing for folder "${shareFolderName}".`);
          }}
        />
      ) : null}

      {contextMenu ? (
        <>
          <div className="docsContextMenuBackdrop" onClick={() => setContextMenu(null)} />
          <div
            className="docsContextMenu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              type="button"
              className="docsContextMenuItem"
              onClick={() => {
                setIsCreatingDocInline(true);
                setInlineDocFolderId(contextMenu.parentId);
                setInlineDocName('');
                // Expand the folder so the input is visible, but don't navigate into it
                if (contextMenu.parentId) {
                  const folder = folders.find((f) => f.id === contextMenu.parentId);
                  if (folder) {
                    setExpandedFolders((current) => ({ ...current, [folder.path]: true }));
                  }
                }
                setContextMenu(null);
              }}
            >
              <EuiIcon type="document" size="s" />
              <span>New Document{contextMenu.parentId ? ' ' : ''}</span>
            </button>
            <button
              type="button"
              className="docsContextMenuItem"
              onClick={() => {
                setIsCreatingFolder(true);
                setNewFolderParentId(contextMenu.parentId);
                setNewFolderName('');
                // Expand the folder so the input is visible
                if (contextMenu.parentId) {
                  const folder = folders.find((f) => f.id === contextMenu.parentId);
                  if (folder) {
                    setExpandedFolders((current) => ({ ...current, [folder.path]: true }));
                  }
                }
                setContextMenu(null);
              }}
            >
              <EuiIcon type="folderClosed" size="s" />
              <span>New Folder{contextMenu.parentId ? ' ' : ''}</span>
            </button>
            {contextMenu.parentId ? (
              <>
                <div className="docsContextMenuDivider" />
                <button
                  type="button"
                  className="docsContextMenuItem"
                  onClick={() => {
                    const folder = folders.find((f) => f.id === contextMenu.parentId);
                    if (folder) {
                      setShareFolderId(folder.id);
                      setShareFolderName(folder.name);
                    }
                    setContextMenu(null);
                  }}
                >
                  <EuiIcon type="share" size="s" />
                  <span>Share</span>
                </button>
                <button
                  type="button"
                  className="docsContextMenuItem docsContextMenuItem--danger"
                  onClick={() => {
                    const folder = folders.find((f) => f.id === contextMenu.parentId);
                    if (folder) {
                      deleteFolder(http, folder.id, folder.seqNo, folder.primaryTerm)
                        .then(() => {
                          setFolders((current) => current.filter((f) => f.id !== folder.id && f.parentId !== folder.id && !f.path.startsWith(folder.path + '/')));
                          setDocuments((current) => current.filter((d) => d.folderId !== folder.id && !d.folderPath.startsWith(folder.path + '/')));
                          notifications.toasts.addSuccess(`Deleted folder "${folder.name}".`);
                        })
                        .catch((error: any) => {
                          const message = error?.body?.message || error?.message || String(error);
                          notifications.toasts.addDanger(`Failed to delete folder: ${message}`);
                        });
                    }
                    setContextMenu(null);
                  }}
                >
                  <EuiIcon type="trash" size="s" />
                  <span>Delete</span>
                </button>
              </>
            ) : null}
            {contextMenu.documentId ? (
              <>
                <div className="docsContextMenuDivider" />
                <button
                  type="button"
                  className="docsContextMenuItem"
                  onClick={() => {
                    selectDocument(contextMenu.documentId!);
                    setIsShareModalVisible(true);
                    setContextMenu(null);
                  }}
                >
                  <EuiIcon type="share" size="s" />
                  <span>Share</span>
                </button>
                <button
                  type="button"
                  className="docsContextMenuItem docsContextMenuItem--danger"
                  onClick={() => {
                    const doc = documents.find((d) => d.id === contextMenu.documentId);
                    if (doc) {
                      deleteDocument(http, doc.id, doc.seqNo, doc.primaryTerm)
                        .then(() => {
                          setDocuments((current) => current.filter((d) => d.id !== doc.id));
                          if (selectedId === doc.id) {
                            setSelectedId(null);
                            setSelectedDocument(null);
                          }
                          notifications.toasts.addSuccess(`Deleted "${doc.title}".`);
                        })
                        .catch((error: any) => {
                          const message = error?.body?.message || error?.message || String(error);
                          notifications.toasts.addDanger(`Failed to delete document: ${message}`);
                        });
                    }
                    setContextMenu(null);
                  }}
                >
                  <EuiIcon type="trash" size="s" />
                  <span>Delete</span>
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
