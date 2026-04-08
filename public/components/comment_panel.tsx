/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiSpacer,
  EuiText,
  EuiTextArea,
} from '@elastic/eui';
import { Comment } from '../../common';

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface CommentThreadProps {
  comments: Comment[];
  currentUser: string;
  canComment: boolean;
  onReply: (threadId: string, text: string) => void;
  onDelete: (comment: Comment) => void;
  onScrollTo: (comment: Comment) => void;
}

function CommentThread({ comments, currentUser, canComment, onReply, onDelete, onScrollTo }: CommentThreadProps) {
  const [replyText, setReplyText] = useState('');
  const [showReply, setShowReply] = useState(false);
  const root = comments[0];
  const replies = comments.slice(1);
  const isUnread = !root.readBy.includes(currentUser);

  return (
    <div className={`docsCommentThread ${isUnread ? 'docsCommentThread--unread' : ''}`}>
      {comments.map((comment) => (
        <div key={comment.id} className="docsCommentItem">
          <div className="docsCommentHeader">
            <span className="docsCommentAuthor">{comment.owner}</span>
            {comment.startOffset === 0 && comment.endOffset === 0 ? (
              <span className="docsCommentAnchorBadge docsCommentAnchorBadge--general">Doc</span>
            ) : (
              <span className="docsCommentAnchorBadge" onClick={() => onScrollTo(comment)}>
                📍 {comment.startOffset !== comment.endOffset ? 'Inline' : 'Line'}
              </span>
            )}
            <span className="docsCommentTime">{formatTime(comment.createdAt)}</span>
            {comment.owner === currentUser ? (
              <button className="docsCommentDelete" onClick={() => onDelete(comment)}>
                <EuiIcon type="trash" size="s" />
              </button>
            ) : null}
          </div>
          <div
            className={`docsCommentBody ${comment.startOffset !== comment.endOffset ? 'docsCommentBody--linked' : ''}`}
            onClick={() => { if (comment.startOffset !== comment.endOffset) onScrollTo(comment); }}
          >
            {comment.commentText}
          </div>
        </div>
      ))}
      {canComment ? (
        showReply ? (
          <div className="docsCommentReply">
            <EuiTextArea
              compressed
              rows={2}
              placeholder="Reply..."
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
            />
            <EuiSpacer size="xs" />
            <EuiFlexGroup gutterSize="xs">
              <EuiFlexItem grow={false}>
                <EuiButton
                  size="s"
                  fill
                  disabled={!replyText.trim()}
                  onClick={() => {
                    onReply(root.threadId, replyText.trim());
                    setReplyText('');
                    setShowReply(false);
                  }}
                >
                  Reply
                </EuiButton>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty size="s" onClick={() => { setShowReply(false); setReplyText(''); }}>
                  Cancel
                </EuiButtonEmpty>
              </EuiFlexItem>
            </EuiFlexGroup>
          </div>
        ) : (
          <button className="docsCommentReplyButton" onClick={() => setShowReply(true)}>
            Reply
          </button>
        )
      ) : null}
    </div>
  );
}

interface CommentPanelProps {
  comments: Comment[];
  currentUser: string;
  canComment: boolean;
  onAddComment: (text: string, startOffset: number, endOffset: number) => void;
  onReply: (threadId: string, text: string) => void;
  onDelete: (comment: Comment) => void;
  onScrollTo: (comment: Comment) => void;
  onClearSelection?: () => void;
  selectionRange: { start: number; end: number; lineLabel?: string; anchorType: 'doc' | 'line' | 'range' } | null;
}

export function CommentPanel({
  comments,
  currentUser,
  canComment,
  onAddComment,
  onReply,
  onDelete,
  onScrollTo,
  onClearSelection,
  selectionRange,
}: CommentPanelProps) {
  const [newCommentText, setNewCommentText] = useState('');
  const [showAll, setShowAll] = useState(false);

  // Reset filter when selection changes
  React.useEffect(() => {
    setShowAll(false);
  }, [selectionRange?.start, selectionRange?.end]);

  // Group comments by threadId
  const threads = new Map<string, Comment[]>();
  comments.forEach((comment) => {
    const existing = threads.get(comment.threadId) || [];
    existing.push(comment);
    threads.set(comment.threadId, existing);
  });

  // Filter to relevant threads if a line/selection is active
  const hasSelection = selectionRange && selectionRange.anchorType !== 'doc' && selectionRange.start !== selectionRange.end;
  const allThreads = Array.from(threads.values()).sort(
    (a, b) => a[0].createdAt - b[0].createdAt
  );
  const filteredThreads = hasSelection
    ? allThreads.filter((thread) => {
        const root = thread[0];
        if (root.startOffset === 0 && root.endOffset === 0) return false;
        // Show threads that overlap with the current selection
        return root.startOffset < selectionRange!.end && root.endOffset > selectionRange!.start;
      })
    : allThreads;

  const sortedThreads = showAll ? allThreads : filteredThreads;

  return (
    <div className="docsCommentPanel">
      <div className="docsCommentPanelHeader">
        <EuiText size="xs"><strong>Comments</strong></EuiText>
        {hasSelection && !showAll ? (
          <button className="docsCommentShowAll" onClick={() => setShowAll(true)}>
            Show all ({allThreads.length})
          </button>
        ) : hasSelection && showAll ? (
          <button className="docsCommentShowAll" onClick={() => setShowAll(false)}>
            Show relevant ({filteredThreads.length})
          </button>
        ) : (
          <EuiText size="xs" color="subdued">{allThreads.length} thread{allThreads.length !== 1 ? 's' : ''}</EuiText>
        )}
      </div>

      {canComment ? (
        <div className="docsCommentNew">
          {selectionRange && selectionRange.anchorType !== 'doc' ? (
            <div className="docsCommentAnchorPreview">
              <EuiIcon type="editorComment" size="s" />
              <EuiText size="xs" color="subdued">
                {selectionRange.anchorType === 'line'
                  ? `Commenting on ${selectionRange.lineLabel}`
                  : 'Commenting on selection'}
              </EuiText>
              <button
                className="docsCommentAnchorClear"
                onClick={() => onClearSelection?.()}
              >
                <EuiIcon type="cross" size="s" />
              </button>
            </div>
          ) : null}
          <EuiTextArea
            compressed
            rows={2}
            placeholder={selectionRange?.anchorType === 'line' ? 'Comment on this line...' : selectionRange?.anchorType === 'range' ? 'Comment on selection...' : 'Add a general comment...'}
            value={newCommentText}
            onChange={(e) => setNewCommentText(e.target.value)}
          />
          <EuiSpacer size="xs" />
          <EuiButton
            size="s"
            fill
            disabled={!newCommentText.trim()}
            onClick={() => {
              onAddComment(
                newCommentText.trim(),
                selectionRange?.start ?? 0,
                selectionRange?.end ?? 0
              );
              setNewCommentText('');
            }}
          >
            Comment
          </EuiButton>
        </div>
      ) : null}

      <div className="docsCommentThreads">
        {sortedThreads.length === 0 ? (
          <div className="docsCommentEmpty">
            <EuiText size="s" color="subdued">No comments yet.</EuiText>
          </div>
        ) : (
          sortedThreads.map((threadComments) => (
            <CommentThread
              key={threadComments[0].threadId}
              comments={threadComments}
              currentUser={currentUser}
              canComment={canComment}
              onReply={onReply}
              onDelete={onDelete}
              onScrollTo={onScrollTo}
            />
          ))
        )}
      </div>
    </div>
  );
}
