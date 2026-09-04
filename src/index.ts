import { Plugin, Menu, showMessage, getFrontend, getAllEditor } from "siyuan";
import "./index.scss";

import { confirmDialog } from "./libs/dialog";
import { SettingUtils } from "./libs/setting-utils";
import { openRecordsDialog } from "./records-dialog";
import { openPublishOptionsDialog } from "./publish-options-dialog";
import { buildSinglePageSite } from "./publish/site-builder";
import { ProviderConfig, ProviderId, PublishTarget, SiteManifest, createTarget } from "./publish/provider";
import { PublishRecord, RecordStore } from "./publish/records";
import { TemplateOptionStore } from "./publish/template-options";
import { LoadStatus } from "./publish/storage";


import { formatSize, randomSlug, totalSize } from "./publish/site";

const STORAGE_NAME = "publish-config";
const RECORDS_NAME = "publish-records";
const TEMPLATE_NAME = "publish-template";

const CLOUDFLARE_KEYS = ["accountId", "projectName", "apiToken", "branch"];
const VERCEL_KEYS = ["vercelToken", "vercelProject", "vercelTeamId", "vercelTarget"];

export default class PublishPlugin extends Plugin {
    private settingUtils: SettingUtils;
    private records = new RecordStore(this, RECORDS_NAME);
    private templateOptions = new TemplateOptionStore(this, TEMPLATE_NAME);
    /** Resolves to the load status of the settings file; see `dataReady`. */
    private settingsReady: Promise<LoadStatus>;
    private publishing = false;


    private isMobile: boolean;


    onload() {
        const frontEnd = getFrontend();
        this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";

        this.addIcons(`<symbol id="iconPublishPages" viewBox="0 0 32 32">
<g style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">
<path d="M16 3 6 12l10 12 10-12Z"></path>
<path d="M6 12h20M16 3v21"></path>
<path d="M16 24c-1 2.4-3.8 2-5.2 4.8"></path>
</g>
<path style="fill:currentColor" d="M10.8 28.8 8 29.2l.8-2.6Z"></path>
</symbol>`);

        this.addCommand({
            langKey: "publishCurrentDoc",
            hotkey: "",
            callback: () => {
                this.publishCurrentDoc();
            },
        });

        this.initSettings();

        // Started here, awaited at every entry point. `loadData` reports a
        // failed read by resolving with something unusable rather than by
        // rejecting, so the status of each file is what decides whether writing
        // is allowed — a write before or after a failed read would persist an
        // empty state over data that is still on disk.
        this.settingsReady = this.settingUtils.load();
        this.settingsReady.then((status) => this.reportLoad(STORAGE_NAME, status));
        this.records.ready().then((status) => this.reportLoad(RECORDS_NAME, status));
        this.templateOptions.ready().then((status) => this.reportLoad(TEMPLATE_NAME, status));
    }

    /** A file that could not be read is worth surfacing, not just logging. */
    private reportLoad(name: string, status: LoadStatus) {
        if (status === "unreadable") {
            console.error(`[publish-pages] ${name}.json could not be read; it will not be overwritten`);
            showMessage(`${this.i18n.dataNotLoaded}: ${name}.json`, 0, "error");
        }
    }


    onLayoutReady() {
        this.addTopBar({

            icon: "iconPublishPages",
            title: this.i18n.publishCurrentDoc,
            position: "right",
            callback: (event) => {
                const menu = new Menu("publishPagesMenu");
                menu.addItem({
                    icon: "iconPublishPages",
                    label: this.i18n.publishCurrentDoc,
                    click: () => this.publishCurrentDoc(),
                });
                menu.addItem({
                    icon: "iconLink",
                    label: this.i18n.manageRecords,
                    click: () => this.showRecordsDialog(),
                });
                menu.addItem({
                    icon: "iconSettings",
                    label: this.i18n.openSettings,
                    click: () => this.openSetting(),
                });

                if (this.isMobile) {
                    menu.fullscreen();
                    return;
                }
                const rect = (event.target as HTMLElement).getBoundingClientRect();
                menu.open({ x: rect.right, y: rect.bottom, isLeft: true });
            },
        });
    }

