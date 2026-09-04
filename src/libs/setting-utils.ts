/*
 * Copyright (c) 2023 by frostime. All Rights Reserved.
 * @Author       : frostime
 * @Date         : 2023-12-17 18:28:19
 * @FilePath     : /src/libs/setting-utils.ts
 * @LastEditTime : 2024-05-01 17:44:16
 * @Description  : 
 */

import { Plugin, Setting } from 'siyuan';
import { JsonStore, LoadStatus, isPlainRecord } from '../publish/storage';



/**
 * The default function to get the value of the element
 * @param type 
 * @returns 
 */
const createDefaultGetter = (type: TSettingItemType) => {
    let getter: (ele: HTMLElement) => any;
    switch (type) {
        case 'checkbox':
            getter = (ele: HTMLInputElement) => {
                return ele.checked;
            };
            break;
        case 'select':
        case 'slider':
        case 'textinput':
        case 'textarea':
            getter = (ele: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
                return ele.value;
            };
            break;
        case 'number':
            getter = (ele: HTMLInputElement) => {
                return parseInt(ele.value);
            }
            break;
        default:
            getter = () => null;
            break;
    }
    return getter;
}


/**
 * The default function to set the value of the element
 * @param type 
 * @returns 
 */
const createDefaultSetter = (type: TSettingItemType) => {
    let setter: (ele: HTMLElement, value: any) => void;
    switch (type) {
        case 'checkbox':
            setter = (ele: HTMLInputElement, value: any) => {
                ele.checked = value;
            };
            break;
        case 'select':
        case 'slider':
        case 'textinput':
        case 'textarea':
        case 'number':
            setter = (ele: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: any) => {
                ele.value = value;
            };
            break;
        default:
            setter = () => {};
            break;
    }
    return setter;

}


export class SettingUtils {
    plugin: Plugin;
    name: string;
    file: string;

    settings: Map<string, ISettingUtilsItem> = new Map();
    elements: Map<string, HTMLElement> = new Map();

    /**
     * The config file, read once before anything is written to it. A save is
     * refused while the stored values are unknown, so a failed read can never
     * replace the saved credentials with the item defaults.
     */
    private store: JsonStore<Record<string, unknown>>;

    constructor(args: {
        plugin: Plugin,
        name?: string,
        callback?: (data: any) => void,
        onSaveError?: (error: unknown) => void,
        width?: string,
        height?: string
    }) {
        this.name = args.name ?? 'settings';
        this.plugin = args.plugin;
        this.file = this.name.endsWith('.json') ? this.name : `${this.name}.json`;
        this.store = new JsonStore({
            storage: this.plugin,
            name: this.file,
            parse: (payload) => (isPlainRecord(payload) ? payload : null),
            fallback: () => ({}),
        });
        this.plugin.setting = new Setting({
            width: args.width,
            height: args.height,
            confirmCallback: () => {
                for (let key of this.settings.keys()) {
                    this.updateValueFromElement(key);
                }
                let data = this.dump();
                if (args.callback !== undefined) {
                    args.callback(data);
                }
                this.plugin.data[this.name] = data;
                this.save(data).catch((error) => {
                    console.error('[publish-pages] failed to save settings', error);
                    args.onSaveError?.(error);
                });
            },
            destroyCallback: () => {
                //Restore the original value
                for (let key of this.settings.keys()) {
                    this.updateElementFromValue(key);
                }
            }
        });
    }

    /**
     * Reads the stored values into the setting items. Returns the load status:
     * `unreadable` means the file exists but could not be understood, and every
     * later save will be refused.
     */
    async load(): Promise<LoadStatus> {
        const status = await this.store.ready();
        if (status === 'loaded') {
            const data = this.store.get();
            for (let [key, item] of this.settings) {
                item.value = data[key] ?? item.value;
            }
        }
        this.plugin.data[this.name] = this.dump();
        return status;
    }

    get loadStatus(): LoadStatus {
        return this.store.loadStatus;
    }

    async save(data?: any) {
        const payload = (data ?? this.dump()) as Record<string, unknown>;
        await this.store.write(payload);
        return payload;
    }


    /**
     * read the data after saving
     * @param key key name
     * @returns setting item value
     */
    get(key: string) {
        return this.settings.get(key)?.value;
    }

    /**
     * Set data to this.settings, 
     * but do not save it to the configuration file
     * @param key key name
     * @param value value
     */
    set(key: string, value: any) {
        let item = this.settings.get(key);
        if (item) {
            item.value = value;
            this.updateElementFromValue(key);
        }
    }

