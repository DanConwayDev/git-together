import { addEventsToCache, isInCache } from '$lib/dbs/LocalRelayDb';
import {
	isRelayUpdatePubkey,
	type ARef,
	type EventIdString,
	type LocalDbTableNames,
	type Nip05AddressStandardized,
	type OutboxRelayProcessorUpdate,
	type PubKeyString,
	type RelayUpdate,
	type RepoRef
} from '$lib/types';
import type { NostrEvent } from 'nostr-tools';
import { getEventUID, isReplaceable } from 'applesauce-core/helpers';
import { issue_kind, patch_kind, repo_kind, status_kinds } from '$lib/kinds';
import { Metadata, Reaction, RelayList } from 'nostr-tools/kinds';
import processPubkey, { processNip05 } from './Pubkey';
import type {
	DbItemsCollection,
	DbItemsKeysCollection,
	ProcessorUpdate
} from '$lib/types/processor';
import { getRepoRefs } from '$lib/utils';
import db from '$lib/dbs/LocalDb';
import { getRepoRef } from '$lib/type-helpers/repo';
import processRepoUpdates from './Repo';
import processIssueUpdates from './Issue';
import processPrUpdates from './Pr';
import { processOutboxUpdates } from './Outbox';
import { extractStatusRootId } from '$lib/git-utils';

class Processor {
	/// Processes all new data points to update LocalDb or send events to the InMemoryDB
	/// on the main thread via QueryCentreExternal.
	///
	/// uses queues to prevents multiple processes from attempting to update the same
	/// database line at the same time and causing some updates to be lost. it's
	/// basically a work-around for the lack of support for locking of idb data items
	/// but also a way of batch updates (relay updates are frequent) for efficency
	///
	/// introducing a short delay and batching events and updates significantly reduces
	/// reactivity computation on the main thread.

	event_queue: NostrEvent[] = [];
	outbox_update_queue: OutboxRelayProcessorUpdate[] = [];
	relay_update_queue: RelayUpdate[] = [];
	running: boolean = false;
	sendToInMemoryCacheOnMainThead: (event: NostrEvent) => void;

	constructor(sendToInMemoryCacheOnMainThead: (event: NostrEvent) => void) {
		this.sendToInMemoryCacheOnMainThead = sendToInMemoryCacheOnMainThead;
		// to process relay updates for the next uuid in queue every Xms
		setInterval(() => this.nextRelayUpdateBatch(), 1000);
		// process outbox updates more frequently as ther are less of them
		setInterval(() => this.nextOutboxUpdates(), 99);
	}

	enqueueOutboxUpdate(update: OutboxRelayProcessorUpdate) {
		this.outbox_update_queue.push(update);
	}

	enqueueRelayUpdate(update: RelayUpdate) {
		this.relay_update_queue.push(update);
	}

	seen_on_tracker = new SeenOnTracker();

	enqueueNip05(nip05: Nip05AddressStandardized, pubkey: PubKeyString, relays: string[] = []) {
		// run when next avaiable free
		if (this.running)
			return setTimeout(() => {
				this.enqueueNip05(nip05, pubkey, relays);
			}, 1);
		processNip05(nip05, pubkey, relays);
	}

	// returns seen_in_this_session
	enqueueEvent(event: NostrEvent): boolean {
		if (this.seen_on_tracker.seen(event)) return false;
		// send to main thread in_memory_db
		this.sendToInMemoryCacheOnMainThead(event);
		// don't process events processed in previous sessions
		if (isInCache(event)) return true;
		// add to cache
		const kind_not_to_cache = [Reaction];
		// TODO - do we only want to save event related to repos the user is interested in?
		if (!kind_not_to_cache.includes(event.kind)) addEventsToCache([event]);
		// queue event and process next
		this.event_queue.push(event);
		this.nextEventBatch();
		return true;
	}

