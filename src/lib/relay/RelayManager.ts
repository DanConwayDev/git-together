import { Relay, type NostrEvent } from 'nostr-tools';
import db from '$lib/dbs/LocalDb';
import { issue_kind, patch_kind, repo_kind } from '$lib/kinds';
import { addSeenRelay, getEventUID, unixNow } from 'applesauce-core/helpers';
import {
	type PubKeyString,
	type WebSocketUrl,
	type RelayCheckTimestamp,
	type ARefR,
	type RepoRef,
	type RelayUpdateRepoAnn,
	type RelayUpdateRepoChildren,
	type EventIdString,
	type RepoCheckLevel,
	type ARefP
} from '$lib/types';
import { Metadata, Reaction, RelayList } from 'nostr-tools/kinds';
import type Processor from '$lib/processors/Processor';
import { eventKindToTable } from '$lib/processors/Processor';
import { eventIsPrRoot, getRepoRefs } from '$lib/utils';
import type { Subscription } from 'nostr-tools/abstract-relay';
import { repoTableItemToRelayCheckTimestamp } from './RelaySelection';
import {
	createPubkeyFiltersGroupedBySince,
	createRepoChildrenFilters,
	createRepoIdentifierFilters
} from './filters';
import { createFetchActionsFilter } from './filters/actions';
import { addEventsToCache } from '$lib/dbs/LocalRelayDb';
import type { NEventAttributes } from 'nostr-editor';
import SubscriberManager from '$lib/SubscriberManager';

export class RelayManager {
	url: WebSocketUrl;
	processor: Processor;
	relay: Relay;
	inactivity_timer: NodeJS.Timeout | null = null;

	constructor(url: WebSocketUrl, processor: Processor) {
		this.url = url;
		this.processor = processor;
		this.relay = new Relay(url);
	}

	async connect(): Promise<void> {
		this.resetInactivityTimer();
		if (!this.relay.connected) {
			await this.relay.connect();
		}
		if (!this.relay.connected) {
			// nostr-tools relay doesnt reconnect so we create a new one
			this.relay = new Relay(this.url);
		}
		this.resetInactivityTimer();
	}

	resetInactivityTimer() {
		if (this.inactivity_timer) {
			clearTimeout(this.inactivity_timer);
		}
		this.inactivity_timer = setTimeout(() => {
			this.relay.close();
			this.relay = new Relay(this.url);
		}, 60000); // 60 seconds of inactivity
	}

	async publishEvent(event: NostrEvent) {
		return Promise.race([
			(async (): Promise<{ success: boolean; msg: string }> => {
				try {
					await this.connect();
					const msg = await this.relay.publish(event);
					this.processor.enqueueOutboxUpdate({
						id: event.id,
						relay: this.url,
						success: true,
						msg
					});
					return { success: true, msg };
				} catch (error) {
					this.processor.enqueueOutboxUpdate({
						id: event.id,
						relay: this.url,
						success: false,
						msg: `${error}`
					});
					return { success: false, msg: `${error}` };
				}
			})(),
			new Promise<{ success: boolean; msg: string }>((r) => {
				setTimeout(() => {
					this.processor.enqueueOutboxUpdate({
						id: event.id,
						relay: this.url,
						success: false,
						msg: `timeout internal`
					});
					r({ success: false, msg: `timeout internal` });
				}, 30 * 1000);
			})
		]);
	}

	onEvent(event: NostrEvent) {
		addSeenRelay(event, this.url);
		if (event.kind == repo_kind) {
			const table = eventKindToTable(event.kind);
			if (table) {
				this.processor.enqueueRelayUpdate({
					type: 'found',
					uuid: getEventUID(event),
					kinds: [event.kind],
					created_at: event.created_at,
					table,
					url: this.url
				} as RelayUpdateRepoAnn);
			}
			this.processor.enqueueEvent(event);
		} else if (event.kind === Metadata || event.kind === RelayList) {
			try {
				this.processor.enqueueRelayUpdate({
					type: 'found',
					uuid: getEventUID(event) as ARefR,
					kinds: [event.kind],
					created_at: event.created_at,
					table: 'pubkeys',
					url: this.url
				});
				this.processor.enqueueEvent(event);
				this.fetch_pubkey_info_promises.resolvePromises(event.pubkey);
			} catch {
				/* empty */
			}
		} else if (event.kind === issue_kind || eventIsPrRoot(event)) {
			this.processor.enqueueRelayUpdate({
				type: 'found',
				uuid: event.id,
				kinds: [event.kind],
				table: event.kind === issue_kind ? 'issues' : 'prs',
				url: this.url
			});
			this.processor.enqueueEvent(event);
		} else {
			// TODO patch kind where ? eventIsPrRoot()
			// TODO statuses
			this.processor.sendToInMemoryCacheOnMainThead(event);
			const kind_not_to_cache = [Reaction];
			if (!kind_not_to_cache.includes(event.kind)) addEventsToCache([event]);
		}
	}