    /**
     * Set and save setting item value
     * If you want to set and save immediately you can use this method
     * @param key key name
     * @param value value
     */
    async setAndSave(key: string, value: any) {
        let item = this.settings.get(key);
        if (item) {
            item.value = value;
            this.updateElementFromValue(key);
            await this.save();
        }
    }

    /**
      * Read in the value of element instead of setting obj in real time
      * @param key key name
      * @param apply whether to apply the value to the setting object
      *        if true, the value will be applied to the setting object
      * @returns value in html
      */
    take(key: string, apply: boolean = false) {
        let item = this.settings.get(key);
        let element = this.elements.get(key) as any;
        if (!element) {
            return
        }
        if (apply) {
            this.updateValueFromElement(key);
        }
        return item.getEleVal(element);
    }

    /**
     * Read data from html and save it
     * @param key key name
     * @param value value
     * @return value in html
     */
    async takeAndSave(key: string) {
        let value = this.take(key, true);
        await this.save();
        return value;
    }

    /**
     * Disable setting item
     * @param key key name
     */
    disable(key: string) {
        let element = this.elements.get(key) as any;
        if (element) {
            element.disabled = true;
        }
    }

    /**
     * Enable setting item
     * @param key key name
     */
    enable(key: string) {
        let element = this.elements.get(key) as any;
        if (element) {
            element.disabled = false;
        }
    }

    /**
     * 将设置项目导出为 JSON 对象
     * @returns object
     */
    dump(): Object {
        let data: any = {};
        for (let [key, item] of this.settings) {
            if (item.type === 'button') continue;
            data[key] = item.value;
        }
        return data;
    }

    addItem(item: ISettingUtilsItem) {
        this.settings.set(item.key, item);
        const IsCustom = item.type === 'custom';
        let error = IsCustom && (item.createElement === undefined || item.getEleVal === undefined || item.setEleVal === undefined);
        if (error) {
            console.error('The custom setting item must have createElement, getEleVal and setEleVal methods');
            return;
        }

        // A masked input is a wrapper around the real `<input>`, so the value is
        // read from the child instead of the registered element.
        if (item.type === 'textinput' && item.password) {
            item.getEleVal ??= (ele: HTMLElement) => secretInput(ele).value;
            item.setEleVal ??= (ele: HTMLElement, value: any) => { secretInput(ele).value = value ?? ''; };
        }

        if (item.getEleVal === undefined) {

            item.getEleVal = createDefaultGetter(item.type);
        }
        if (item.setEleVal === undefined) {
            item.setEleVal = createDefaultSetter(item.type);
        }

        if (item.createElement === undefined) {
            let itemElement = this.createDefaultElement(item);
            this.elements.set(item.key, itemElement);
            this.plugin.setting.addItem({
                title: item.title,
                description: item?.description,
                direction: item?.direction,
                createActionElement: () => {
                    this.updateElementFromValue(item.key);
                    let element = this.getElement(item.key);
                    return element;
                }
            });
        } else {
            this.plugin.setting.addItem({
                title: item.title,
                description: item?.description,
                direction: item?.direction,
                createActionElement: () => {
                    let val = this.get(item.key);
                    let element = item.createElement(val);
                    this.elements.set(item.key, element);
                    return element;
                }
            });
        }
    }