	async nextEventBatch() {
		if (this.running) return;
		if (this.event_queue.length > 0) {
			const events = this.event_queue;
			this.event_queue = [];
			this.running = true;
			try {
				const remaining_updates = await processUpdates(
					events.map((event) => ({
						event,
						relay_updates: this.takeUIDBatchFromRelayUpdatesQueue(getEventUID(event)) || []
					}))
				);
				// add remaining updates back into queues
				remaining_updates.forEach((u) => {
					if (u.event) this.event_queue.push(u.event);
					u.relay_updates.forEach((ru) => this.relay_update_queue.push(ru));
				});
			} catch (error) {
				console.log(error);
			}
			if (this.running) setTimeout(() => this.nextEventBatch(), 100);
			this.running = false;
		}
	}

	async nextRelayUpdateBatch() {
		if (this.running) return;
		this.running = true;
		const relay_updates_batch = this.takeTableBatchFromRelayUpdatesQueue();
		if (relay_updates_batch) {
			const grouped = groupTableRelayUpdates(relay_updates_batch);
			await processUpdates(grouped);
			// TODO return unprocessed
		}
		this.running = false;
		this.nextEventBatch();
	}

	takeUIDBatchFromRelayUpdatesQueue(
		uuid?: ARef | EventIdString
	): [RelayUpdate, ...RelayUpdate[]] | undefined {
		if (!this.relay_update_queue[0]) return;
		const uuid_to_use = uuid || this.relay_update_queue[0].uuid;
		const relates_to_uuid: RelayUpdate[] = [];
		this.relay_update_queue = this.relay_update_queue.filter((u) => {
			if (u.uuid === uuid_to_use) {
				relates_to_uuid.push(u);
				return false;
			}
			return true;
		});
		if (relates_to_uuid[0]) return relates_to_uuid as [RelayUpdate, ...RelayUpdate[]];
		else return;
	}

	takeTableBatchFromRelayUpdatesQueue(
		table?: LocalDbTableNames
	): [RelayUpdate, ...RelayUpdate[]] | undefined {
		if (!this.relay_update_queue[0]) return;
		const relates_to_table: RelayUpdate[] = [];
		const table_to_use = table || this.relay_update_queue[0].table;
		this.relay_update_queue = this.relay_update_queue.filter((u) => {
			if (u.table === table_to_use) {
				relates_to_table.push(u);
				return false;
			}
			return true;
		});
		if (relates_to_table[0]) return relates_to_table as [RelayUpdate, ...RelayUpdate[]];
		else return;
	}

	async nextOutboxUpdates() {
		if (this.running) return;
		this.running = true;
		const updates = this.outbox_update_queue;
		this.outbox_update_queue = [];
		await processOutboxUpdates(updates);
		this.running = false;
	}
}

class SeenOnTracker {
	private seen_events: Set<EventIdString> = new Set();
	private seen_replaceable_events: Map<string, number> = new Map();

	/**
	 * returns true if its not been seen and isn't an old version of a replaceable that has been seen, otherwise false
	 */
	seen(event: NostrEvent): boolean {
		if (isReplaceable(event.kind)) {
			const id = getEventUID(event);
			const created_at = this.seen_replaceable_events.get(id);
			if (created_at && created_at > event.created_at) {
				return true;
			}
			this.seen_replaceable_events.set(id, event.created_at);
		} else if (this.seen_events.has(event.id)) {
			return true;
		} else {
			this.seen_events.add(event.id);
		}
		return false;
	}
}

async function processUpdates(updates: ProcessorUpdate[]): Promise<ProcessorUpdate[]> {
	const items = await getExistingItemsToUpdate(updates);
	let remaining_updates = updates;
	for (const processor_fn of [
		processPubkey,
		processRepoUpdates,
		processIssueUpdates,
		processPrUpdates
	]) {
		remaining_updates = await Promise.resolve(processor_fn(items, remaining_updates));
	}

	await Promise.all([
		items.repos.size === 0 ? Promise.resolve([]) : db.repos.bulkPut([...items.repos.values()]),
		items.pubkeys.size === 0
			? Promise.resolve([])
			: db.pubkeys.bulkPut([...items.pubkeys.values()]),
		items.issues.size === 0 ? Promise.resolve([]) : db.issues.bulkPut([...items.issues.values()]),
		items.prs.size === 0 ? Promise.resolve([]) : db.prs.bulkPut([...items.prs.values()])
	]);
	return remaining_updates;
}

