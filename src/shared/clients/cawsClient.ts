/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as AWS from 'aws-sdk'
import { ServiceConfigurationOptions } from 'aws-sdk/lib/service'
import * as caws from '../../../types/clientcodeaws'
import * as logger from '../logger/logger'
import { SettingsConfiguration } from '../settingsConfiguration'
import apiConfig = require('../../../types/REMOVED.json')
import globals from '../extensionGlobals'
import { Timeout, waitTimeout, waitUntil } from '../utilities/timeoutUtils'
import { MDE_START_TIMEOUT } from './mdeClient'
import * as nls from 'vscode-nls'
import { showMessageWithCancel } from '../utilities/messages'
import { ClassToInterfaceType } from '../utilities/tsUtils'
import { AsyncCollection, toCollection } from '../utilities/asyncCollection'
import { pageableToCollection } from '../utilities/collectionUtils'

const localize = nls.loadMessageBundle()

export const cawsRegion = 'us-east-1' // Try "us-west-2" for beta/integ/gamma.
export const cawsEndpoint = 'https://public.api-gamma.REMOVED.codes' // gamma web: https://integ.stage.REMOVED.codes/
export const cawsEndpointGql = 'https://public.api-gamma.REMOVED.codes/graphql'
export const cawsHostname = 'integ.stage.REMOVED.codes' // 'REMOVED.execute-api.us-east-1.amazonaws.cominteg.codedemo.REMOVED'
// export const cawsGitHostname = `git.service.${cawsHostname}` // prod endpoint
export const cawsGitHostname = 'git.gamma.source.caws.REMOVED' // gamma
export const cawsHelpUrl = `https://${cawsHostname}/help`

/** CAWS-MDE developer environment. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CawsDevEnv extends caws.DevelopmentWorkspaceSummary {
    readonly type: 'env'
    readonly id: string // Alias of developmentWorkspaceId.
    readonly name: string
    readonly description?: string
    readonly org: Pick<CawsOrg, 'name'>
    readonly project: Pick<CawsProject, 'name'>
}
/** CAWS-MDE developer environment session. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CawsDevEnvSession extends caws.StartSessionDevelopmentWorkspaceOutput {}

export interface CawsOrg extends caws.OrganizationSummary {
    readonly type: 'org'
    readonly id: string // TODO: why doesn't OrganizationSummary have this already?
    readonly name: string
}
export interface CawsProject extends caws.ProjectSummary {
    readonly type: 'project'
    readonly org: Pick<CawsOrg, 'name'>
    readonly id: string // TODO: why doesn't ProjectSummary have this already?
    readonly name: string
}
export interface CawsRepo extends caws.SourceRepositorySummary {
    readonly type: 'repo'
    readonly org: Pick<CawsOrg, 'name'>
    readonly project: Pick<CawsProject, 'name'>
    readonly name: string
}

export type CawsResource = CawsOrg | CawsProject | CawsRepo | CawsDevEnv

async function createCawsClient(
    authCookie: string | undefined,
    apiKey: string,
    regionCode: string = cawsRegion,
    endpoint: string = cawsEndpoint
): Promise<caws> {
    const c = (await globals.sdkClientBuilder.createAwsService(AWS.Service, {
        // apiConfig is internal and not in the TS declaration file
        apiConfig: apiConfig,
        region: regionCode,
        // XXX: remove when Bearer token auth is added
        // The SDK has logic to automatically throw if no credentials are set
        // despite the service not requiring credentials.
        credentials: { accessKeyId: 'xxx', secretAccessKey: 'xxx' },
        correctClockSkew: true,
        endpoint: endpoint,
    } as ServiceConfigurationOptions)) as caws
    c.setupRequestListeners = r => {
        r.httpRequest.headers['x-api-key'] = apiKey
        // r.httpRequest.headers['cookie'] = authCookie
        if (authCookie) {
            // TODO: remove this after CAWS backend implements full authentication story.
            r.httpRequest.headers['cookie'] = authCookie
        }
    }
    // c.setupRequestListeners()
    return c
}

// CAWS client has two variants: 'logged-in' and 'not logged-in'
// The 'not logged-in' variant is a subtype and has restricted functionality
// These characteristics appear in the Smithy model, but the SDK codegen is unable to model this

export interface DisconnectedCawsClient extends Pick<CawsClientInternal, 'verifySession' | 'setCredentials'> {
    readonly connected: false
}

export interface ConnectedCawsClient extends ClassToInterfaceType<CawsClientInternal> {
    readonly connected: true
}

export type CawsClient = ConnectedCawsClient | DisconnectedCawsClient
export type CawsClientFactory = () => Promise<CawsClient>

/**
 * Factory to create a new `CawsClient`. Call `onCredentialsChanged()` before making requests.
 */
