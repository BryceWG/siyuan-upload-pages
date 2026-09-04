/**
 * The template choices of a publish: they shape the page that gets uploaded,
 * so they are asked for every time "publish current document" runs. The last
 * used values are kept in the plugin's data folder and become the defaults of
 * the next dialog.
 */

import { DataStorage, JsonStore, LoadStatus, isPlainRecord } from "./storage";

export interface TemplateOptions {
    /** Prepend the document title as an `<h1>`. */
    addTitle: boolean;
    /** Max content width of the article, e.g. `800px`. */
    contentWidth: string;
    /** Render a static table of contents next to the article. */
    toc: boolean;
    /** Also list the included referenced documents in the table of contents. */
    tocIncludeRefs: boolean;
    /** Append the documents referenced by the body as sections of the page. */
    includeRefs: boolean;
}

export const DEFAULT_TEMPLATE_OPTIONS: TemplateOptions = {
    addTitle: true,
    contentWidth: "800px",
    toc: false,
    tocIncludeRefs: false,
    includeRefs: false,
};

/** Only the two data methods the store needs, so it does not depend on the Plugin type. */
export type OptionStorage = DataStorage;

export class TemplateOptionStore {
    private store: JsonStore<TemplateOptions>;

    constructor(storage: OptionStorage, name = "publish-template") {
        this.store = new JsonStore({
            storage,
            name,
            parse: (payload) => (isPlainRecord(payload) ? normalize(payload) : null),
            fallback: () => ({ ...DEFAULT_TEMPLATE_OPTIONS }),
        });
    }

    /**
     * Reads the file once. Saving before that, or after a read that failed,
     * would persist the defaults over the stored choices.
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

    get(): TemplateOptions {
        return { ...this.store.get() };
    }

    async save(options: TemplateOptions): Promise<void> {
        await this.ready();
        await this.store.write(normalize(options));
    }
}



/** The file is user-editable and may predate an option, so every field is checked. */
function normalize(value: any): TemplateOptions {
    const source = typeof value === "object" && value !== null ? value : {};
    const flag = (name: keyof TemplateOptions): boolean =>
        typeof source[name] === "boolean" ? source[name] : (DEFAULT_TEMPLATE_OPTIONS[name] as boolean);

    const width = String(source.contentWidth ?? "").trim();
    return {
        addTitle: flag("addTitle"),
        contentWidth: width || DEFAULT_TEMPLATE_OPTIONS.contentWidth,
        toc: flag("toc"),
        tocIncludeRefs: flag("tocIncludeRefs"),
        includeRefs: flag("includeRefs"),
    };
}