    // ------------------------------------------------------------- settings

    private initSettings() {
        this.settingUtils = new SettingUtils({
            plugin: this,
            name: STORAGE_NAME,
            onSaveError: () => showMessage(`${this.i18n.settingsSaveFailed}: ${STORAGE_NAME}.json`, 0, "error"),
        });


        this.settingUtils.addItem({
            key: "provider",
            value: "cloudflare",
            type: "select",
            title: this.i18n.settingProvider,
            description: "",
            options: {
                cloudflare: "Cloudflare Pages",
                vercel: "Vercel",
            },
            action: {
                callback: () => this.applyProviderVisibility(),
            },
        });


        this.settingUtils.addItem({
            key: "accountId",
            value: "",
            type: "textinput",
            title: this.i18n.settingAccountId,
            description: this.i18n.settingAccountIdDesc,
        });
        this.settingUtils.addItem({
            key: "projectName",
            value: "",
            type: "textinput",
            title: this.i18n.settingProjectName,
            description: this.i18n.settingProjectNameDesc,
        });
        this.settingUtils.addItem({
            key: "apiToken",
            value: "",
            type: "textinput",
            password: true,
            title: this.i18n.settingApiToken,
            description: this.i18n.settingApiTokenDesc,
        });

        this.settingUtils.addItem({
            key: "branch",
            value: "main",
            type: "textinput",
            title: this.i18n.settingBranch,
            description: this.i18n.settingBranchDesc,
        });

        this.settingUtils.addItem({
            key: "vercelToken",
            value: "",
            type: "textinput",
            password: true,
            title: this.i18n.settingVercelToken,
            description: this.i18n.settingVercelTokenDesc,
        });

        this.settingUtils.addItem({
            key: "vercelProject",
            value: "",
            type: "textinput",
            title: this.i18n.settingVercelProject,
            description: this.i18n.settingVercelProjectDesc,
        });
        this.settingUtils.addItem({
            key: "vercelTeamId",
            value: "",
            type: "textinput",
            title: this.i18n.settingVercelTeamId,
            description: this.i18n.settingVercelTeamIdDesc,
        });
        this.settingUtils.addItem({
            key: "vercelTarget",
            value: "production",
            type: "select",
            title: this.i18n.settingVercelTarget,
            description: "",
            options: {
                production: "production",
                preview: "preview",
            },
        });

        this.settingUtils.addItem({
            key: "testConnection",

            value: "",
            type: "button",
            title: this.i18n.settingEnsureProject,
            description: this.i18n.settingEnsureProjectDesc,
            button: {
                label: this.i18n.settingEnsureProjectLabel,
                callback: () => this.checkOrCreateProject(),
            },
        });

        this.settingUtils.addItem({
            key: "manageRecords",
            value: "",
            type: "button",
            title: this.i18n.settingManageRecords,
            description: this.i18n.settingManageRecordsDesc,
            button: {
                label: this.i18n.settingManageRecordsLabel,
                callback: () => this.showRecordsDialog(),
            },
        });

    }

    /**
     * `SettingUtils.load()` only restores the in-memory values, it does not push
     * them into the inputs. So the saved value is the source of truth, and the
     * live input is only preferred while the settings dialog is actually open —
     * that is what makes "test connection" work on unsaved edits.
     */
    private read(key: string): string {
        const element = this.settingUtils.getElement(key);
        const value = element?.isConnected
            ? this.settingUtils.take(key)
            : this.settingUtils.get(key);
        return String(value ?? "").trim();
    }

    private selectedProvider(): ProviderId {
        return (this.read("provider") || "cloudflare") as ProviderId;
    }

