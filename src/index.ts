import { Plugin, Menu, showMessage, getFrontend, getAllEditor } from "siyuan";
import "./index.scss";

import { SettingUtils } from "./libs/setting-utils";
import { buildSinglePageSite } from "./publish/site-builder";
import { ProviderConfig, ProviderId, PublishTarget, createTarget } from "./publish/provider";

import { formatSize, totalSize } from "./publish/site";

const STORAGE_NAME = "publish-config";

const CLOUDFLARE_KEYS = ["accountId", "projectName", "apiToken", "branch"];
const VERCEL_KEYS = ["vercelToken", "vercelProject", "vercelTeamId", "vercelTarget"];

export default class PublishPlugin extends Plugin {


    private settingUtils: SettingUtils;
    private publishing = false;
    private isMobile: boolean;

    onload() {
        const frontEnd = getFrontend();
        this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";

        this.addIcons(`<symbol id="iconPublishPages" viewBox="0 0 32 32">
<path d="M16 3 26 12h-6v9h-8v-9H6L16 3zM5 24h22v5H5v-5z"></path>
</symbol>`);

        this.addCommand({
            langKey: "publishCurrentDoc",
            hotkey: "",
            callback: () => {
                this.publishCurrentDoc();
            },
        });

        this.initSettings();
    }

    onLayoutReady() {
        this.settingUtils.load().catch((error) => {
            console.error("[publish-pages] failed to load settings", error);
        });

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
        this.settingUtils = new SettingUtils({ plugin: this, name: STORAGE_NAME });

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
            key: "addTitle",
            value: true,
            type: "checkbox",
            title: this.i18n.settingAddTitle,
            description: "",
        });

        this.settingUtils.addItem({
            key: "contentWidth",
            value: "800px",
            type: "textinput",
            title: this.i18n.settingContentWidth,
            description: this.i18n.settingContentWidthDesc,
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

    openSetting(): void {
        super.openSetting();
        this.applyProviderVisibility();
    }

    private providerConfig(): ProviderConfig {
        const provider = this.selectedProvider();

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

        const target = createTarget(this.providerConfig());
        const invalid = target.validate();
        if (invalid) {
            showMessage(invalid, 6000, "error");
            this.openSetting();
            return;
        }

        this.publishing = true;
        try {
            await this.ensureProject(target);

            showMessage(this.i18n.buildingSite, 4000);

            const site = await buildSinglePageSite(docId, {
                addTitle: this.settingUtils.get("addTitle") !== false,
                contentWidth: String(this.settingUtils.get("contentWidth") || "800px"),
            });

            if (site.warnings.length > 0) {
                console.warn("[publish-pages] build warnings", site.warnings);
                showMessage(`${this.i18n.buildWarnings}: ${site.warnings.length}`, 6000);
            }

            showMessage(
                `${this.i18n.uploading}: ${site.files.length} / ${formatSize(totalSize(site.files))}`,
                4000,
            );

            const result = await target.deploy(site.files, (message) => showMessage(message, 3000));

            navigator.clipboard?.writeText(result.url).catch(() => { });
            showMessage(`${this.i18n.publishOk}: ${result.url}`, 0);
        } catch (error) {
            showMessage(`${this.i18n.publishFailed}: ${errorMessage(error)}`, 0, "error");
        } finally {
            this.publishing = false;
        }
    }

    uninstall() {
        this.removeData(STORAGE_NAME);
    }
}

/** The token must never reach a message box or the console. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

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
