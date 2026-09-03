/**
 * Local publish records: one record per (channel, document) pair, kept in the
 * plugin's data folder. A record answers "this document was published there,
 * at that URL, with that content" — which is what both the management dialog
 * and the "republish or skip?" decision in the publish flow rely on.
 */

import { ProviderId } from "./provider";

export interface PublishRecord {
    /** Root block id of the published document. */
    docId: string;
    /** Document title at publish time. */
    docName: string;
    provider: ProviderId;
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

    constructor(storage: RecordStorage, name = "publish-records") {
        this.storage = storage;
        this.file = name.endsWith(".json") ? name : `${name}.json`;
    }

    async load(): Promise<void> {
        const data = await this.storage.loadData(this.file).catch(() => null);
        const list = Array.isArray(data) ? data : data?.records;
        this.records = Array.isArray(list) ? list.filter(isRecord) : [];
    }

    /** All records, most recently updated first. */
    all(): PublishRecord[] {
        return [...this.records].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    find(provider: ProviderId, docId: string): PublishRecord | undefined {
        return this.records.find((record) => record.provider === provider && record.docId === docId);
    }

    /**
     * Creates the record on a first publish, or refreshes the existing one on
     * an update: `publishedAt` survives, `updatedAt` tracks the latest deploy.
     */
    async upsert(record: Omit<PublishRecord, "publishedAt" | "updatedAt">): Promise<UpsertResult> {
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
        this.records = this.records.filter(
            (record) => !(record.provider === provider && record.docId === docId),
        );
        await this.persist();
    }

    private async persist(): Promise<void> {
        await this.storage.saveData(this.file, this.records);
    }
}
