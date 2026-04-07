/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
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
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import { CoreStart } from '../../../../src/core/public';
import {
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
import { ShareModal } from './share_modal';
import { getResourceAccess, getSharingConfig } from '../services/sharing';

type ViewMode = 'write' | 'split' | 'preview';

interface DocsAppProps {
  coreStart: CoreStart;
}

function upsertSummary(documents: DocumentSummary[], document: DocumentRecord): DocumentSummary[] {
  const nextSummary: DocumentSummary = {
    id: document.id,
    title: document.title,
    excerpt:
      document.content.trim().replace(/\s+/g, ' ').slice(0, 180) +
      (document.content.trim().replace(/\s+/g, ' ').length > 180 ? '...' : ''),
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const isSwitchingDocuments =
    isLoadingDocument && selectedDocument !== null && selectedDocument.id !== selectedId;
  const supportsSharing = supportsResourceSharingForType(sharingConfig, DOC_RESOURCE_TYPE);
  const shareAccessLevels = getAccessLevelsForType(sharingConfig, DOC_RESOURCE_TYPE);
  const isReadOnly = readOnlyReason !== null;

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
  }, [http, isCreatingNew, search]);

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
        setIsCreatingNew(false);
        setIsDirty(false);
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
  }, [http, selectedId, supportsSharing]);

  async function enterReadOnlyMode() {
    if (!selectedId) {
      return;
    }

    try {
      const response = await getDocument(http, selectedId);
      setSelectedDocument(response.document);
      setDraftTitle(response.document.title);
      setDraftContent(response.document.content);
      setDocuments((current) => upsertSummary(current, response.document));
    } catch (error) {
      // If reload fails, keep the current document visible and still lock editing.
    }

    setConflictDocument(null);
    setInlineError(null);
    setIsDirty(false);
    setReadOnlyReason('You have view access to this document, but not edit access.');
    setCanDeleteDocument(false);
    setCanShareDocument(false);
    setStatusMessage('Read-only access');
  }

  async function saveDocument(silent?: boolean) {
    if (isSaving || isReadOnly) {
      return;
    }

    setIsSaving(true);
    setInlineError(null);
    setStatusMessage(selectedId ? 'Saving changes...' : 'Creating document...');

    try {
      const resolvedTitle = draftTitle.trim() || 'Untitled document';
      const payload = {
        title: resolvedTitle,
        content: draftContent,
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
      setDraftContent(response.document.content);
      setIsCreatingNew(false);
      setDocuments((current) => upsertSummary(current, response.document));
      setConflictDocument(null);
      setIsDirty(false);
      setStatusMessage('All changes saved');
    } catch (error) {
      const statusCode = getStatusCode(error);
      if (statusCode === 409 && selectedId) {
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

  useEffect(() => {
    if (!selectedId || isDirty === false || isReadOnly) {
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
        setDraftContent(response.document.content);
        setStatusMessage('Document refreshed');
      } catch (error) {
        // Keep polling quiet in the background until the user acts.
      }
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [http, isDirty, isReadOnly, selectedDocument, selectedId]);

  useEffect(() => {
    if (isDirty === false || isSaving || isReadOnly) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void saveDocument(true);
    }, 1500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [draftContent, draftTitle, isDirty, isReadOnly, isSaving, selectedDocument, selectedId]);

  function startNewDocument() {
    setIsCreatingNew(true);
    setSelectedId(null);
    setSelectedDocument(null);
    setDraftTitle('');
    setDraftContent('');
    setConflictDocument(null);
    setInlineError(null);
    setReadOnlyReason(null);
    setCanDeleteDocument(true);
    setCanShareDocument(true);
    setStatusMessage('New draft ready');
    setIsDirty(false);
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
      composerRef.current?.focus();
    }
  }

  function loadRemoteVersion() {
    if (!conflictDocument) {
      return;
    }

    setSelectedDocument(conflictDocument);
    setDraftTitle(conflictDocument.title);
    setDraftContent(conflictDocument.content);
    setDocuments((current) => upsertSummary(current, conflictDocument));
    setConflictDocument(null);
    setIsDirty(false);
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
          documentToDelete.primaryTerm);

      setDocuments(remainingDocuments);
      setConflictDocument(null);
      setIsDirty(false);
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
      setStatusMessage('Document deleted');
    } catch (error) {
      const message = getErrorMessage(error);
      setInlineError(message);
      notifications.toasts.addDanger(message);
    } finally {
      setIsDeleting(false);
    }
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
              Quip-style notes, markdown-ish writing, autosave, and conflict-aware editing on a
              dedicated system index.
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
                  <span className="docsSidebarItemExcerpt">{document.excerpt || 'No preview yet'}</span>
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
                  readOnly={isSwitchingDocuments || isReadOnly}
                  onKeyDown={handleTitleKeyDown}
                  onChange={(event) => {
                    setDraftTitle(event.target.value);
                    setIsDirty(true);
                    setStatusMessage('Draft updated');
                  }}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <div className="docsModeSwitch">
                  <button
                    className={viewMode === 'write' ? 'docsModeSwitchButton isActive' : 'docsModeSwitchButton'}
                    onClick={() => setViewMode('write')}
                  >
                    Write
                  </button>
                  <button
                    className={viewMode === 'split' ? 'docsModeSwitchButton isActive' : 'docsModeSwitchButton'}
                    onClick={() => setViewMode('split')}
                  >
                    Split
                  </button>
                  <button
                    className={viewMode === 'preview' ? 'docsModeSwitchButton isActive' : 'docsModeSwitchButton'}
                    onClick={() => setViewMode('preview')}
                  >
                    Preview
                  </button>
                </div>
              </EuiFlexItem>
            </EuiFlexGroup>

            <EuiSpacer size="m" />

            <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
              <EuiFlexItem grow={false}>
                <div className="docsStatusRow">
                  <EuiBadge color={isDirty ? 'warning' : 'secondary'}>
                    {isReadOnly ? 'Read only' : isDirty ? 'Unsaved changes' : 'Saved'}
                  </EuiBadge>
                  <span className="docsStatusText">
                    {statusMessage}
                    {selectedDocument ? ` · ${formatTimestamp(selectedDocument.updatedAt)}` : ''}
                  </span>
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
                      isDisabled={isReadOnly}
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
                  <EuiTextArea
                    fullWidth
                    className="docsComposer"
                    inputRef={composerRef}
                    value={draftContent}
                    readOnly={isSwitchingDocuments || isReadOnly}
                    placeholder="Start writing..."
                    onChange={(event) => {
                      setDraftContent(event.target.value);
                      setIsDirty(true);
                      setStatusMessage('Draft updated');
                    }}
                    aria-label="Document content"
                  />
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
          onSave={(generalAccess) => {
            const label = generalAccess ? generalAccess.replace(/^docs_/, '').replace(/_/g, ' ') : 'private';
            notifications.toasts.addSuccess(
              `Updated sharing for "${selectedDocument.title}" to ${label}.`
            );
          }}
        />
      ) : null}
    </div>
  );
}
