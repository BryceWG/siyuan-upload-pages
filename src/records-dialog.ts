/**
 * The "published pages" management dialog, reachable from the plugin settings
 * and the top bar menu. One row per publish record with its channel, document
 * name, timestamps and actions (copy link / copy id / delete) — the doc id and
 * URL live on the buttons' tooltips instead of their own columns, keeping the
 * table narrow.
 *
 * Everything user-controlled (document names) is rendered through
 * `textContent`, never `innerHTML`.
 */

import { Dialog } from "siyuan";

import { PublishRecord } from "./publish/records";

export interface RecordsDialogText {
    title: string;
    empty: string;
    colDoc: string;
    colProvider: string;
    colPublishedAt: string;
    colUpdatedAt: string;
    colActions: string;
    actionCopyLink: string;
    actionCopyId: string;
    actionDelete: string;
}

export interface RecordsDialogCallbacks {
    records: () => PublishRecord[];
    onCopyLink: (record: PublishRecord) => void;
    onCopyId: (record: PublishRecord) => void;
    /** Removes the publish; resolving true tells the dialog to drop the row. */
    onDelete: (record: PublishRecord) => Promise<boolean>;
}

const PROVIDER_LABELS: Record<string, string> = {
    cloudflare: "Cloudflare Pages",
    vercel: "Vercel",
};

export function openRecordsDialog(
    text: RecordsDialogText,
    callbacks: RecordsDialogCallbacks
): void {
    const dialog = new Dialog({
        title: text.title,
        content: `<div class="b3-dialog__content sp-records-content"></div>`,
        width: "800px",
        height: "540px",
    });

    const holder = dialog.element.querySelector<HTMLElement>(".sp-records-content");
    if (!holder) {
        dialog.destroy();
        return;
    }

    const render = (): void => {
        holder.replaceChildren(buildBody(callbacks.records(), text, callbacks, render));
    };
    render();
}

function buildBody(
    records: PublishRecord[],
    text: RecordsDialogText,
    callbacks: RecordsDialogCallbacks,
    render: () => void
): HTMLElement {
    if (records.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sp-records__empty";
        empty.textContent = text.empty;
        return empty;
    }

    const table = document.createElement("table");
    table.className = "sp-records__table";

    const headRow = document.createElement("tr");
    for (const label of [
        text.colDoc,
        text.colProvider,
        text.colPublishedAt,
        text.colUpdatedAt,
        text.colActions,
    ]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
    }

    const thead = document.createElement("thead");
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const record of records) {
        tbody.appendChild(buildRow(record, text, callbacks, render));
    }
    table.append(thead, tbody);
    return table;
}

function buildRow(
    record: PublishRecord,
    text: RecordsDialogText,
    callbacks: RecordsDialogCallbacks,
    render: () => void
): HTMLTableRowElement {
    const row = document.createElement("tr");

    const name = cell(record.docName);
    name.className = "sp-records__name";

    const provider = cell(PROVIDER_LABELS[record.provider] ?? record.provider);
    const publishedAt = cell(formatTime(record.publishedAt));
    publishedAt.title = new Date(record.publishedAt).toString();
    const updatedAt = cell(formatTime(record.updatedAt));
    updatedAt.title = new Date(record.updatedAt).toString();

    const actions = document.createElement("td");
    actions.className = "sp-records__actions";

    const copyLinkButton = document.createElement("button");
    copyLinkButton.className = "b3-button b3-button--cancel";
    copyLinkButton.textContent = text.actionCopyLink;
    copyLinkButton.title = record.url;
    copyLinkButton.addEventListener("click", () => callbacks.onCopyLink(record));

    const copyIdButton = document.createElement("button");
    copyIdButton.className = "b3-button b3-button--cancel";
    copyIdButton.textContent = text.actionCopyId;
    copyIdButton.title = record.docId;
    copyIdButton.addEventListener("click", () => callbacks.onCopyId(record));

    const deleteButton = document.createElement("button");
    deleteButton.className = "b3-button b3-button--error";
    deleteButton.textContent = text.actionDelete;
    deleteButton.addEventListener("click", async () => {
        if (await callbacks.onDelete(record)) {
            render();
        }
    });

    actions.append(copyLinkButton, copyIdButton, deleteButton);
    row.append(name, provider, publishedAt, updatedAt, actions);
    return row;
}

const cell = (value: string): HTMLTableCellElement => {
    const td = document.createElement("td");
    td.textContent = value;
    return td;
};

const formatTime = (ms: number): string => {
    const date = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
};
