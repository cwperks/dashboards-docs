/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiFieldText,
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
}

function CommentThread({ comments, currentUser, canComment, onReply, onDelete }: CommentThreadProps) {
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
            <span className="docsCommentTime">{formatTime(comment.createdAt)}</span>
            {comment.owner === currentUser ? (
              <button className="docsCommentDelete" onClick={() => onDelete(comment)}>
                <EuiIcon type="trash" size="s" />
              </button>
            ) : null}
          </div>
          <div className="docsCommentBody">{comment.commentText}</div>
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
  selectionRange: { start: number; end: number } | null;
}

export function CommentPanel({
  comments,
  currentUser,
  canComment,
  onAddComment,
  onReply,
  onDelete,
  selectionRange,
}: CommentPanelProps) {
  const [newCommentText, setNewCommentText] = useState('');

  // Group comments by threadId
  const threads = new Map<string, Comment[]>();
  comments.forEach((comment) => {
    const existing = threads.get(comment.threadId) || [];
    existing.push(comment);
    threads.set(comment.threadId, existing);
  });

  // Sort threads by first comment's creation time
  const sortedThreads = Array.from(threads.values()).sort(
    (a, b) => a[0].createdAt - b[0].createdAt
  );

  return (
    <div className="docsCommentPanel">
      <div className="docsCommentPanelHeader">
        <EuiText size="xs"><strong>Comments</strong></EuiText>
        <EuiText size="xs" color="subdued">{sortedThreads.length} thread{sortedThreads.length !== 1 ? 's' : ''}</EuiText>
      </div>

      {canComment ? (
        <div className="docsCommentNew">
          <EuiTextArea
            compressed
            rows={2}
            placeholder="Add a comment..."
            value={newCommentText}
            onChange={(e) => setNewCommentText(e.target.value)}
          />
          <EuiSpacer size="xs" />
          <EuiFlexGroup gutterSize="s" alignItems="center">
            <EuiFlexItem grow={false}>
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
            </EuiFlexItem>
            {selectionRange && selectionRange.start !== selectionRange.end ? (
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">on selection</EuiText>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
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
            />
          ))
        )}
      </div>
    </div>
  );
}
