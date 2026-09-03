import { Plugin, Menu, showMessage, getFrontend, getAllEditor } from "siyuan";
import "./index.scss";

import { SettingUtils } from "./libs/setting-utils";
import { buildSinglePageSite } from "./publish/site-builder";
import {
    CloudflarePagesConfig,
    deploy,
    getProject,
    validateConfig,
} from "./publish/cloudflare-pages";
import { formatSize, totalSize } from "./publish/site";

const STORAGE_NAME = "publish-config";

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
            key: "addTitle",
            value: true,
            type: "checkbox",
            title: this.i18n.settingAddTitle,
            description: this.i18n.settingAddTitleDesc,
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
            title: this.i18n.settingTestConnection,
            description: this.i18n.settingTestConnectionDesc,
            button: {
                label: this.i18n.settingTestConnectionLabel,
                callback: () => this.testConnection(),
            },
        });

    }

    /**
     * `SettingUtils.load()` only restores the in-memory values, it does not push
     * them into the inputs. So the saved value is the source of truth, and the
     * live input is only preferred while the settings dialog is actually open —
     * that is what makes "test connection" work on unsaved edits.
     */
    private readConfig(): CloudflarePagesConfig {
        const read = (key: string): string => {
            const element = this.settingUtils.getElement(key);
            const value = element?.isConnected
                ? this.settingUtils.take(key)
                : this.settingUtils.get(key);
            return String(value ?? "").trim();
        };

        return {
            apiToken: read("apiToken"),
            accountId: read("accountId"),
            projectName: read("projectName"),
            branch: read("branch"),
        };
    }


    private async testConnection() {
        const config = this.readConfig();
        const invalid = validateConfig(config);
        if (invalid) {
            showMessage(invalid, 6000, "error");
            return;
        }

        try {
            const project = await getProject(config);
            showMessage(
                `${this.i18n.connectionOk}: ${project.name} (${project.subdomain})`,
                7000,
            );
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

        const config = this.readConfig();
        const invalid = validateConfig(config);
        if (invalid) {
            showMessage(invalid, 6000, "error");
            this.openSetting();
            return;
        }

        this.publishing = true;
        try {
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

            const result = await deploy(site.files, config, (message) => showMessage(message, 3000));
            const url = result.url || `https://${config.branch}.${config.projectName}.pages.dev`;

            navigator.clipboard?.writeText(url).catch(() => { });
            showMessage(`${this.i18n.publishOk}: ${url}`, 0);
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