    /** Only the settings of the selected platform are shown. */
    private applyProviderVisibility() {
        const provider = this.selectedProvider();
        const setVisible = (keys: string[], visible: boolean) => {
            for (const key of keys) {
                this.settingUtils
                    .getElement(key)
                    ?.closest(".config-item")
                    ?.classList.toggle("fn__none", !visible);
            }
        };

        setVisible(CLOUDFLARE_KEYS, provider === "cloudflare");
        setVisible(VERCEL_KEYS, provider === "vercel");
    }

    /**
     * The settings dialog writes every item back on confirm, so it must not
     * open while the stored values are unknown — that would replace the saved
     * credentials with the defaults.
     */
    openSetting(): void {
        this.settingsReady.then((status) => {
            if (status === "unreadable") {
                showMessage(`${this.i18n.dataNotLoaded}: ${STORAGE_NAME}.json`, 0, "error");
                return;
            }
            super.openSetting();
            this.applyProviderVisibility();
        });
    }

    /** Awaits every stored file; false means "do not write anything". */
    private async dataReady(): Promise<boolean> {
        const statuses = await Promise.all([
            this.settingsReady,
            this.records.ready(),
            this.templateOptions.ready(),
        ]);

        const broken = [STORAGE_NAME, RECORDS_NAME, TEMPLATE_NAME]
            .filter((_, index) => statuses[index] === "unreadable");

        if (broken.length > 0) {
            showMessage(`${this.i18n.dataNotLoaded}: ${broken.map((name) => `${name}.json`).join(", ")}`, 0, "error");
            return false;
        }
        return true;
    }



    /**
     * Reads the settings of `provider`, defaulting to the selected one — a
     * record can be managed even when its channel is not currently selected.
     */
    private providerConfig(provider: ProviderId = this.selectedProvider()): ProviderConfig {

        if (provider === "vercel") {

            return {
                provider: "vercel",
                token: this.read("vercelToken"),
                project: this.read("vercelProject"),
                teamId: this.read("vercelTeamId"),
                target: this.read("vercelTarget") === "preview" ? "preview" : "production",
            };
        }

        return {
            provider: "cloudflare",
            apiToken: this.read("apiToken"),
            accountId: this.read("accountId"),
            projectName: this.read("projectName"),
            branch: this.read("branch"),
        };
    }

    /** Resolves the remote project, creating it when it does not exist yet. */
    private async ensureProject(target: PublishTarget): Promise<void> {
        const existing = await target.findProject();
        if (existing) {
            showMessage(`${this.i18n.projectReady}: ${existing}`, 5000);
            return;
        }

        const created = await target.createProject();
        showMessage(`${this.i18n.projectCreated}: ${created}`, 5000);
    }

    private async checkOrCreateProject() {
        if (!await this.dataReady()) {
            return;
        }

        const target = createTarget(this.providerConfig());

        const invalid = target.validate();
        if (invalid) {
            showMessage(invalid, 6000, "error");
            return;
        }

        try {
            await this.ensureProject(target);
        } catch (error) {
            showMessage(`${this.i18n.connectionFailed}: ${errorMessage(error)}`, 0, "error");
        }
    }


    // -------------------------------------------------------------- publish

