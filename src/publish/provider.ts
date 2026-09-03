/**
 * Provider abstraction: the site builder produces `SiteFile[]`, a provider
 * uploads them and returns a URL. Adding a target means adding a module here,
 * nothing in the content pipeline changes.
 */

import { SiteFile } from "./site";
import * as cloudflare from "./cloudflare-pages";
import * as vercel from "./vercel";

export type ProviderId = "cloudflare" | "vercel";

export interface DeployResult {
    id: string;
    url: string;
}

export type Progress = (message: string) => void;

export type ProviderConfig =
    | ({ provider: "cloudflare" } & cloudflare.CloudflarePagesConfig)
    | ({ provider: "vercel" } & vercel.VercelConfig);

export interface PublishTarget {
    /** Returns an error message when the configuration is unusable, otherwise null. */
    validate(): string | null;
    /** Human readable description of the remote project, or null when it does not exist yet. */
    findProject(): Promise<string | null>;
    createProject(): Promise<string>;
    deploy(files: SiteFile[], onProgress: Progress): Promise<DeployResult>;
}

export function createTarget(config: ProviderConfig): PublishTarget {
    if (config.provider === "vercel") {
        return {
            validate: () => vercel.validateConfig(config),

            findProject: async () => {
                const project = await vercel.findProject(config);
                return project && `${project.name} (${project.id})`;
            },
            createProject: async () => (await vercel.createProject(config)).name,
            deploy: (files, onProgress) => vercel.deploy(files, config, onProgress),
        };
    }

    return {
        validate: () => cloudflare.validateConfig(config),

        findProject: async () => {
            const project = await cloudflare.findProject(config);
            return project && `${project.name} (${project.subdomain})`;
        },
        createProject: async () => (await cloudflare.createProject(config)).name,
        deploy: (files, onProgress) => cloudflare.deploy(files, config, onProgress),
    };
}