    createDefaultElement(item: ISettingUtilsItem) {
        let itemElement: HTMLElement;
        //阻止思源内置的回车键确认
        const preventEnterConfirm = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }
        switch (item.type) {
            case 'checkbox':
                let element: HTMLInputElement = document.createElement('input');
                element.type = 'checkbox';
                element.checked = item.value;
                element.className = "b3-switch fn__flex-center";
                itemElement = element;
                element.onchange = item.action?.callback ?? (() => { });
                break;
            case 'select':
                let selectElement: HTMLSelectElement = document.createElement('select');
                selectElement.className = "b3-select fn__flex-center fn__size200";
                let options = item?.options ?? {};
                for (let val in options) {
                    let optionElement = document.createElement('option');
                    let text = options[val];
                    optionElement.value = val;
                    optionElement.text = text;
                    selectElement.appendChild(optionElement);
                }
                selectElement.value = item.value;
                selectElement.onchange = item.action?.callback ?? (() => { });
                itemElement = selectElement;
                break;
            case 'slider':
                let sliderElement: HTMLInputElement = document.createElement('input');
                sliderElement.type = 'range';
                sliderElement.className = 'b3-slider fn__size200 b3-tooltips b3-tooltips__n';
                sliderElement.ariaLabel = item.value;
                sliderElement.min = item.slider?.min.toString() ?? '0';
                sliderElement.max = item.slider?.max.toString() ?? '100';
                sliderElement.step = item.slider?.step.toString() ?? '1';
                sliderElement.value = item.value;
                sliderElement.onchange = () => {
                    sliderElement.ariaLabel = sliderElement.value;
                    item.action?.callback();
                }
                itemElement = sliderElement;
                break;
            case 'textinput':
                if (item.password) {
                    itemElement = createSecretField(item);
                    break;
                }
                let textInputElement: HTMLInputElement = document.createElement('input');
                textInputElement.className = 'b3-text-field fn__flex-center fn__size200';
                textInputElement.value = item.value;
                if (item.placeholder) textInputElement.placeholder = item.placeholder;
                textInputElement.onchange = item.action?.callback ?? (() => { });
                itemElement = textInputElement;
                textInputElement.addEventListener('keydown', preventEnterConfirm);
                break;

            case 'textarea':
                let textareaElement: HTMLTextAreaElement = document.createElement('textarea');
                textareaElement.className = "b3-text-field fn__block";
                textareaElement.value = item.value;
                textareaElement.onchange = item.action?.callback ?? (() => { });
                itemElement = textareaElement;
                break;
            case 'number':
                let numberElement: HTMLInputElement = document.createElement('input');
                numberElement.type = 'number';
                numberElement.className = 'b3-text-field fn__flex-center fn__size200';
                numberElement.value = item.value;
                itemElement = numberElement;
                numberElement.addEventListener('keydown', preventEnterConfirm);
                break;
            case 'button':
                let buttonElement: HTMLButtonElement = document.createElement('button');
                buttonElement.className = "b3-button b3-button--outline fn__flex-center fn__size200";
                buttonElement.innerText = item.button?.label ?? 'Button';
                buttonElement.onclick = item.button?.callback ?? (() => { });
                itemElement = buttonElement;
                break;
            case 'hint':
                let hintElement: HTMLElement = document.createElement('div');
                hintElement.className = 'b3-label fn__flex-center';
                itemElement = hintElement;
                break;
        }
        return itemElement;
    }

    /**
     * return the setting element
     * @param key key name
     * @returns element
     */
    getElement(key: string) {
        // let item = this.settings.get(key);
        let element = this.elements.get(key) as any;
        return element;
    }

    private updateValueFromElement(key: string) {
        let item = this.settings.get(key);
        if (item.type === 'button') return;
        let element = this.elements.get(key) as any;
        item.value = item.getEleVal(element);
    }

    private updateElementFromValue(key: string) {
        let item = this.settings.get(key);
        if (item.type === 'button') return;
        let element = this.elements.get(key) as any;
        item.setEleVal(element, item.value);
    }
}

/** The `<input>` inside a masked field wrapper. */
const secretInput = (wrapper: HTMLElement): HTMLInputElement =>
    wrapper.querySelector('input') as HTMLInputElement;

/**
 * A masked text field: the value is hidden by default and revealed on demand,
 * so a credential is not readable over the shoulder or in a screen recording.
 * Autofill and spellcheck are off — a browser password manager must not treat
 * an API token as a login, and the token must not reach a spellcheck service.
 */
function createSecretField(item: ISettingUtilsItem): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'fn__flex fn__flex-center';

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'b3-text-field fn__flex-1';
    input.value = item.value ?? '';
    input.autocomplete = 'off';
    input.spellcheck = item.spellcheck ?? false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('data-1p-ignore', '');
    if (item.placeholder) input.placeholder = item.placeholder;
    input.onchange = item.action?.callback ?? (() => { });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'b3-button b3-button--outline fn__flex-center';
    toggle.style.marginLeft = '4px';
    const render = () => {
        const hidden = input.type === 'password';
        const icon = hidden ? 'iconEyeoff' : 'iconEye';
        // Fall back to a glyph if the theme does not ship the symbol.
        if (document.getElementById(icon)) {
            toggle.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
        } else {
            toggle.textContent = hidden ? '👁' : '🙈';
        }
        toggle.ariaLabel = hidden ? 'Show' : 'Hide';
    };

    toggle.onclick = () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        render();
    };
    render();

    // Revealing is per visit: reopening the dialog starts masked again.
    wrapper.append(input, toggle);
    return wrapper;
}