	async fetchAllRepos(pubkey?: PubKeyString) {
		const checks = await db.last_checks.get(`${this.url}|${pubkey}`);
		if (checks && checks.check_initiated_at && checks.check_initiated_at > Date.now() - 3000)
			return;
		db.last_checks.put({
			url_and_query: `${this.url}|${pubkey}`,
			url: this.url,
			check_initiated_at: Date.now(),
			timestamp: checks ? checks.timestamp : 0,
			// timestamp: unixNow(),
			query: pubkey ? pubkey : 'All Repos'
		});
		await this.connect();
		return new Promise<void>((r) => {
			const sub = this.relay.subscribe(
				[
					{
						kinds: [repo_kind],
						since: !pubkey && checks ? Math.round(checks.timestamp - 60 * 10) : 0
						// TODO: what if this last check failed to reach the relay?
						// limit: 100,
						// TODO request next batch if 100 recieved
					}
				],
				{
					onevent: this.onEvent,
					oneose: async () => {
						sub.close();
						this.resetInactivityTimer();
						db.last_checks.put({
							url_and_query: `${this.url}|${pubkey}`,
							url: this.url,
							check_initiated_at: undefined,
							timestamp: unixNow(),
							query: pubkey ? pubkey : 'All Repos'
						});
						r();
					}
				}
			);
		});
	}

	pubkey_metadata_queue: Map<PubKeyString, RelayCheckTimestamp> = new Map();
	set_pubkey_queue_timeout: ReturnType<typeof setTimeout> | undefined = undefined;
	fetch_pubkey_info_promises = new PromiseManager<PubKeyString, undefined>();

	async fetchPubkeyInfo(pubkey: PubKeyString, check_timestamp: RelayCheckTimestamp) {
		if (!this.pubkey_metadata_queue.has(pubkey)) {
			this.pubkey_metadata_queue.set(pubkey, check_timestamp);
			await this.connect();
			if (!this.set_pubkey_queue_timeout) {
				this.set_pubkey_queue_timeout = setTimeout(async () => {
					this.fetchPubkeyQueue();
				}, 200);
			}
		}
		await this.fetch_pubkey_info_promises.addPromise(pubkey, 10 * 1000);
	}

	fetching_pubkey_queue = false;
	async fetchPubkeyQueue() {
		if (this.fetching_pubkey_queue === true) {
			return setTimeout(() => {
				this.fetchPubkeyQueue();
			}, 1);
		}

		if (this.pubkey_metadata_queue.size === 0) return;
		this.fetching_pubkey_queue = true;
		await this.connect();
		const filters = createPubkeyFiltersGroupedBySince(this.pubkey_metadata_queue);
		this.pubkey_metadata_queue.clear();
		clearTimeout(this.set_pubkey_queue_timeout);
		this.set_pubkey_queue_timeout = undefined;
		const found_metadata = new Set<string>();
		const found_relay_list = new Set<string>();
		const sub = this.relay.subscribe(filters, {
			onevent: async (event) => {
				if (event.kind === Metadata || event.kind === RelayList) {
					this.onEvent(event);
					(event.kind === Metadata ? found_metadata : found_relay_list).add(event.pubkey);
				}
			},
			oneose: async () => {
				sub.close();
				this.resetInactivityTimer();
				for (const filter of filters) {
					for (const pubkey of filter.authors) {
						this.fetch_pubkey_info_promises.resolvePromises(pubkey);
						if (filter.since) {
							this.processor.enqueueRelayUpdate({
								type: 'checked',
								uuid: `${Metadata}:${pubkey}` as ARefR,
								kinds: [Metadata],
								table: 'pubkeys',
								url: this.url
							});
						} else {
							if (!found_metadata.has(pubkey)) {
								this.processor.enqueueRelayUpdate({
									type: 'not-found',
									uuid: `${Metadata}:${pubkey}` as ARefR,
									kinds: [Metadata],
									table: 'pubkeys',
									url: this.url
								});
							}
							if (!found_metadata.has(pubkey)) {
								this.processor.enqueueRelayUpdate({
									type: 'not-found',
									uuid: `${RelayList}:${pubkey}` as ARefR,
									kinds: [RelayList],
									table: 'pubkeys',
									url: this.url
								});
							}
						}
					}
				}
				this.fetching_pubkey_queue = false;
			}
		});
	}

