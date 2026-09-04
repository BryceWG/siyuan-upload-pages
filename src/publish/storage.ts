/**
 * The persistence primitive shared by every stored file of the plugin.
 *
 * `Plugin.loadData` is not a trustworthy source on its own: it resolves instead
 * of rejecting when the file cannot be read, and what it resolves to depends on
 * the failure. A missing file yields `""`, a kernel error yields the
 * `{ code, msg }` response object, and a half-written file yields the raw text
 * because `JSON.parse` threw. Every one of those looks like "no data yet" to a
 * naive reader, which then answers with the defaults — and the next save
 * persists those defaults over the file that was there all along.
 *
 * So loading classifies the result into three states, and only two of them
 * allow a write. `unreadable` freezes the file: nothing is written over data we
 * failed to understand.
 */

/** The two `Plugin` methods a store needs, so stores do not depend on the Plugin type. */
export interface DataStorage {
    loadData(storageName: string): Promise<any>;
    saveData(storageName: string, content: any): Promise<any>;
}

export type LoadStatus =
    /** The stored payload was read and understood. */
    | "loaded"
    /** No file yet (fresh install) — defaults apply and may be saved. */
    | "empty"
    /** A file exists but could not be read or parsed. Writing is refused. */
    | "unreadable";

/** Wrapper written around every payload, so a read can tell our own file apart. */
interface Envelope {
    __store: 1;
    updatedAt: number;
    data: unknown;
}

const isEnvelope = (value: any): value is Envelope =>
    typeof value === "object" && value !== null && value.__store === 1 && "data" in value;

/** The shape `/api/file/getFile` answers with when it fails. */
const isKernelError = (value: any): boolean =>
    typeof value === "object" && value !== null
    && typeof value.code === "number" && typeof value.msg === "string"
    && !("__store" in value);

/**
 * A single JSON file, read once and written through a queue.
 *
 * `T` is produced by `parse`, which is also the validator: returning `null`
 * means "this is not my data", and the file is then treated as unreadable
 * rather than replaced.
 */
export class JsonStore<T> {
    private readonly file: string;
    private readonly backupFile: string;
    private readonly storage: DataStorage;
    private readonly parse: (payload: unknown) => T | null;
    private readonly fallback: () => T;

    private value: T;
    private status: LoadStatus = "empty";
    private reading?: Promise<LoadStatus>;
    /** Serialises writes: two saves in the same tick must not race on the file. */
    private writing: Promise<unknown> = Promise.resolve();
    /** The last good payload is mirrored once per session, before it is first overwritten. */
    private backedUp = false;

    constructor(args: {
        storage: DataStorage;
        name: string;
        parse: (payload: unknown) => T | null;
        fallback: () => T;
    }) {
        this.storage = args.storage;
        this.file = args.name.endsWith(".json") ? args.name : `${args.name}.json`;
        this.backupFile = this.file.replace(/\.json$/, ".bak.json");
        this.parse = args.parse;
        this.fallback = args.fallback;
        this.value = args.fallback();
    }

    get name(): string {
        return this.file;
    }

    get backupName(): string {
        return this.backupFile;
    }

    /** Reads the file at most once per successful attempt; retries after a failure. */
    ready(): Promise<LoadStatus> {
        if (!this.reading) {
            this.reading = this.read().catch((error) => {
                // An unexpected throw is a failed read, not an empty file.
                console.error(`[publish-pages] ${this.file} could not be read`, error);
                this.reading = undefined;
                this.status = "unreadable";
                return this.status;
            });
        }
        return this.reading;
    }

    private async read(): Promise<LoadStatus> {
        const primary = classify(await this.storage.loadData(this.file), this.parse);
        if (primary.status === "loaded") {
            this.value = primary.value;
            this.status = "loaded";
            return this.status;
        }

        // A corrupt primary is recoverable as long as the mirror survived: it
        // holds the payload of the last save that completed.
        if (primary.status === "unreadable") {
            const backup = classify(await this.storage.loadData(this.backupFile), this.parse);
            if (backup.status === "loaded") {
                console.warn(`[publish-pages] ${this.file} was unreadable, recovered from ${this.backupFile}`);
                this.value = backup.value;
                this.status = "loaded";
                // The mirror is the source of truth now; keep it until the next save.
                this.backedUp = true;
                return this.status;
            }
            this.status = "unreadable";
            return this.status;
        }

        this.value = this.fallback();
        this.status = "empty";
        return this.status;
    }

    get(): T {
        return this.value;
    }

    /** True when a write is allowed, i.e. the stored state is known. */
    get writable(): boolean {
        return this.status !== "unreadable";
    }

    get loadStatus(): LoadStatus {
        return this.status;
    }

    /**
     * Replaces the stored payload. Rejects when the file was never understood,
     * so a failed read can never turn into data loss.
     */
    async write(value: T): Promise<void> {
        await this.ready();
        if (!this.writable) {
            throw new Error(`${this.file} was not readable, refusing to overwrite it`);
        }

        this.value = value;
        this.writing = this.writing.then(() => this.persist(value), () => this.persist(value));
        await this.writing;
    }

    private async persist(value: T): Promise<void> {
        const envelope: Envelope = { __store: 1, updatedAt: Date.now(), data: value };

        // The mirror is taken from the value about to be written rather than the
        // previous one: after this point both files hold a payload that parsed,
        // which is what makes an interrupted later write recoverable.
        await this.storage.saveData(this.file, envelope);
        if (!this.backedUp) {
            await this.storage.saveData(this.backupFile, envelope).then(
                () => { this.backedUp = true; },
                (error) => console.warn(`[publish-pages] ${this.backupFile} could not be written`, error),
            );
        }
    }
}

/** Unwraps whatever `loadData` returned and hands the payload to `parse`. */
function classify<T>(
    raw: unknown,
    parse: (payload: unknown) => T | null,
): { status: "loaded"; value: T } | { status: "empty" | "unreadable" } {
    if (raw === undefined || raw === null) {
        return { status: "empty" };
    }

    let payload: unknown = raw;

    if (typeof payload === "string") {
        const text = payload.trim();
        if (text === "") {
            return { status: "empty" };
        }
        // `loadData` hands back the raw text when its own `JSON.parse` failed,
        // which a truncated write produces. Retrying tells the two apart.
        try {
            payload = JSON.parse(text);
        } catch {
            return { status: "unreadable" };
        }
    }

    if (isKernelError(payload)) {
        // 404 is "the file is not there", anything else is a read that failed.
        return (payload as any).code === 404 ? { status: "empty" } : { status: "unreadable" };
    }

    if (isEnvelope(payload)) {
        payload = payload.data;
        if (payload === undefined || payload === null) {
            return { status: "empty" };
        }
    }

    const value = parse(payload);
    return value === null ? { status: "unreadable" } : { status: "loaded", value };
}

/** A plain JSON object, i.e. not an array and not a kernel error response. */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