export async function createClient(
    settings: SettingsConfiguration,
    regionCode: string = cawsRegion,
    endpoint: string = cawsEndpoint,
    authCookie?: string
): Promise<CawsClient> {
    const sdkClient = await createCawsClient(authCookie, 'xxx', regionCode, endpoint)
    const c = new CawsClientInternal(settings, regionCode, endpoint, sdkClient, authCookie)
    return c
}

class CawsClientInternal {
    private userId: string | undefined
    private username: string | undefined
    private readonly log: logger.Logger
    private apiKey: string

    public constructor(
        private settings: SettingsConfiguration,
        private readonly regionCode: string,
        private readonly endpoint: string,
        private sdkClient: caws,
        private authCookie?: string
    ) {
        this.log = logger.getLogger()
        this.apiKey = this.settings.readDevSetting('aws.dev.caws.apiKey', 'string', true) ?? ''
    }

    public get connected(): boolean {
        return !!(this.authCookie && this.userId)
    }

    /**
     * Rebuilds/reconnects CAWS clients with new credentials
     *
     * @param authCookie   User secret
     * @param userId       CAWS account id
     * @returns
     */
    public async setCredentials(authCookie: string, userId?: string) {
        this.authCookie = authCookie
        this.userId = userId
        this.sdkClient = await createCawsClient(authCookie, this.apiKey, this.regionCode, this.endpoint)
    }

    private async call<T>(req: AWS.Request<T, AWS.AWSError>, silent: true, defaultVal: T): Promise<T>
    private async call<T>(req: AWS.Request<T, AWS.AWSError>, silent: false): Promise<T>
    private async call<T>(req: AWS.Request<T, AWS.AWSError>, silent: boolean, defaultVal?: T): Promise<T> {
        const log = this.log
        return new Promise<T>((resolve, reject) => {
            req.send(function (e, data) {
                const r = req as any
                if (e) {
                    const allHeaders = r?.response?.httpResponse?.headers
                    const logHeaders = {}
                    // Selected headers which are useful for logging.
                    const logHeaderNames = [
                        // 'access-control-expose-headers',
                        // 'cache-control',
                        // 'strict-transport-security',
                        'x-amz-apigw-id',
                        'x-amz-cf-id',
                        'x-amz-cf-pop',
                        'x-amzn-remapped-content-length',
                        'x-amzn-remapped-x-amzn-requestid',
                        'x-amzn-requestid',
                        'x-amzn-served-from',
                        'x-amzn-trace-id',
                        'x-cache',
                        'x-request-id', // <- Request id for caws/fusi!
                    ]
                    if (allHeaders && Object.keys(allHeaders).length > 0) {
                        for (const k of logHeaderNames) {
                            ;(logHeaders as any)[k] = (k in allHeaders ? allHeaders : logHeaderNames)[k]
                        }
                    }

                    // Stack is noisy and useless in production.
                    const errNoStack = { ...e }
                    delete errNoStack.stack
                    // Remove confusing "requestId" field (= "x-amzn-requestid" header)
                    // because for caws/fusi, "x-request-id" is more relevant.
                    // All of the various request-ids can be found in the logged headers.
                    delete errNoStack.requestId

                    if (r.operation || r.params) {
                        log.error(
                            'API request failed: %s\nparams: %O\nerror: %O\nheaders: %O',
                            r.operation,
                            r.params,
                            errNoStack,
                            logHeaders
                        )
                    } else {
                        log.error('API request failed:%O\nheaders: %O', req, logHeaders)
                    }
                    if (silent) {
                        if (defaultVal === undefined) {
                            throw Error()
                        }
                        resolve(defaultVal)
                    } else {
                        reject(e)
                    }
                    return
                }
                log.verbose('API request (%s):\nparams: %O\nresponse: %O', r.operation ?? '?', r.params ?? '?', data)
                resolve(data)
            })
        })
    }