	repo_queue: Map<RepoRef, RelayCheckTimestamp> = new Map();
	set_repo_queue_timeout: ReturnType<typeof setTimeout> | undefined = undefined;
	fetch_repo_promises = new PromiseManager<RepoRef, () => void>();

	async fetchRepo(
		a_ref: RepoRef,
		check_timestamp: RelayCheckTimestamp,
		level: RepoCheckLevel = 'children'
	) {
		if (level === 'quality_grandchildren') {
			console.log('TODO: handle quality_grandchildren');
		}
		if (!this.repo_queue.has(a_ref)) {
			this.repo_queue.set(a_ref, check_timestamp);
			await this.connect();
			if (!this.set_repo_queue_timeout) {
				this.set_repo_queue_timeout = setTimeout(async () => {
					this.fetchRepoQueue();
				}, 200);
			}
		}
		return this.fetch_repo_promises.addPromise(a_ref, 20 * 1000);
	}

	fetching_repo_queue = false;

	async fetchRepoQueue() {
		if (this.fetching_repo_queue === true) {
			return setTimeout(() => {
				this.fetchRepoQueue();
			}, 1);
		}

		if (this.repo_queue.size === 0) return;
		this.fetching_repo_queue = true;
		await this.connect();
		// read to process the queue
		const a_refs = new Map(this.repo_queue);
		this.repo_queue.clear();
		clearTimeout(this.set_repo_queue_timeout);
		this.set_repo_queue_timeout = undefined;
		// add all repos with same identifier to queue
		(
			await db.repos
				.where('identifier')
				.anyOf([...new Set<RepoRef>([...a_refs.keys()])])
				.toArray()
		).forEach((record) => {
			a_refs.set(record.uuid, repoTableItemToRelayCheckTimestamp(record, this.url));
		});
		const found_a_ref = new Set<RepoRef>();
		const a_refs_to_search = new Set<RepoRef>(a_refs.keys());
		const searched_a_refs = new Set<RepoRef>();
		const found_issues_and_pr_roots = new Set<EventIdString>();

		const filters = [...createRepoIdentifierFilters(a_refs), ...createRepoChildrenFilters(a_refs)];

		const onevent = (event: NostrEvent) => {
			this.onEvent(event);
			if (event.kind === repo_kind) {
				found_a_ref.add(getEventUID(event) as RepoRef);
			} else if (event.kind === issue_kind || eventIsPrRoot(event)) {
				getRepoRefs(event).forEach((repo_ref) => {
					found_a_ref.add(repo_ref);
				});
				found_issues_and_pr_roots.add(event.id);
			} else {
				// TODO statuses
			}
		};
		const onEoseRecursivelyGetDisoveredARefResults = async (sub: Subscription) => {
			sub.close();
			this.resetInactivityTimer();
			for (const a_ref of a_refs_to_search) {
				this.processor.enqueueRelayUpdate({
					type: 'checked',
					uuid: a_ref,
					table: 'repos',
					kinds: [patch_kind, issue_kind],
					url: this.url
				} as RelayUpdateRepoChildren);
				if (filters.some((f) => f['#d'] && f['#d'].includes(a_ref) && !f.since)) {
					this.processor.enqueueRelayUpdate({
						type: 'checked',
						uuid: a_ref,
						kinds: [repo_kind],
						table: 'repos',
						url: this.url
					} as RelayUpdateRepoAnn);
				} else {
					if (!found_a_ref.has(a_ref)) {
						this.processor.enqueueRelayUpdate({
							type: 'not-found',
							uuid: a_ref,
							kinds: [repo_kind],
							table: 'repos',
							url: this.url
						} as RelayUpdateRepoAnn);
					}
				}
			}
			a_refs_to_search.forEach((a) => searched_a_refs.add(a));
			a_refs_to_search.clear();
			const getDiscovered = () => searched_a_refs.difference(found_a_ref);

			while (getDiscovered().size > 0) {
				await new Promise<void>((r) => {
					const sub = this.relay.subscribe(createRepoChildrenFilters(getDiscovered()), {
						onevent,
						oneose: () => {
							onEoseRecursivelyGetDisoveredARefResults(sub);
							r();
						}
					});
				});
			}
		};

		const sub = this.relay.subscribe(filters, {
			onevent,
			oneose: async () => {
				await onEoseRecursivelyGetDisoveredARefResults(sub);
				searched_a_refs.forEach((a_ref) => {
					const unsubsriber = this.watchRepo(
						a_ref,
						// these are actually the tags found for the whole queue but it doesnt matter too much
						// TODO: why are we getting grandchildren here? if we are we should get all known ones from db.repos as this just covers those recieved since last check
						{ a_tags: [...found_a_ref], e_tags: [...found_issues_and_pr_roots] }
					);
					this.fetch_repo_promises.resolvePromises(a_ref, unsubsriber);
				});
			}
		});
	}

