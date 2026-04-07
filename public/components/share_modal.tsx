/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiComboBox,
  EuiComboBoxOptionOption,
  EuiFormRow,
  EuiHorizontalRule,
  EuiLoadingSpinner,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { HttpStart } from '../../../../src/core/public';
import {
  formatAccessLevelLabel,
  isShareCapableAccessLevel,
  ShareRecipients,
  ShareUpdatePayload,
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
  onSave: () => void;
}

interface AccessLevelEntry {
  accessLevel: string;
  users: string[];
  roles: string[];
}

interface NormalizedSharingState {
  generalAccess: string | null;
  entries: AccessLevelEntry[];
}

const EMPTY_SHARING_STATE: NormalizedSharingState = {
  generalAccess: null,
  entries: [],
};

function getErrorMessage(error: any): string {
  return (
    error?.body?.message ??
    error?.message ??
    'Unable to update document sharing right now.'
  );
}

function createEmptyEntry(accessLevel: string): AccessLevelEntry {
  return {
    accessLevel,
    users: [],
    roles: [],
  };
}

function normalizeList(values?: string[]): string[] {
  return [...new Set(values ?? [])].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

function normalizeShareWith(shareWith?: ShareWith): NormalizedSharingState {
  if (!shareWith) {
    return EMPTY_SHARING_STATE;
  }

  const entries = Object.entries(shareWith)
    .filter(([accessLevel]) => accessLevel !== 'general_access')
    .map(([accessLevel, recipients]) => {
      const shareRecipients = typeof recipients === 'object' && recipients !== null
        ? (recipients as ShareRecipients)
        : {};

      return {
        accessLevel,
        users: normalizeList(shareRecipients.users),
        roles: normalizeList(shareRecipients.roles),
      };
    })
    .filter((entry) => entry.users.length > 0 || entry.roles.length > 0)
    .sort((left, right) => left.accessLevel.localeCompare(right.accessLevel));

  return {
    generalAccess:
      typeof shareWith.general_access === 'string' ? shareWith.general_access : null,
    entries,
  };
}

function toShareWith(generalAccess: string | null, entries: AccessLevelEntry[]): ShareWith {
  const shareWith: ShareWith = {};

  if (generalAccess) {
    shareWith.general_access = generalAccess;
  }

  entries.forEach((entry) => {
    const users = normalizeList(entry.users);
    const roles = normalizeList(entry.roles);

    if (users.length === 0 && roles.length === 0) {
      return;
    }

    shareWith[entry.accessLevel] = {
      ...(users.length > 0 ? { users } : {}),
      ...(roles.length > 0 ? { roles } : {}),
    };
  });

  return shareWith;
}

function getSignature(generalAccess: string | null, entries: AccessLevelEntry[]): string {
  return JSON.stringify(toShareWith(generalAccess, entries));
}

function toOptions(values: string[]): Array<EuiComboBoxOptionOption<string>> {
  return values.map((value) => ({ label: value }));
}

function fromOptions(options: Array<EuiComboBoxOptionOption<string>>): string[] {
  return normalizeList(options.map((option) => option.label));
}

function getRecipientsByAccessLevel(entries: AccessLevelEntry[]): Record<string, ShareRecipients> {
  return entries.reduce<Record<string, ShareRecipients>>((accumulator, entry) => {
    const users = normalizeList(entry.users);
    const roles = normalizeList(entry.roles);

    if (users.length === 0 && roles.length === 0) {
      return accumulator;
    }

    accumulator[entry.accessLevel] = {
      ...(users.length > 0 ? { users } : {}),
      ...(roles.length > 0 ? { roles } : {}),
    };

    return accumulator;
  }, {});
}

function createSharePatch(
  before: NormalizedSharingState,
  after: NormalizedSharingState
): ShareUpdatePayload {
  const beforeRecipients = getRecipientsByAccessLevel(before.entries);
  const afterRecipients = getRecipientsByAccessLevel(after.entries);
  const accessLevels = new Set([
    ...Object.keys(beforeRecipients),
    ...Object.keys(afterRecipients),
  ]);
  const add: ShareWith = {};
  const revoke: ShareWith = {};

  accessLevels.forEach((accessLevel) => {
    const previous = beforeRecipients[accessLevel] ?? {};
    const current = afterRecipients[accessLevel] ?? {};
    const previousUsers = normalizeList(previous.users);
    const currentUsers = normalizeList(current.users);
    const previousRoles = normalizeList(previous.roles);
    const currentRoles = normalizeList(current.roles);

    const addedUsers = currentUsers.filter((value) => previousUsers.includes(value) === false);
    const revokedUsers = previousUsers.filter((value) => currentUsers.includes(value) === false);
    const addedRoles = currentRoles.filter((value) => previousRoles.includes(value) === false);
    const revokedRoles = previousRoles.filter((value) => currentRoles.includes(value) === false);

    if (addedUsers.length > 0 || addedRoles.length > 0) {
      add[accessLevel] = {
        ...(addedUsers.length > 0 ? { users: addedUsers } : {}),
        ...(addedRoles.length > 0 ? { roles: addedRoles } : {}),
      };
    }

    if (revokedUsers.length > 0 || revokedRoles.length > 0) {
      revoke[accessLevel] = {
        ...(revokedUsers.length > 0 ? { users: revokedUsers } : {}),
        ...(revokedRoles.length > 0 ? { roles: revokedRoles } : {}),
      };
    }
  });

  const patch: ShareUpdatePayload = {};

  if (Object.keys(add).length > 0) {
    patch.add = add;
  }

  if (Object.keys(revoke).length > 0) {
    patch.revoke = revoke;
  }

  if (before.generalAccess !== after.generalAccess) {
    patch.general_access = after.generalAccess;
  }

  return patch;
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
  const [canShare, setCanShare] = useState(true);
  const [generalAccess, setGeneralAccess] = useState<string | null>(null);
  const [entries, setEntries] = useState<AccessLevelEntry[]>([]);
  const [sharingExists, setSharingExists] = useState(false);
  const [initialState, setInitialState] = useState<NormalizedSharingState>(EMPTY_SHARING_STATE);
  const [initialSignature, setInitialSignature] = useState(getSignature(null, []));

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

        const normalized = normalizeShareWith(response.sharing_info?.share_with);
        setGeneralAccess(normalized.generalAccess);
        setEntries(normalized.entries);
        setSharingExists(response.exists === true);
        setInitialState(normalized);
        setInitialSignature(getSignature(normalized.generalAccess, normalized.entries));
        setCanShare(response.sharing_info?.can_share !== false);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(getErrorMessage(error));
          setGeneralAccess(null);
          setEntries([]);
          setSharingExists(false);
          setInitialState(EMPTY_SHARING_STATE);
          setInitialSignature(getSignature(null, []));
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

  function addAccessLevelEntry() {
    const nextAccessLevel = accessLevels.find(
      (accessLevel) => entries.some((entry) => entry.accessLevel === accessLevel) === false
    );

    if (!nextAccessLevel) {
      return;
    }

    setEntries((current) => [...current, createEmptyEntry(nextAccessLevel)]);
  }

  function updateEntry(index: number, nextEntry: AccessLevelEntry) {
    setEntries((current) =>
      current.map((entry, entryIndex) => (entryIndex === index ? nextEntry : entry))
    );
  }

  function removeEntry(index: number) {
    setEntries((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  async function handleSave() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const nextState = {
        generalAccess,
        entries,
      };

      if (sharingExists) {
        await updateSharingInfo(http, resourceId, resourceType, createSharePatch(initialState, nextState));
      } else {
        await createSharingInfo(http, resourceId, resourceType, toShareWith(generalAccess, entries));
      }

      onSave();
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

  const currentSignature = getSignature(generalAccess, entries);
  const hasChanges = currentSignature !== initialSignature;
  const hasUnusedAccessLevels =
    accessLevels.some((accessLevel) => entries.some((entry) => entry.accessLevel === accessLevel) === false);

  return (
    <EuiModal onClose={onClose} style={{ width: 760 }}>
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
              Set baseline access for everyone, then optionally add named users or roles at
              specific access levels.
            </EuiText>
            <EuiSpacer size="m" />

            {canShare === false ? (
              <EuiCallOut
                color="warning"
                iconType="lock"
                title="You do not have permission to change sharing for this document."
              />
            ) : (
              <>
                <EuiFormRow label="General access">
                  <EuiSelect
                    value={generalAccess ?? ''}
                    options={[{ value: '', text: 'Private' }, ...generalAccessOptions]}
                    onChange={(event) => {
                      setGeneralAccess(event.target.value || null);
                    }}
                  />
                </EuiFormRow>

                <EuiSpacer size="m" />
                <EuiHorizontalRule margin="m" />

                <EuiTitle size="xs">
                  <h3>Named sharing</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                <EuiText size="s" color="subdued">
                  Add usernames or roles to a specific access level, similar to the reporting
                  sharing flow.
                </EuiText>
                <EuiSpacer size="m" />

                {entries.map((entry, index) => {
                  const accessLevelOptions = accessLevels
                    .filter(
                      (accessLevel) =>
                        accessLevel === entry.accessLevel ||
                        entries.some((candidate) => candidate.accessLevel === accessLevel) === false
                    )
                    .map((accessLevel) => ({
                      value: accessLevel,
                      text: formatAccessLevelLabel(accessLevel),
                    }));

                  return (
                    <React.Fragment key={`${entry.accessLevel}-${index}`}>
                      <EuiPanel hasBorder hasShadow={false} paddingSize="m">
                        <EuiFormRow label="Access level">
                          <EuiSelect
                            value={entry.accessLevel}
                            options={accessLevelOptions}
                            onChange={(event) => {
                              updateEntry(index, {
                                ...entry,
                                accessLevel: event.target.value,
                              });
                            }}
                          />
                        </EuiFormRow>

                        <EuiFormRow label="Usernames">
                          <EuiComboBox
                            noSuggestions
                            selectedOptions={toOptions(entry.users)}
                            onCreateOption={(value) => {
                              updateEntry(index, {
                                ...entry,
                                users: normalizeList([...entry.users, value]),
                              });
                            }}
                            onChange={(options) => {
                              updateEntry(index, {
                                ...entry,
                                users: fromOptions(options),
                              });
                            }}
                          />
                        </EuiFormRow>

                        <EuiFormRow label="Roles">
                          <EuiComboBox
                            noSuggestions
                            selectedOptions={toOptions(entry.roles)}
                            onCreateOption={(value) => {
                              updateEntry(index, {
                                ...entry,
                                roles: normalizeList([...entry.roles, value]),
                              });
                            }}
                            onChange={(options) => {
                              updateEntry(index, {
                                ...entry,
                                roles: fromOptions(options),
                              });
                            }}
                          />
                        </EuiFormRow>

                        <EuiButtonEmpty
                          color="danger"
                          size="s"
                          iconType="trash"
                          onClick={() => removeEntry(index)}
                        >
                          Remove access level
                        </EuiButtonEmpty>
                      </EuiPanel>
                      <EuiSpacer size="m" />
                    </React.Fragment>
                  );
                })}

                <EuiButtonEmpty
                  size="s"
                  iconType="plusInCircle"
                  onClick={addAccessLevelEntry}
                  isDisabled={hasUnusedAccessLevels === false}
                >
                  Add access level
                </EuiButtonEmpty>
              </>
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