    private async publishCurrentDoc() {
        if (this.publishing) {
            showMessage(this.i18n.alreadyPublishing, 4000);
            return;
        }

        const docId = activeDocumentId();
        if (!docId) {
            showMessage(this.i18n.noActiveDoc, 6000, "error");
            return;
        }

        if (!await this.dataReady()) {
            return;
        }

        const provider = this.selectedProvider();

        const target = createTarget(this.providerConfig());
        const invalid = target.validate();
        if (invalid) {
            showMessage(invalid, 6000, "error");
            this.openSetting();
            return;
        }

        this.publishing = true;
        try {
            const options = await this.askTemplateOptions();
            if (!options) {
                return;
            }
            await this.templateOptions.save(options);

            showMessage(this.i18n.buildingSite, 4000);

            const site = await buildSinglePageSite(docId, {
                ...options,
                slug: this.slugFor(provider, docId),
                tocLabel: this.i18n.tocLabel,
                iconDir: `/plugins/${this.name}/asset`,
            });

            if (site.warnings.length > 0) {
                console.warn("[publish-pages] build warnings", site.warnings);
                showMessage(`${this.i18n.buildWarnings}: ${site.warnings.length}`, 6000);
            }

            // An equal fingerprint means the existing deployment already
            // serves exactly this page.
            const record = this.records.find(provider, docId);
            if (record && record.fingerprint === site.fingerprint) {
                copyToClipboard(record.url);
                showMessage(`${this.i18n.recordUnchanged}: ${record.url}`, 0);
                return;
            }

            await this.ensureProject(target);

            showMessage(
                `${this.i18n.uploading}: ${site.files.length} / ${formatSize(totalSize(site.files))}`,
                4000,
            );

            // Everything the previous deployment served is carried over, so
            // publishing one document never drops the other pages.
            const result = await target.deploy(
                site.files,
                this.records.manifest(provider),
                (message) => showMessage(message, 3000),
            );
            await this.records.setManifest(provider, result.manifest);

            const url = `${result.url.replace(/\/+$/, "")}/${site.slug}/`;
            const { created } = await this.records.upsert({
                docId,
                docName: site.title,
                provider,
                slug: site.slug,
                deploymentId: result.id,
                url,
                fingerprint: site.fingerprint,
            });

            copyToClipboard(url);
            const message = created ? this.i18n.publishOk : this.i18n.publishUpdatedOk;
            showMessage(`${message}: ${url}`, 0);
        } catch (error) {
            showMessage(`${this.i18n.publishFailed}: ${errorMessage(error)}`, 0, "error");
        } finally {
            this.publishing = false;
        }
    }

    /** The template dialog every publish goes through; null means "cancelled". */
    private askTemplateOptions() {
        return openPublishOptionsDialog(
            {
                title: this.i18n.optionsTitle,
                addTitle: this.i18n.optionAddTitle,
                contentWidth: this.i18n.optionContentWidth,
                contentWidthDesc: this.i18n.optionContentWidthDesc,
                includeRefs: this.i18n.optionIncludeRefs,
                includeRefsDesc: this.i18n.optionIncludeRefsDesc,
                toc: this.i18n.optionToc,
                tocDesc: this.i18n.optionTocDesc,
                tocIncludeRefs: this.i18n.optionTocIncludeRefs,
                tocIncludeRefsDesc: this.i18n.optionTocIncludeRefsDesc,
                publish: this.i18n.optionsPublish,
            },
            this.templateOptions.get(),
        );
    }

    /**
     * A document keeps the slug it was first published under, so its link stays
     * valid even when the title changes later.
     */

    private slugFor(provider: ProviderId, docId: string): string {
        const existing = this.records.find(provider, docId);
        if (existing?.slug) {
            return existing.slug;
        }

        const taken = new Set(this.records.forProvider(provider).map((record) => record.slug));
        let slug = randomSlug();
        while (taken.has(slug)) {
            slug = randomSlug();
        }
        return slug;
    }

    // --------------------------------------------------------------- records

    private async showRecordsDialog(): Promise<void> {
        if (!await this.dataReady()) {
            return;
        }

        openRecordsDialog(

            {
                title: this.i18n.recordsTitle,
                empty: this.i18n.recordsEmpty,
                colDoc: this.i18n.recordsColDoc,
                colProvider: this.i18n.recordsColProvider,
                colPublishedAt: this.i18n.recordsColPublishedAt,
                colUpdatedAt: this.i18n.recordsColUpdatedAt,
                colActions: this.i18n.recordsColActions,
                actionCopyLink: this.i18n.recordsActionCopyLink,
                actionCopyId: this.i18n.recordsActionCopyId,
                actionDelete: this.i18n.recordsActionDelete,
            },
            {
                records: () => this.records.all(),
                onCopyLink: (record) => {
                    copyToClipboard(record.url);
                    showMessage(this.i18n.recordsCopyOk, 3000);
                },
                onCopyId: (record) => {
                    copyToClipboard(record.docId);
                    showMessage(this.i18n.recordsCopyIdOk, 3000);
                },
                onDelete: (record) => this.deletePublish(record),
            },
        );
    }

