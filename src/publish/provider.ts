/**
 * Provider abstraction: the site builder produces `SiteFile[]`, a provider
 * uploads them and returns a URL. Adding a target means adding a module here,
 * nothing in the content pipeline changes.
 */

import { SiteFile } from "./site";
import * as cloudflare from "./cloudflare-pages";
import * as vercel from "./vercel";

export type ProviderId = "cloudflare" | "vercel";

/**
 * Path → provider specific asset reference of everything a deployment serves.
 * Both platforms take a complete manifest on every deploy, so carrying the
 * previous one forward is what keeps already published pages alive when a
 * single document is republished.
 */
export type SiteManifest = Record<string, unknown>;

export interface DeployResult {
    id: string;
    url: string;
    /** The manifest this deployment was created with, to be reused by the next one. */
    manifest: SiteManifest;
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
    /**
     * Uploads `files` and deploys them together with everything in `base`.
     * Entries in `base` whose path is also produced by `files` are replaced.
     */
    deploy(files: SiteFile[], base: SiteManifest, onProgress: Progress): Promise<DeployResult>;
    /** Removes an earlier deployment; one that is already gone counts as removed. */
    deleteDeployment(deploymentId: string): Promise<void>;
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
            deploy: (files, base, onProgress) => vercel.deploy(files, base, config, onProgress),
            deleteDeployment: (deploymentId) => vercel.deleteDeployment(config, deploymentId),
        };
    }

    return {
        validate: () => cloudflare.validateConfig(config),

        findProject: async () => {
            const project = await cloudflare.findProject(config);
            return project && `${project.name} (${project.subdomain})`;
        },
        createProject: async () => (await cloudflare.createProject(config)).name,
        deploy: (files, base, onProgress) => cloudflare.deploy(files, base, config, onProgress),
        deleteDeployment: (deploymentId) => cloudflare.deleteDeployment(config, deploymentId),
    };
}