	watching_a_refs = new Map<RepoRef, { a_tags: (ARefR | ARefP)[]; e_tags: EventIdString[] }>();
	watch_repos_sub: Subscription | undefined = undefined;
	subscriber_manager = new SubscriberManager();

	watchRepo(a_ref: RepoRef, events: { a_tags: (ARefR | ARefP)[]; e_tags: EventIdString[] }) {
		const query = `watchRepos${a_ref}`;
		this.subscriber_manager.add(query);
		this.updateReposWatch(a_ref, events);
		const interval_id = setInterval(() => this.resetInactivityTimer(), 50000);

		const unsubriber = () => {
			clearInterval(interval_id);
			if (this.subscriber_manager.remove(query)) {
				this.removeRepoWatcher(a_ref);
			}
		};
		this.subscriber_manager.addUnsubsriber(query, unsubriber);

		return unsubriber;
	}

	removeRepoWatcher(a_ref: RepoRef) {
		this.watching_a_refs.delete(a_ref);
		if (this.watching_a_refs.size === 0) {
			this.watch_repos_sub?.close();
		} else {
			// no need to refresh the subscrition without the a_ref, its doing no harm
		}
	}

	/**
	 * update events to watch related to a RepoRef we are watching
	 * @param a_ref RepoRef of the repository we are currently watching
	 * @param events additional event tags to watch related to the repo
	 */
	updateReposWatch(a_ref: RepoRef, events: { a_tags: (ARefR | ARefP)[]; e_tags: EventIdString[] }) {
		const query_a_tags = new Set<ARefR | ARefP>();
		const query_e_tags = new Set<EventIdString>();

		this.watching_a_refs.forEach(({ a_tags, e_tags }) => {
			a_tags.forEach((tag) => query_a_tags.add(tag));
			e_tags.forEach((tag) => query_e_tags.add(tag));
		});

		let change = false;

		events.a_tags.forEach((t) => {
			if (!change && !query_a_tags.has(t)) change = true;
			query_a_tags.add(t);
		});

		events.e_tags.forEach((t) => {
			if (!change && !query_e_tags.has(t)) change = true;
			query_e_tags.add(t);
		});

		if (change) {
			this.watch_repos_sub?.close();
			this.watch_repos_sub = this.relay.subscribe(
				[
					{
						'#a': query_a_tags.size == 0 ? undefined : [...query_a_tags],
						'#e': query_e_tags.size == 0 ? undefined : [...query_e_tags],
						since: unixNow()
					},
					{
						kinds: [repo_kind, issue_kind, patch_kind],
						since: unixNow()
					}
				],
				{
					onevent: (event) => this.onEvent(event),
					eoseTimeout: 60 * 60 * 1000
				}
			);
		}
	}

