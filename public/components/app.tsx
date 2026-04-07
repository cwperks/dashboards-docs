/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
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
import { DocumentRecord, DocumentSummary, PLUGIN_NAME } from '../../common';
import {
  createDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../services/documents';

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
  const [draftTitle, setDraftTitle] = useState('Untitled document');
  const [draftContent, setDraftContent] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Ready to write');
  const [conflictDocument, setConflictDocument] = useState<DocumentRecord | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    chrome.docTitle.change([PLUGIN_NAME]);
    chrome.setBreadcrumbs([{ text: PLUGIN_NAME }]);

    return () => {
      chrome.docTitle.reset();
    };
  }, [chrome]);

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

      try {
        const response = await getDocument(http, documentId);
        if (cancelled) {
          return;
        }

        setSelectedDocument(response.document);
        setDraftTitle(response.document.title);
        setDraftContent(response.document.content);
        setIsCreatingNew(false);
        setIsDirty(false);
        setConflictDocument(null);
        setStatusMessage('All changes saved');
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
  }, [http, selectedId]);

  async function saveDocument(silent?: boolean) {
    if (isSaving) {
      return;
    }

    if (!draftTitle.trim()) {
      if (!silent) {
        notifications.toasts.addDanger('A document title is required.');
      }
      return;
    }

    setIsSaving(true);
    setInlineError(null);
    setStatusMessage(selectedId ? 'Saving changes...' : 'Creating document...');

    try {
      const payload = {
        title: draftTitle.trim(),
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
    if (!selectedId || isDirty === false) {
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
  }, [http, isDirty, selectedDocument, selectedId]);

  useEffect(() => {
    if (isDirty === false || isSaving || !draftTitle.trim()) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void saveDocument(true);
    }, 1500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [draftContent, draftTitle, isDirty, isSaving, selectedDocument, selectedId]);

  function startNewDocument() {
    setIsCreatingNew(true);
    setSelectedId(null);
    setSelectedDocument(null);
    setDraftTitle('Untitled document');
    setDraftContent('');
    setConflictDocument(null);
    setInlineError(null);
    setStatusMessage('New draft ready');
    setIsDirty(false);
  }

  function selectDocument(documentId: string) {
    setIsCreatingNew(false);
    setSelectedId(documentId);
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
            <EuiButton fill onClick={startNewDocument}>
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
                    {isDirty ? 'Unsaved changes' : 'Saved'}
                  </EuiBadge>
                  <span className="docsStatusText">
                    {statusMessage}
                    {selectedDocument ? ` · ${formatTimestamp(selectedDocument.updatedAt)}` : ''}
                  </span>
                </div>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButton
                  fill
                  size="s"
                  isLoading={isSaving}
                  onClick={() => {
                    void saveDocument(false);
                  }}
                >
                  {selectedId ? 'Save now' : 'Create document'}
                </EuiButton>
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

            <EuiSpacer size="m" />

            {isLoadingDocument ? (
              <div className="docsLoadingState">
                <EuiLoadingSpinner size="xl" />
              </div>
            ) : (
              <div className={`docsEditorShell docsEditorShell--${viewMode}`}>
                {viewMode !== 'preview' ? (
                  <section className="docsComposerPane">
                    <EuiTextArea
                      fullWidth
                      className="docsComposer"
                      value={draftContent}
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
              </div>
            )}
          </EuiPanel>
        </main>
      </div>
    </div>
  );
}
