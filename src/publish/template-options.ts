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

    constructor(storage: OptionStorage, name = "publish-template") {
        this.storage = storage;
        this.file = name.endsWith(".json") ? name : `${name}.json`;
    }

    async load(): Promise<void> {
        const data = await this.storage.loadData(this.file).catch(() => null);
        this.options = normalize(data);
    }

    get(): TemplateOptions {
        return { ...this.options };
    }

    async save(options: TemplateOptions): Promise<void> {
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