	async fetchIssueThread(
		a_ref: RepoRef,
		id: EventIdString,
		known_replies: EventIdString[] = []
	): Promise<EventIdString[]> {
		await this.connect();
		return await new Promise((r) => {
			let ids_searched: EventIdString[] = [];
			let ids_to_find: EventIdString[] = [id, ...known_replies];
			let sub: Subscription;
			const onevent = (event: NostrEvent) => {
				this.processor.sendToInMemoryCacheOnMainThead(event);
				const kind_not_to_cache = [Reaction];
				if (!kind_not_to_cache.includes(event.kind)) addEventsToCache([event]);
				// TODO selectively process (add to Issue Thread info)
				const kinds_not_to_request_replys_for = [Reaction];
				if (!kinds_not_to_request_replys_for.includes(event.kind)) ids_to_find.push(event.id);
			};
			const onEose = (sub: Subscription) => {
				sub.close();
				findNext();
			};
			const findNext = () => {
				this.resetInactivityTimer();
				ids_searched = [...ids_searched, ...ids_to_find];
				// TODO get from other relays via db.issues.get(id)
				if (ids_to_find.length === 0) r(ids_searched);
				else {
					sub = this.relay.subscribe([{ '#e': [...ids_to_find] }], {
						onevent,
						oneose: () => {
							onEose(sub);
						}
					});
					ids_to_find = [];
				}
			};
			findNext();
		});
	}
	async fetchEvent(event_ref: NEventAttributes): Promise<NostrEvent | undefined> {
		await this.connect();
		return await new Promise<NostrEvent | undefined>((r) => {
			const sub = this.relay.subscribe([{ ids: [event_ref.id] }], {
				onevent: async (event) => {
					if (event.id !== event_ref.id) return;
					this.processor.sendToInMemoryCacheOnMainThead(event);
					r(event);
				},
				oneose: () => {
					sub.close();
					r(undefined);
				}
			});
		});
	}
	async fetchActions(a_ref: RepoRef): Promise<void> {
		await this.connect();
		await new Promise<void>((r) => {
			const sub = this.relay.subscribe(createFetchActionsFilter(a_ref), {
				onevent: async (event) => {
					this.processor.sendToInMemoryCacheOnMainThead(event);
				},
				oneose: () => {
					sub.close();
					r();
				}
			});
		});
	}
}

class PromiseManager<T, R = void> {
	private promises: Map<T, Promise<R>> = new Map();
	private resolvers: Map<T, (value?: R | PromiseLike<R>) => void> = new Map();
	private timeoutIds: Map<T, NodeJS.Timeout> = new Map();

	// Method to add a new promise for a given key with an optional timeout
	addPromise(key: T, timeout?: number): Promise<R> {
		// If a promise already exists for this key, return it
		if (this.promises.has(key)) {
			return this.promises.get(key)!; // Non-null assertion
		}

		// Create a new promise and store it
		const promise = new Promise<R>((resolve, reject) => {
			this.resolvers.set(key, resolve as (value: R | PromiseLike<R> | undefined) => void);

			// Set a timeout if specified
			if (timeout) {
				const timeoutId = setTimeout(() => {
					reject(new Error(`Promise for key "${key}" timed out after ${timeout} ms`));
					this.cleanup(key); // Clean up on timeout
				}, timeout);
				this.timeoutIds.set(key, timeoutId);
			}
		});

		// Store the promise in the map
		this.promises.set(key, promise);

		// Return the promise
		return promise;
	}

	// Method to resolve all promises for a given key
	resolvePromises(key: T, value?: R): void {
		const resolver = this.resolvers.get(key);
		if (resolver) {
			resolver(value); // Call the resolver function with the provided value
			this.cleanup(key); // Clean up after resolving
		}
	}

	// Cleanup method to remove promise, resolver, and timeout
	private cleanup(key: T): void {
		this.promises.delete(key); // Remove the promise from the map
		this.resolvers.delete(key); // Clean up the resolver
		const timeoutId = this.timeoutIds.get(key);
		if (timeoutId) {
			clearTimeout(timeoutId); // Clear the timeout if it exists
			this.timeoutIds.delete(key); // Clean up the timeout ID
		}
	}
}