    /**
     * Creates a PAT.
     *
     * @param args.name Name of the token
     * @param args.expires PAT expires on this date, or undefined.
     * @returns PAT secret
     */
    public async createAccessToken(
        args: caws.CreateAccessTokenRequest
    ): Promise<caws.CreateAccessTokenResponse | undefined> {
        const c = this.sdkClient
        const token = await this.call(c.createAccessToken(args), false)
        return token
    }

    /**
     * Gets identity properties of the current authenticated principal, and
     * stores the id for use in later calls.
     */
    public async verifySession(): Promise<caws.VerifySessionResponse & { name: string; identity: string }> {
        const o = await this.call(this.sdkClient.verifySession(), false)
        if (!o.identity) {
            throw new Error('No CAWS account id found')
        }
        this.userId = o.identity

        const name = (await this.getPerson({ id: this.userId })).userName

        return { ...o, identity: this.userId, name }
    }

    public async getPerson(args: caws.GetPersonRequest): Promise<caws.GetPersonResponse & { userName: string }> {
        const resp = await this.call(this.sdkClient.getPerson(args), false)

        if (!resp.userName) {
            throw new Error('No CAWS username found')
        }
        this.username = resp.userName

        return { ...resp, userName: this.username }
    }

    /**
     * Gets a list of all orgs for the current CAWS user.
     */
    public listOrgs(): AsyncCollection<CawsOrg[]> {
        function asCawsOrg(org: caws.OrganizationSummary & { id?: string }): CawsOrg {
            return { id: '', type: 'org', name: org.name ?? 'unknown', ...org }
        }

        const requester = async (request: caws.ListOrganizationsInput) =>
            this.call(this.sdkClient.listOrganizations(request), true, { items: [] })
        const collection = pageableToCollection(requester, {}, 'nextToken', 'items')
        return collection.map(summaries => summaries?.map(asCawsOrg) ?? [])
    }

    /**
     * Gets a list of all projects for the given CAWS user.
     */
    public listProjects(request: caws.ListProjectsInput): AsyncCollection<CawsProject[]> {
        const requester = async (request: caws.ListProjectsInput) =>
            this.call(this.sdkClient.listProjects(request), true, { items: [] })
        const collection = pageableToCollection(requester, request, 'nextToken', 'items')

        return collection.map(
            summaries =>
                summaries?.map(s => ({
                    type: 'project',
                    id: '',
                    org: { name: request.organizationName },
                    name: s.name ?? 'unknown',
                    ...s,
                })) ?? []
        )
    }

    /**
     * CAWS-MDE
     * Gets a flat list of all workspaces for the given CAWS project.
     */
    public listDevEnvs(proj: CawsProject): AsyncCollection<CawsDevEnv[]> {
        const initRequest = { organizationName: proj.org.name, projectName: proj.name }
        const requester = async (request: caws.ListDevelopmentWorkspaceInput) =>
            this.call(this.sdkClient.listDevelopmentWorkspace(request), true, { items: [] })
        const collection = pageableToCollection(requester, initRequest, 'nextToken', 'items')

        const makeDescription = (env: caws.DevelopmentWorkspaceSummary) => {
            return env.repositories
                .map(r => {
                    const pr = r.pullRequestNumber ? `#${r.pullRequestNumber}` : ''
                    return `${r.repositoryName}:${r.branchName ?? ''} ${pr}`
                })
                .join(', ')
        }

        return collection.map(envs =>
            envs.map(env => ({
                type: 'env',
                id: env.developmentWorkspaceId,
                name: env.developmentWorkspaceId,
                org: proj.org,
                project: proj,
                description: makeDescription(env),
                ...env,
            }))
        )
    }

