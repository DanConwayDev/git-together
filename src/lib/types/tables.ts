import {
	type LastActivity,
	type WithRelaysInfo,
	type PubKeyInfo,
	type NonReplaceableEventAttribution,
	type IssuesOrPrsByStatus,
	type IssueOrPrBase,
	type RepoAnn,
	type ARefP,
	type PubKeyString,
	isARefP,
	type RepoRef
} from '$lib/types';
import { aRefPToAddressPointer } from '$lib/utils';
import type { WithLoading } from './ui';

export interface PubKeyTableItem extends WithRelaysInfo, PubKeyInfo {}

export interface RepoTableItem extends LastActivity, WithRelaysInfo, Partial<RepoAnn> {
	uuid: ARefP;
	identifier: string;
	author: PubKeyString;
	/// undefined if no check has been carried out
	issues: IssuesOrPrsByStatus | undefined;
	/// undefined if no check has been carried out
	PRs: IssuesOrPrsByStatus | undefined;
	/// auto updated using dexie hooks
	searchWords: string[];
}

export function repoTableItemDefaults(a_ref: ARefP | string): RepoTableItem & WithLoading {
	const isP = isARefP(a_ref);
	const { identifier, pubkey } = isP
		? aRefPToAddressPointer(a_ref)
		: { identifier: 'unknown', pubkey: '' };
	return {
		uuid: a_ref as RepoRef,
		identifier,
		author: pubkey,
		relays_info: {},
		last_activity: 0,
		issues: undefined,
		PRs: undefined,
		searchWords: [...[]],
		// external fetch is only called if valid RepoRef
		loading: isP
	};
}

export interface IssueOrPRTableItem
	extends NonReplaceableEventAttribution,
		LastActivity,
		WithRelaysInfo,
		IssueOrPrBase {}