async function getExistingItemsToUpdate(updates: ProcessorUpdate[]): Promise<DbItemsCollection> {
	const keys = identifyExistingItemsToUpdate(updates);
	const [repo_items, pubkey_items, issue_items, pr_items] = await Promise.all([
		keys.repos.size === 0 ? Promise.resolve([]) : db.repos.bulkGet([...keys.repos]),
		keys.pubkeys.size === 0 ? Promise.resolve([]) : db.pubkeys.bulkGet([...keys.pubkeys]),
		keys.issues.size === 0 ? Promise.resolve([]) : db.issues.bulkGet([...keys.issues]),
		keys.prs.size === 0 ? Promise.resolve([]) : db.prs.bulkGet([...keys.prs])
	]);
	const table_items: DbItemsCollection = {
		repos: new Map(),
		pubkeys: new Map(),
		issues: new Map(),
		prs: new Map()
	};
	repo_items.forEach((r) => {
		if (r) table_items.repos.set(getRepoRef(r), r);
	});
	pubkey_items.forEach((r) => {
		if (r) table_items.pubkeys.set(r.pubkey, r);
	});
	issue_items.forEach((r) => {
		if (r) table_items.issues.set(r.uuid, r);
	});
	pr_items.forEach((r) => {
		if (r) table_items.prs.set(r.uuid, r);
	});
	return table_items;
}

function identifyExistingItemsToUpdate(updates: ProcessorUpdate[]): DbItemsKeysCollection {
	const exiting_db_item_keys: DbItemsKeysCollection = {
		repos: new Set(),
		pubkeys: new Set(),
		issues: new Set(),
		prs: new Set()
	};
	updates.forEach((u) => {
		if (u.event) {
			switch (u.event.kind) {
				case repo_kind:
					exiting_db_item_keys.repos.add(getEventUID(u.event) as RepoRef);
					break;
				case Metadata:
				case RelayList:
					exiting_db_item_keys.pubkeys.add(u.event.pubkey);
					break;

				case issue_kind: {
					exiting_db_item_keys.issues.add(u.event.id);
					getRepoRefs(u.event).forEach((r) => exiting_db_item_keys.repos.add(r));
					break;
				}
				case patch_kind: {
					// TODO only if root patch
					exiting_db_item_keys.issues.add(u.event.id);
					getRepoRefs(u.event).forEach((r) => exiting_db_item_keys.repos.add(r));
					break;
				}
				default:
					if (status_kinds.includes(u.event.kind)) {
						const root_id = extractStatusRootId(u.event);
						if (root_id) {
							// the status event doesnt make clear what type of table so we get both
							exiting_db_item_keys.issues.add(root_id);
							exiting_db_item_keys.prs.add(root_id);
						}
					}
					break;
			}
		} else {
			switch (u.relay_updates[0].table) {
				case 'repos':
					exiting_db_item_keys.repos.add(u.relay_updates[0].uuid);
					break;
				case 'pubkeys':
					exiting_db_item_keys.pubkeys.add(u.relay_updates[0].uuid.split(':')[1]);
					break;
				case 'issues':
					exiting_db_item_keys.issues.add(u.relay_updates[0].uuid);
					break;
			}
		}
	});
	return exiting_db_item_keys;
}

export function eventKindToTable(kind: number): LocalDbTableNames | undefined {
	if (kind === repo_kind) return 'repos';
	if ([Metadata, RelayList].includes(kind)) return 'pubkeys';
	if (kind === issue_kind) return 'issues';
	if (kind === patch_kind) return 'prs';
	return undefined;
}

function groupTableRelayUpdates(relay_updates: [RelayUpdate, ...RelayUpdate[]]): ProcessorUpdate[] {
	const map: Map<string, ProcessorUpdate> = new Map();
	relay_updates.forEach((u) => {
		const key = isRelayUpdatePubkey(u) ? u.uuid.split(':')[1] : u.uuid;
		const e = map.get(key) || { event: undefined, relay_updates: [] };
		e.relay_updates.push(u);
		map.set(key, e);
	});
	return [...map.values()];
}

export default Processor;