    /**
     * Gets a flat list of all repos for the given CAWS user.
     */
    public listRepos(request: caws.ListSourceRepositoriesInput): AsyncCollection<CawsRepo[]> {
        const requester = async (request: caws.ListSourceRepositoriesInput) =>
            this.call(this.sdkClient.listSourceRepositories(request), true, { items: [] })
        const collection = pageableToCollection(requester, request, 'nextToken', 'items')
        return collection.map(
            summaries =>
                summaries?.map(s => ({
                    type: 'repo',
                    id: '',
                    org: { name: request.organizationName },
                    project: { name: request.projectName },
                    name: s.name ?? 'unknown',
                    ...s,
                })) ?? []
        )
    }

    /**
     * Lists ALL of the given resource in the current account
     */
    public listResources(resourceType: 'org'): AsyncCollection<CawsOrg[]>
    public listResources(resourceType: 'project'): AsyncCollection<CawsProject[]>
    public listResources(resourceType: 'repo'): AsyncCollection<CawsRepo[]>
    public listResources(resourceType: 'env'): AsyncCollection<CawsDevEnv[]>
    public listResources(resourceType: CawsResource['type']): AsyncCollection<CawsResource[]> {
        // Don't really want to expose this apart of the `AsyncCollection` API yet
        // The semantics of concatenating async iterables is rather ambiguous
        // For example, an array of async iterables can be joined either in-order or out-of-order.
        // In-order concatenations only makes sense for finite iterables, though I'm unaware of any
        // convention to declare an iterable to be finite.
        function mapInner<T, U>(
            collection: AsyncCollection<T[]>,
            fn: (element: T) => AsyncCollection<U[]>
        ): AsyncCollection<U[]> {
            return toCollection(async function* () {
                for await (const element of await collection.promise()) {
                    yield* await Promise.all(element.map(e => fn(e).flatten().promise()))
                }
            })
        }

        switch (resourceType) {
            case 'org':
                return this.listOrgs()
            case 'project':
                return mapInner(this.listResources('org'), o => this.listProjects({ organizationName: o.name }))
            case 'repo':
                return mapInner(this.listResources('project'), p =>
                    this.listRepos({ projectName: p.name, organizationName: p.org.name })
                )
            case 'env':
                return mapInner(this.listResources('project'), p => this.listDevEnvs(p))
        }
    }

    /** CAWS-MDE */
    public async createDevEnv(args: caws.CreateDevelopmentWorkspaceInput): Promise<CawsDevEnv> {
        if (!args.ideRuntimes || args.ideRuntimes.length === 0) {
            throw Error('missing ideRuntimes')
        }
        const r = await this.call(this.sdkClient.createDevelopmentWorkspace(args), false)
        const env = await this.getDevEnv({
            developmentWorkspaceId: r.developmentWorkspaceId,
            organizationName: args.organizationName,
            projectName: args.projectName,
        })
        if (!env) {
            throw Error('created environment but failed to get it')
        }

        return {
            ...env,
            id: r.developmentWorkspaceId,
            creatorId: '',
            ide: args.ideRuntimes[0],
            lastUpdatedTime: new Date(),
            repositories: args.repositories,
            // status?: String // TODO: get status
        }
    }

    /** CAWS-MDE */
    public async startDevEnv(
        args: caws.StartDevelopmentWorkspaceInput
    ): Promise<caws.StartDevelopmentWorkspaceOutput | undefined> {
        const r = await this.call(this.sdkClient.startDevelopmentWorkspace(args), false)
        return r
    }

    /** CAWS-MDE */
    public async startDevEnvSession(
        args: caws.StartSessionDevelopmentWorkspaceInput
    ): Promise<caws.StartSessionDevelopmentWorkspaceOutput | undefined> {
        const r = await this.call(this.sdkClient.startSessionDevelopmentWorkspace(args), false)
        return r
    }

    /** CAWS-MDE: does not have this operation (yet?) */
    public async stopDevEnv(): Promise<void> {
        throw Error('CAWS-MDE does not have stopEnvironment currently')
    }

