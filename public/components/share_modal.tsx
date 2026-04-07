/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFormRow,
  EuiLoadingSpinner,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { HttpStart } from '../../../../src/core/public';
import {
  formatAccessLevelLabel,
  isShareCapableAccessLevel,
  ShareWith,
} from '../../common';
import { createSharingInfo, getSharingInfo, updateSharingInfo } from '../services/sharing';

interface ShareModalProps {
  http: HttpStart;
  isOpen: boolean;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  accessLevels: string[];
  onClose: () => void;
  onSave: (generalAccess: string | null) => void;
}

function getErrorMessage(error: any): string {
  return (
    error?.body?.message ??
    error?.message ??
    'Unable to update document sharing right now.'
  );
}

function hasNamedSharingEntries(shareWith?: ShareWith): boolean {
  return Object.keys(shareWith ?? {}).some((key) => key !== 'general_access');
}

function hasAnySharingEntries(shareWith?: ShareWith): boolean {
  return Object.keys(shareWith ?? {}).length > 0;
}

export function ShareModal({
  http,
  isOpen,
  resourceId,
  resourceName,
  resourceType,
  accessLevels,
  onClose,
  onSave,
}: ShareModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [generalAccess, setGeneralAccess] = useState<string | null>(null);
  const [initialGeneralAccess, setInitialGeneralAccess] = useState<string | null>(null);
  const [hasExistingSharing, setHasExistingSharing] = useState(false);
  const [hasNamedSharing, setHasNamedSharing] = useState(false);
  const [canShare, setCanShare] = useState(true);

  const generalAccessOptions = useMemo(
    () =>
      accessLevels
        .filter((accessLevel) => !isShareCapableAccessLevel(accessLevel))
        .map((accessLevel) => ({
          value: accessLevel,
          text: formatAccessLevelLabel(accessLevel),
        })),
    [accessLevels]
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;

    async function loadSharingInfo() {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await getSharingInfo(http, resourceId, resourceType);
        if (cancelled) {
          return;
        }

        const shareWith = response.sharing_info?.share_with;
        const nextGeneralAccess =
          typeof shareWith?.general_access === 'string' ? shareWith.general_access : null;

        setGeneralAccess(nextGeneralAccess);
        setInitialGeneralAccess(nextGeneralAccess);
        setHasExistingSharing(hasAnySharingEntries(shareWith));
        setHasNamedSharing(hasNamedSharingEntries(shareWith));
        setCanShare(response.sharing_info?.can_share !== false);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(getErrorMessage(error));
          setGeneralAccess(null);
          setInitialGeneralAccess(null);
          setHasExistingSharing(false);
          setHasNamedSharing(false);
          setCanShare(true);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadSharingInfo();

    return () => {
      cancelled = true;
    };
  }, [http, isOpen, resourceId, resourceType]);

  async function handleSave() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      if (!hasExistingSharing) {
        if (generalAccess) {
          await createSharingInfo(http, resourceId, resourceType, {
            general_access: generalAccess,
          });
        }
      } else {
        await updateSharingInfo(http, resourceId, resourceType, generalAccess);
      }

      onSave(generalAccess);
      onClose();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  if (!isOpen) {
    return null;
  }

  const hasChanges = generalAccess !== initialGeneralAccess;

  return (
    <EuiModal onClose={onClose}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>{`Share "${resourceName}"`}</EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        {errorMessage ? (
          <>
            <EuiCallOut color="danger" iconType="alert" title={errorMessage} />
            <EuiSpacer size="m" />
          </>
        ) : null}

        {isLoading ? (
          <div className="docsShareModalLoading">
            <EuiLoadingSpinner size="xl" />
          </div>
        ) : (
          <>
            <EuiText size="s" color="subdued">
              Choose the baseline access level for this document. Named user and role sharing can
              layer on later without changing this first pass.
            </EuiText>
            <EuiSpacer size="m" />

            {hasNamedSharing ? (
              <>
                <EuiCallOut
                  color="primary"
                  iconType="iInCircle"
                  title="This view only edits general access."
                >
                  Named recipients already on the document will stay untouched.
                </EuiCallOut>
                <EuiSpacer size="m" />
              </>
            ) : null}

            {canShare === false ? (
              <EuiCallOut
                color="warning"
                iconType="lock"
                title="You do not have permission to change sharing for this document."
              />
            ) : (
              <EuiFormRow label="General access">
                <EuiSelect
                  value={generalAccess ?? ''}
                  options={[
                    { value: '', text: 'Private' },
                    ...generalAccessOptions,
                  ]}
                  onChange={(event) => {
                    setGeneralAccess(event.target.value || null);
                  }}
                />
              </EuiFormRow>
            )}
          </>
        )}
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButtonEmpty onClick={onClose} isDisabled={isSaving}>
          Cancel
        </EuiButtonEmpty>
        <EuiButton
          fill
          isLoading={isSaving}
          isDisabled={isLoading || isSaving || canShare === false || hasChanges === false}
          onClick={() => {
            void handleSave();
          }}
        >
          Save sharing
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
