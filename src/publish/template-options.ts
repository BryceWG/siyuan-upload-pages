/**
 * The template choices of a publish: they shape the page that gets uploaded,
 * so they are asked for every time "publish current document" runs. The last
 * used values are kept in the plugin's data folder and become the defaults of
 * the next dialog.
 */

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
export interface OptionStorage {
    loadData(storageName: string): Promise<any>;
    saveData(storageName: string, content: any): Promise<any>;
}

export class TemplateOptionStore {
    private storage: OptionStorage;
    private file: string;
    private options: TemplateOptions = { ...DEFAULT_TEMPLATE_OPTIONS };
    private reading?: Promise<void>;


    constructor(storage: OptionStorage, name = "publish-template") {
        this.storage = storage;
        this.file = name.endsWith(".json") ? name : `${name}.json`;
    }

    /**
     * Reads the file once, and rejects when it cannot be read — saving before
     * that would persist the defaults over the stored choices. `loadData`
     * rejects on a plugin instance whose lifecycle has ended, which is what
     * every dev live reload produces.
     */
    ready(): Promise<void> {
        if (!this.reading) {
            this.reading = this.read().catch((error) => {
                this.reading = undefined;
                throw error;
            });
        }
        return this.reading;
    }

    private async read(): Promise<void> {
        this.options = normalize(await this.storage.loadData(this.file));
    }


    get(): TemplateOptions {
        return { ...this.options };
    }

    async save(options: TemplateOptions): Promise<void> {
        await this.ready();
        this.options = normalize(options);
        await this.storage.saveData(this.file, this.options);
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