    /** Deletes the remote deployment, then the local record. */
    private async deletePublish(record: PublishRecord): Promise<boolean> {
        const target = createTarget(this.providerConfig(record.provider));
        const invalid = target.validate();
        if (invalid) {
            // Without the channel credentials the deployment cannot be removed
            // remotely; dropping just the record keeps the row manageable.
            if (!await this.confirmDelete(this.i18n.recordsDeleteLocalOnly, record)) {
                return false;
            }
        } else {
            if (!await this.confirmDelete(this.i18n.recordsDeleteQuestion, record)) {
                return false;
            }

            try {
                await this.removeFromSite(target, record);
            } catch (error) {
                showMessage(`${this.i18n.recordsDeleteFailed}: ${errorMessage(error)}`, 0, "error");
                return false;
            }
        }

        await this.records.remove(record.provider, record.docId);
        showMessage(this.i18n.recordsDeleteOk, 3000);
        return true;
    }

    /**
     * Drops the page from the site by redeploying the previous manifest without
     * its paths. The deployment itself is shared by every published page, so it
     * must not be deleted — that would take the whole site back one version.
     */
    private async removeFromSite(target: PublishTarget, record: PublishRecord): Promise<void> {
        const prefix = `/${record.slug}/`;
        const kept: SiteManifest = {};
        for (const [path, ref] of Object.entries(this.records.manifest(record.provider))) {
            if (!path.startsWith(prefix)) {
                kept[path] = ref;
            }
        }

        const result = await target.deploy([], kept, (message) => showMessage(message, 3000));
        await this.records.setManifest(record.provider, result.manifest);
    }


    /** confirmDialog with a DOM body, so record fields never pass through innerHTML. */
    private confirmDelete(question: string, record: PublishRecord): Promise<boolean> {
        return new Promise((resolve) => {
            const content = document.createElement("div");
            const ask = document.createElement("div");
            ask.textContent = question;
            const subject = document.createElement("div");
            subject.className = "sp-confirm__subject ft__smaller ft__on-surface";
            subject.textContent = `${record.docName} · ${record.url}`;
            content.append(ask, subject);

            confirmDialog({
                title: this.i18n.recordsDeleteTitle,
                content,
                confirm: () => resolve(true),
                cancel: () => resolve(false),
            });
        });
    }

    async uninstall() {
        // The mirrors go with the files they back up, otherwise a reinstall
        // would recover the state the user just asked to be removed.
        const files = [
            this.settingUtils.file,
            this.records.storageName,
            this.records.backupName,
            this.templateOptions.storageName,
            this.templateOptions.backupName,
            `${STORAGE_NAME}.bak.json`,
        ];
        await Promise.all(files.map((file) => this.removeData(file).catch((error) => {
            console.warn(`[publish-pages] ${file} could not be removed`, error);
        })));
    }


}

/** The token must never reach a message box or the console. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const copyToClipboard = (text: string): void => {
    navigator.clipboard?.writeText(text).catch(() => { });
};

function activeDocumentId(): string | null {
    const selectors = [
        ".layout__wnd--active .protyle:not(.fn__none) .protyle-title",
        ".protyle:not(.fn__none) .protyle-title",
    ];
    for (const selector of selectors) {
        const id = document.querySelector<HTMLElement>(selector)?.dataset.nodeId;
        if (id) {
            return id;
        }
    }
    return getAllEditor()[0]?.protyle?.block?.rootID ?? null;
}
