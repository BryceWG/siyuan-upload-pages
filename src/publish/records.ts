/**
 * Local publish records: one record per (channel, document) pair, kept in the
 * plugin's data folder. A record answers "this document was published there,
 * at that URL, with that content" — which is what both the management dialog
 * and the "republish or skip?" decision in the publish flow rely on.
 */

import { ProviderId, SiteManifest } from "./provider";
import { DataStorage, JsonStore, LoadStatus, isPlainRecord } from "./storage";

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

export type RecordStorage = DataStorage;

export interface UpsertResult {
    record: PublishRecord;
    /** True when the record was created, false when an existing one was refreshed. */
    created: boolean;
}

const isRecord = (value: unknown): value is PublishRecord =>
    typeof value === "object" && value !== null
    && typeof (value as PublishRecord).docId === "string"
    && typeof (value as PublishRecord).url === "string";

interface RecordFile {
    records: PublishRecord[];
    manifests: Partial<Record<ProviderId, SiteManifest>>;
}

/**
 * Accepts every layout the file ever had — a bare array in the oldest version,
 * `{ records, manifests }` since — and returns null for anything else, which
 * marks the file unreadable instead of letting it be replaced by an empty one.
 */
function parseRecordFile(payload: unknown): RecordFile | null {
    if (Array.isArray(payload)) {
        return { records: payload.filter(isRecord), manifests: {} };
    }
    if (!isPlainRecord(payload)) {
        return null;
    }
    if (payload.records !== undefined && !Array.isArray(payload.records)) {
        return null;
    }
    const manifests = payload.manifests;
    return {
        records: Array.isArray(payload.records) ? payload.records.filter(isRecord) : [],
        manifests: isPlainRecord(manifests) ? (manifests as RecordFile["manifests"]) : {},
    };
}

export class RecordStore {
    private store: JsonStore<RecordFile>;

    constructor(storage: RecordStorage, name = "publish-records") {
        this.store = new JsonStore({
            storage,
            name,
            parse: parseRecordFile,
            fallback: () => ({ records: [], manifests: {} }),
        });
    }

    /**
     * Reads the file once. Nothing may be written before this resolved, and
     * nothing at all when it reports `unreadable`: persisting the empty state
     * that a failed read produces would wipe the whole history.
     */
    ready(): Promise<LoadStatus> {
        return this.store.ready();
    }

    get storageName(): string {
        return this.store.name;
    }

    get backupName(): string {
        return this.store.backupName;
    }

    private get records(): PublishRecord[] {
        return this.store.get().records;
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
        return this.store.get().manifests[provider] ?? {};
    }

    async setManifest(provider: ProviderId, manifest: SiteManifest): Promise<void> {
        await this.ready();
        const current = this.store.get();
        await this.store.write({
            records: current.records,
            manifests: { ...current.manifests, [provider]: manifest },
        });
    }

    /**
     * Creates the record on a first publish, or refreshes the existing one on
     * an update: `publishedAt` survives, `updatedAt` tracks the latest deploy.
     */
    async upsert(record: Omit<PublishRecord, "publishedAt" | "updatedAt">): Promise<UpsertResult> {
        await this.ready();
        const now = Date.now();
        const current = this.store.get();
        const existing = this.find(record.provider, record.docId);

        const next: PublishRecord = existing
            ? { ...existing, ...record, updatedAt: now }
            : { ...record, publishedAt: now, updatedAt: now };

        const records = existing
            ? current.records.map((item) => (item === existing ? next : item))
            : [...current.records, next];

        await this.store.write({ records, manifests: current.manifests });
        return { record: next, created: !existing };
    }

    async remove(provider: ProviderId, docId: string): Promise<void> {
        await this.ready();
        const current = this.store.get();
        await this.store.write({
            records: current.records.filter(
                (record) => !(record.provider === provider && record.docId === docId),
            ),
            manifests: current.manifests,
        });
    }
}