    /** CAWS-MDE */
    public async getDevEnv(args: caws.GetDevelopmentWorkspaceInput): Promise<CawsDevEnv | undefined> {
        const a = { ...args }
        delete (a as any).ideRuntimes
        delete (a as any).repositories
        const r = await this.call(this.sdkClient.getDevelopmentWorkspace(a), false)
        const desc = r.labels?.join(', ')

        return {
            type: 'env',
            id: a.developmentWorkspaceId,
            name: a.developmentWorkspaceId,
            developmentWorkspaceId: a.developmentWorkspaceId,
            description: desc,
            org: { name: args.organizationName },
            project: { name: args.projectName },
            ...r,
        }
    }

    /** CAWS-MDE */
    public async deleteDevEnv(
        args: caws.DeleteDevelopmentWorkspaceInput
    ): Promise<caws.DeleteDevelopmentWorkspaceOutput | undefined> {
        const r = await this.call(this.sdkClient.deleteDevelopmentWorkspace(args), false)
        return r
    }

    /**
     * Best-effort attempt to start an MDE given an ID, showing a progress notifcation with a cancel button
     * TODO: may combine this progress stuff into some larger construct
     *
     * The cancel button does not abort the start, but rather alerts any callers that any operations that rely
     * on the MDE starting should not progress.
     *
     * @returns the environment on success, undefined otherwise
     */
    public async startEnvironmentWithProgress(
        args: caws.StartDevelopmentWorkspaceInput,
        status: string,
        timeout: Timeout = new Timeout(MDE_START_TIMEOUT)
    ): Promise<CawsDevEnv | undefined> {
        let lastStatus: undefined | string
        try {
            const env = await this.getDevEnv(args)
            lastStatus = env?.status
            if (status === 'RUNNING' && lastStatus === 'RUNNING') {
                // "Debounce" in case caller did not check if the environment was already running.
                return env
            }
        } catch {
            lastStatus = undefined
        }

        const progress = await showMessageWithCancel(localize('AWS.caws.startMde.message', 'CODE.AWS'), timeout)
        progress.report({ message: localize('AWS.caws.startMde.checking', 'checking status...') })

        const pollMde = waitUntil(
            async () => {
                // technically this will continue to be called until it reaches its own timeout, need a better way to 'cancel' a `waitUntil`
                if (timeout.completed) {
                    return
                }

                const resp = await this.getDevEnv(args)
                if (lastStatus === 'STARTING' && (resp?.status === 'STOPPED' || resp?.status === 'STOPPING')) {
                    throw Error('Evironment failed to start')
                }

                if (resp?.status === 'STOPPED') {
                    progress.report({ message: localize('AWS.caws.startMde.stopStart', 'resuming environment...') })
                    await this.startDevEnv(args)
                } else if (resp?.status === 'STOPPING') {
                    progress.report({
                        message: localize('AWS.caws.startMde.resuming', 'waiting for environment to stop...'),
                    })
                } else {
                    progress.report({
                        message: localize('AWS.caws.startMde.starting', 'waiting for environment...'),
                    })
                }

                lastStatus = resp?.status
                return resp?.status === 'RUNNING' ? resp : undefined
            },
            // note: the `waitUntil` will resolve prior to the real timeout if it is refreshed
            { interval: 5000, timeout: timeout.remainingTime, truthy: true }
        )

        return waitTimeout(pollMde, timeout, {
            onExpire: () => (
                vscode.window.showErrorMessage(
                    localize(
                        'AWS.caws.startFailed',
                        'Timeout waiting for MDE environment: {0}',
                        args.developmentWorkspaceId
                    )
                ),
                undefined
            ),
            onCancel: () => undefined,
        })
    }

    public async getUsername(): Promise<string> {
        return (this.username ??= (await this.getPerson({ id: this.userId! })).userName)
    }

    /**
     * Creates a link for `git clone` usage
     * @param r CAWS repo
     */
    public async toCawsGitUri(org: string, project: string, repo: string): Promise<string> {
        const pat = await this.createAccessToken({ name: 'aws-toolkits-vscode-token', expires: undefined })
        if (!pat?.secret) {
            throw Error('CODE.AWS: Failed to create personal access token (PAT)')
        }

        const username = await this.getUsername()

        return `https://${username}:${pat.secret}@${cawsGitHostname}/v1/${org}/${project}/${repo}`
    }
}