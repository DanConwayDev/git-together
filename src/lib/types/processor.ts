import type { NostrEvent } from 'nostr-tools';
import {
	isRelayUpdateIssue,
	isRelayUpdatePubkey,
	isRelayUpdateRepoAnn,
	type RelayUpdate,
	type RelayUpdateIssue,
	type RelayUpdateRepoAnn,
	type RelayUpdateUser
} from './relay-checks';
import { Metadata, RelayList } from 'nostr-tools/kinds';
import type { RepoRef } from './git';
import type { EventIdString, PubKeyString } from './general';
import type { IssueOrPRTableItem, PubKeyTableItem, RepoTableItem } from './tables';
import { issue_kind, repo_kind } from '$lib/kinds';

export type UpdateProcessor = (
	existing_items: DbItemsCollection,
	updates: ProcessorUpdate[]
) => ProcessorUpdate[];

export interface DbItemsKeysCollection {
	repos: Set<RepoRef>;
	pubkeys: Set<PubKeyString>;
	issues: Set<EventIdString>;
	prs: Set<EventIdString>;
}

export interface DbItemsCollection {
	repos: Map<RepoRef, RepoTableItem>;
	pubkeys: Map<PubKeyString, PubKeyTableItem>;
	issues: Map<EventIdString, IssueOrPRTableItem>;
	prs: Map<EventIdString, IssueOrPRTableItem>;
}

export interface ProcessorUpdate {
	event: NostrEvent | undefined;
	relay_updates: RelayUpdate[];
}

export interface ProcessorRepoUpdate {
	event: (NostrEvent & { kind: 30617 }) | undefined;
	relay_updates: RelayUpdateRepoAnn[];
}

export const isProcessorRepoUpdate = (u: ProcessorUpdate): u is ProcessorRepoUpdate =>
	(u.event && u.event.kind === repo_kind) ||
	u.relay_updates.every((ru) => isRelayUpdateRepoAnn(ru));

export interface ProcessorPubkeyUpdate {
	event: (NostrEvent & { kind: Metadata | RelayList }) | undefined;
	relay_updates: RelayUpdateUser[];
}
export const isProcessorPubkeyUpdate = (u: ProcessorUpdate): u is ProcessorPubkeyUpdate =>
	(u.event && [Metadata, RelayList].includes(u.event.kind)) ||
	u.relay_updates.every((ru) => isRelayUpdatePubkey(ru));

export interface ProcessorIssueUpdate {
	event: (NostrEvent & { kind: 1621 }) | undefined;
	relay_updates: RelayUpdateIssue[];
}

export const isProcessorIssueUpdate = (u: ProcessorUpdate): u is ProcessorIssueUpdate =>
	(u.event && u.event.kind === issue_kind) || u.relay_updates.every((ru) => isRelayUpdateIssue(ru));
