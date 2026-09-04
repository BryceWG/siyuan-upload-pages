/**
 * Local publish records: one record per (channel, document) pair, kept in the
 * plugin's data folder. A record answers "this document was published there,
 * at that URL, with that content" — which is what both the management dialog
 * and the "republish or skip?" decision in the publish flow rely on.
 */

import { ProviderId, SiteManifest } from "./provider";

export interface PublishRecord {
    /** Root block id of the published document. */
    docId: string;
    /** Document title at publish time. */
    docName: string;
    provider: ProviderId;
    /** Path segment the page is served under, e.g. `my-note` in `/my-note/`. */
    slug: string;
    /** Remote deployment id, used when deleting the publish. */
    deploymentId: string;
    /** Public URL of the deployment. */
    url: string;
    /** Fingerprint of the built site files; equal fingerprints mean an equal page. */
    fingerprint: string;
    /** Epoch ms of the first publish to this channel. */
    publishedAt: number;
    /** Epoch ms of the most recent publish to this channel. */
    updatedAt: number;
}

/** Only the two data methods the store needs, so it does not depend on the Plugin type. */
export interface RecordStorage {
    loadData(storageName: string): Promise<any>;
    saveData(storageName: string, content: any): Promise<any>;
}

export interface UpsertResult {
    record: PublishRecord;
    /** True when the record was created, false when an existing one was refreshed. */
    created: boolean;
}

const isRecord = (value: unknown): value is PublishRecord =>
    typeof value === "object" && value !== null
    && typeof (value as PublishRecord).docId === "string"
    && typeof (value as PublishRecord).url === "string";

export class RecordStore {
    private storage: RecordStorage;
    private file: string;
    private records: PublishRecord[] = [];
    private manifests: Partial<Record<ProviderId, SiteManifest>> = {};
    private reading?: Promise<void>;
    private loaded = false;

    constructor(storage: RecordStorage, name = "publish-records") {
        this.storage = storage;
        this.file = name.endsWith(".json") ? name : `${name}.json`;
    }

    /**
     * Reads the file once, and rejects when it cannot be read. Nothing may be
     * written before this resolved: `loadData` rejects on a plugin instance
     * whose lifecycle has ended (which happens on every dev live reload), and
     * persisting the resulting empty state would wipe the whole history.
     */
    ready(): Promise<void> {
        if (!this.reading) {
            this.reading = this.read().catch((error) => {
                // Allow a later attempt to retry instead of failing forever.
                this.reading = undefined;
                throw error;
            });
        }
        return this.reading;
    }

    private async read(): Promise<void> {
        const data = await this.storage.loadData(this.file);
        const list = Array.isArray(data) ? data : data?.records;
        this.records = Array.isArray(list) ? list.filter(isRecord) : [];
        this.manifests = (!Array.isArray(data) && typeof data?.manifests === "object" && data.manifests)
            ? data.manifests
            : {};
        this.loaded = true;
    }

    /** All records, most recently updated first. */
    all(): PublishRecord[] {
        return [...this.records].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    find(provider: ProviderId, docId: string): PublishRecord | undefined {
        return this.records.find((record) => record.provider === provider && record.docId === docId);
    }

    forProvider(provider: ProviderId): PublishRecord[] {
        return this.records.filter((record) => record.provider === provider);
    }

    /** What the last deployment to this channel served. */
    manifest(provider: ProviderId): SiteManifest {
        return this.manifests[provider] ?? {};
    }

    async setManifest(provider: ProviderId, manifest: SiteManifest): Promise<void> {
        await this.ready();
        this.manifests[provider] = manifest;
        await this.persist();
    }

    /**
     * Creates the record on a first publish, or refreshes the existing one on
     * an update: `publishedAt` survives, `updatedAt` tracks the latest deploy.
     */
    async upsert(record: Omit<PublishRecord, "publishedAt" | "updatedAt">): Promise<UpsertResult> {
        await this.ready();
        const now = Date.now();
        const existing = this.find(record.provider, record.docId);
        if (existing) {
            Object.assign(existing, record, { updatedAt: now });
            await this.persist();
            return { record: existing, created: false };
        }

        const created: PublishRecord = { ...record, publishedAt: now, updatedAt: now };
        this.records.push(created);
        await this.persist();
        return { record: created, created: true };
    }

    async remove(provider: ProviderId, docId: string): Promise<void> {
        await this.ready();
        this.records = this.records.filter(
            (record) => !(record.provider === provider && record.docId === docId),
        );
        await this.persist();
    }

    private async persist(): Promise<void> {
        if (!this.loaded) {
            throw new Error("publish records were not loaded, refusing to overwrite the file");
        }
        await this.storage.saveData(this.file, {
            records: this.records,
            manifests: this.manifests,
        });
    }
}
