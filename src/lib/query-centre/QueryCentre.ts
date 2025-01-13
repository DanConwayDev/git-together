import {
	isRepoRef,
	standardizeNip05,
	type Nip05Address,
	type PubKeyString,
	type RepoRef
} from '$lib/types';
import { isEvent } from 'applesauce-core/helpers';
import memory_db from '$lib/dbs/InMemoryRelay';
import db from '$lib/dbs/LocalDb';
import { liveQueryState } from '$lib/helpers.svelte';

class QueryCentre {
	external_worker: Worker;

	constructor() {
		this.external_worker = new Worker(new URL('./QueryCentreExternal.ts', import.meta.url), {
			type: 'module'
		});
		this.external_worker.onmessage = (msg: MessageEvent) => {
			if (isEvent(msg)) {
				memory_db.add(msg);
			}
		};
	}

	fetchAllRepos() {
		this.external_worker.postMessage({ method: 'fetchAllRepos', args: [] });
		return liveQueryState(() => db.repos.toArray());
	}

	fetchRepo(a_ref: RepoRef | string) {
		if (isRepoRef(a_ref)) this.external_worker.postMessage({ method: 'fetchRepo', args: [a_ref] });
		// if a_ref its not RepoRef it we will just return the undefined
		return liveQueryState(() => db.repos.get(a_ref as RepoRef));
	}

	searchRepoAnns(query: string) {
		this.external_worker.postMessage({ method: 'fetchAllRepos', args: [] });
		if (query.length === 0) this.fetchAllRepos();
		return liveQueryState(() =>
			db.repos.where('searchWords').startsWithAnyOfIgnoreCase(query).distinct().toArray()
		);
	}

	fetchPubkeyName(pubkey: PubKeyString) {
		this.external_worker.postMessage({ method: 'fetchPubkeyName', args: [pubkey] });
		return liveQueryState(() => db.pubkeys.get(pubkey));
	}

	fetchNip05(nip05: Nip05Address) {
		const standardized_nip05 = standardizeNip05(nip05);
		this.external_worker.postMessage({ method: 'fetchNip05', args: [standardized_nip05] });
		return liveQueryState(() =>
			db.pubkeys.where('verified_nip05.address').equals(standardized_nip05).first()
		);
	}
}

const query_centre = new QueryCentre();
export default query_centre;
