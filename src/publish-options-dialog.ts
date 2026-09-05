/**
 * The template dialog shown by "publish current document": everything that
 * shapes the uploaded page is decided here, right before the publish, instead
 * of being buried in the plugin settings. The confirmed values are what the
 * caller persists as the defaults of the next publish.
 */

import { Dialog } from "siyuan";

import { TemplateOptions } from "./publish/template-options";

export interface PublishOptionsText {
    title: string;
    addTitle: string;
    contentWidth: string;
    contentWidthDesc: string;
    includeRefs: string;
    includeRefsDesc: string;
    toc: string;
    tocDesc: string;
    tocIncludeRefs: string;
    tocIncludeRefsDesc: string;
    passwordEnabled: string;
    passwordDesc: string;
    passwordPlaceholder: string;
    passwordEmpty: string;
    publish: string;
}

/** Resolves with the chosen options, or null when the dialog is dismissed. */
export function openPublishOptionsDialog(
    text: PublishOptionsText,
    initial: TemplateOptions
): Promise<TemplateOptions | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: TemplateOptions | null): void => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };

        const dialog = new Dialog({
            title: text.title,
            content: `<div class="b3-dialog__content sp-options"></div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${window.siyuan.languages.cancel}</button><div class="fn__space"></div>
    <button class="b3-button b3-button--text">${escapeHtml(text.publish)}</button>
</div>`,
            width: "540px",
            destroyCallback: () => finish(null),
        });

        const holder = dialog.element.querySelector<HTMLElement>(".sp-options");
        if (!holder) {
            dialog.destroy();
            return;
        }

        const addTitle = switchRow(text.addTitle, "", initial.addTitle);
        const includeRefs = switchRow(text.includeRefs, text.includeRefsDesc, initial.includeRefs);
        const toc = switchRow(text.toc, text.tocDesc, initial.toc);
        const tocIncludeRefs = switchRow(
            text.tocIncludeRefs,
            text.tocIncludeRefsDesc,
            initial.tocIncludeRefs
        );
        const contentWidth = textRow(
            text.contentWidth,
            text.contentWidthDesc,
            initial.contentWidth
        );
        const passwordEnabled = switchRow(
            text.passwordEnabled,
            text.passwordDesc,
            initial.passwordEnabled
        );
        const password = textRow(text.passwordPlaceholder, "", "");
        password.input.type = "password";
        const syncPassword = (): void => {
            password.row.style.display = passwordEnabled.input.checked ? "" : "none";
        };
        passwordEnabled.input.addEventListener("change", syncPassword);
        syncPassword();

        // Listing the referenced documents only makes sense once there is both
        // a table of contents and referenced documents in the page.
        const syncTocRefs = (): void => {
            const available = toc.input.checked && includeRefs.input.checked;
            tocIncludeRefs.input.disabled = !available;
            tocIncludeRefs.row.classList.toggle("sp-options__row--off", !available);
        };
        toc.input.addEventListener("change", syncTocRefs);
        includeRefs.input.addEventListener("change", syncTocRefs);
        syncTocRefs();

        holder.append(
            addTitle.row,
            contentWidth.row,
            includeRefs.row,
            toc.row,
            tocIncludeRefs.row,
            passwordEnabled.row,
            password.row
        );

        const buttons = dialog.element.querySelectorAll(".b3-dialog__action .b3-button");
        buttons[0].addEventListener("click", () => {
            finish(null);
            dialog.destroy();
        });
        buttons[1].addEventListener("click", async () => {
            const plainPassword = password.input.value;
            if (passwordEnabled.input.checked && !plainPassword) {
                password.input.placeholder = text.passwordEmpty;
                password.input.focus();
                return;
            }
            const passwordHash = passwordEnabled.input.checked ? await sha256(plainPassword) : "";
            finish({
                addTitle: addTitle.input.checked,
                contentWidth: contentWidth.input.value.trim(),
                toc: toc.input.checked,
                tocIncludeRefs:
                    toc.input.checked && includeRefs.input.checked && tocIncludeRefs.input.checked,
                includeRefs: includeRefs.input.checked,
                passwordEnabled: passwordEnabled.input.checked,
                passwordHash,
            });
            dialog.destroy();
        });
    });
}

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Row<T extends HTMLElement> {
    row: HTMLElement;
    input: T;
}

function switchRow(label: string, description: string, checked: boolean): Row<HTMLInputElement> {
    const input = document.createElement("input");
    input.className = "b3-switch fn__flex-center";
    input.type = "checkbox";
    input.checked = checked;
    return { row: buildRow(label, description, input), input };
}

function textRow(label: string, description: string, value: string): Row<HTMLInputElement> {
    const input = document.createElement("input");
    input.className = "b3-text-field fn__flex-center fn__size200";
    input.type = "text";
    input.value = value;
    return { row: buildRow(label, description, input), input };
}

function buildRow(label: string, description: string, input: HTMLElement): HTMLElement {
    const row = document.createElement("label");
    row.className = "fn__flex b3-label sp-options__row";

    const texts = document.createElement("div");
    texts.className = "fn__flex-1";
    const name = document.createElement("div");
    name.textContent = label;
    texts.appendChild(name);
    if (description) {
        const hint = document.createElement("div");
        hint.className = "b3-label__text";
        hint.textContent = description;
        texts.appendChild(hint);
    }

    const space = document.createElement("span");
    space.className = "fn__space";

    row.append(texts, space, input);
    return row;
}

const escapeHtml = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
