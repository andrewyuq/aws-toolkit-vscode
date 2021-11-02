/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as awsArn from '@aws-sdk/util-arn-parser'
import * as mde from '../shared/clients/mdeClient'
import * as nls from 'vscode-nls'
import { ext } from '../shared/extensionGlobals'
import { getLogger } from '../shared/logger/logger'
import { ChildProcess } from '../shared/utilities/childProcess'
import { showConfirmationMessage, showMessageWithCancel, showViewLogsMessage } from '../shared/utilities/messages'
import { Commands } from '../shared/vscode/commands'
import { Window } from '../shared/vscode/window'
import { MdeRootNode } from './mdeRootNode'
import { isExtensionInstalledMsg } from '../shared/utilities/vsCodeUtils'
import { Timeout, waitTimeout, waitUntil } from '../shared/utilities/timeoutUtils'
import { ExtContext, VSCODE_EXTENSION_ID } from '../shared/extensions'
import { DeleteEnvironmentResponse, TagMap } from '../../types/clientmde'
import { SystemUtilities } from '../shared/systemUtilities'
import * as mdeModel from './mdeModel'
import { localizedDelete } from '../shared/localizedText'
import { MDE_RESTART_KEY } from './constants'
import { DefaultSettingsConfiguration } from '../shared/settingsConfiguration'
import { parse } from '@aws-sdk/util-arn-parser'

const localize = nls.loadMessageBundle()

export function getMdeSsmEnv(
    region: string,
    endpoint: string,
    ssmPath: string,
    session: mde.MdeSession
): NodeJS.ProcessEnv {
    return Object.assign(
        {
            AWS_REGION: region,
            AWS_SSM_CLI: ssmPath,
            AWS_MDE_ENDPOINT: endpoint,
            AWS_MDE_SESSION: session.id,
            AWS_MDE_STREAMURL: session.accessDetails.streamUrl,
            AWS_MDE_TOKEN: session.accessDetails.tokenValue,
        },
        process.env
    )
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
export async function startMde(
    env: Pick<mde.MdeEnvironment, 'id'>,
    mdeClient: mde.MdeClient,
    node?: MdeRootNode
): Promise<mde.MdeEnvironment | undefined> {
    // hard-coded timeout for now
    const TIMEOUT_LENGTH = 600000

    const timeout = new Timeout(TIMEOUT_LENGTH)
    const progress = await showMessageWithCancel(localize('AWS.mde.startMde.message', 'MDE'), timeout)
    progress.report({ message: localize('AWS.mde.startMde.checking', 'checking status...') })

    if (node) {
        node.startPolling()
    }

    const pollMde = waitUntil(
        async () => {
            // technically this will continue to be called until it reaches its own timeout, need a better way to 'cancel' a `waitUntil`
            if (timeout.completed) {
                return
            }

            const resp = await mdeClient.getEnvironmentMetadata({ environmentId: env.id })

            if (resp?.status === 'STOPPED') {
                progress.report({ message: localize('AWS.mde.startMde.stopStart', 'resuming environment...') })
                await mdeClient.startEnvironment({ environmentId: env.id })
            } else {
                progress.report({
                    message: localize('AWS.mde.startMde.starting', 'waiting for environment...'),
                })
            }

            return resp?.status === 'RUNNING' ? resp : undefined
        },
        { interval: 1500, timeout: TIMEOUT_LENGTH, truthy: true }
    )

    return waitTimeout(pollMde, timeout, {
        onExpire: () => (
            Window.vscode().showErrorMessage(
                localize('AWS.mde.startFailed', 'Timeout waiting for MDE environment: {0}', env.id)
            ),
            undefined
        ),
        onCancel: () => undefined,
    })
}

export async function mdeConnectCommand(
    args: Pick<mde.MdeEnvironment, 'id'>,
    region: string,
    window = Window.vscode()
): Promise<void> {
    if (!isExtensionInstalledMsg('ms-vscode-remote.remote-ssh', 'Remote SSH', 'Connecting to MDE')) {
        return
    }

    function showMissingToolMsg(s: string) {
        const m = localize(
            'AWS.mde.missingRequiredTool',
            'Failed to connect to MDE environment, missing required tool: {0}',
            s
        )
        showViewLogsMessage(m, window)
    }

    const vsc = await SystemUtilities.getVscodeCliPath()
    if (!vsc) {
        showMissingToolMsg('code')
        return
    }

    const hasSshConfig = await mdeModel.ensureMdeSshConfig()
    if (!hasSshConfig.ok) {
        showMissingToolMsg('ssh')
        return
    }

    const mdeClient = await mde.MdeClient.create(region, mde.mdeEndpoint())
    const session = await mdeClient.startSession(args)
    if (!session) {
        return
    }

    const ssmPath = await mdeModel.ensureSsmCli()
    if (!ssmPath.ok) {
        return
    }

    // BIG HACK, VERY FRAGILE
    // XXX: if the environment has a non-default devfile, use `/project` until an environment variable is available
    const envMetadata = await mdeClient.getEnvironmentMetadata({ environmentId: args.id })
    const projectDir =
        envMetadata?.actions?.devfile?.location === '/aws/mde/.mde.devfile.yaml' ? '/projects' : '/project'

    const cmd = new ChildProcess(
        true,
        vsc,
        {
            env: getMdeSsmEnv(region, mde.mdeEndpoint(), ssmPath.result, session),
        },
        '--folder-uri',
        `vscode-remote://ssh-remote+aws-mde-${args.id}${projectDir}`
    )

    const settings = new DefaultSettingsConfiguration()
    settings.ensureToolkitInVscodeRemoteSsh()

    // Note: `await` is intentionally not used.
    cmd.run(
        (stdout: string) => {
            getLogger().verbose(`MDE connect: ${args.id}: ${stdout}`)
        },
        (stderr: string) => {
            getLogger().verbose(`MDE connect: ${args.id}: ${stderr}`)
        }
    ).then(o => {
        if (o.exitCode !== 0) {
            getLogger().error('MDE connect: failed to start: %O', cmd)
        }
    })
}

export async function mdeDeleteCommand(
    env: Pick<mde.MdeEnvironment, 'id'>,
    node?: MdeRootNode,
    commands = Commands.vscode()
): Promise<DeleteEnvironmentResponse | undefined> {
    // TODO: add suppress option
    const prompt = localize('AWS.mde.delete.confirm.message', 'Are you sure you want to delete this environment?')
    const response = await showConfirmationMessage({ prompt, confirm: localizedDelete })

    if (response) {
        if (node) {
            node.startPolling()
        }
        const r = await ext.mde.deleteEnvironment({ environmentId: env.id })
        getLogger().info('%O', r?.status)
        if (node) {
            node.refresh()
        } else {
            await commands.execute('aws.refreshAwsExplorer', true)
        }
        return r
    }
}

export async function cloneToMde(
    mdeEnv: mde.MdeEnvironment,
    repo: { uri: vscode.Uri; branch?: string },
    projectDir: string = '/projects'
): Promise<void> {
    getLogger().debug(`MDE: cloning ${repo.uri} to ${mdeEnv.id}`)

    // For some reason git won't accept URIs with the 'ssh' scheme?
    const target = repo.uri.scheme === 'ssh' ? `${repo.uri.authority}${repo.uri.path}` : repo.uri.toString()
    // TODO: let user name the project (if they want)
    const repoName = repo.uri.path.split('/').pop()?.split('.')[0]

    const gitArgs = (repo.branch ? ['-b', repo.branch] : []).concat(`${projectDir}/'${repoName}'`)
    const commands = [
        'mkdir -p ~/.ssh',
        `mkdir -p ${projectDir}`, // Try to create the directory, though we might not have permissions
        'touch ~/.ssh/known_hosts',
        'ssh-keyscan github.com >> ~/.ssh/known_hosts',
        `git clone '${target}' ${gitArgs.join(' ')}`,
    ]

    const process = await createMdeSshCommand(mdeEnv, commands, { useAgent: repo.uri.scheme === 'ssh' })
    // TODO: handle different ports with the URI

    const result = await process.run(
        (stdout: string) => {
            getLogger().verbose(`MDE clone: ${mdeEnv.id}: ${stdout}`)
        },
        (stderr: string) => {
            getLogger().verbose(`MDE clone: ${mdeEnv.id}: ${stderr}`)
        }
    )

    if (result.exitCode !== 0) {
        throw new Error('Failed to clone repository')
    }
}

interface MdeSshCommandOptions {
    /** Uses this session to inject environment variables, otherwise creates a new one. */
    session?: mde.MdeSession
    /** Whether or not to forward an SSH agent. This will attempt to start the agent if not already running. (default: false) */
    useAgent?: boolean
}

// TODO: use this for connect as well
/**
 * Creates a new base ChildProcess with configured SSH arguments.
 * The SSH agent socket will be added as an environment variable if applicable.
 */
export async function createMdeSshCommand(
    mdeEnv: Pick<mde.MdeEnvironment, 'id' | 'arn'>,
    commands: string[],
    options: MdeSshCommandOptions = {}
): Promise<ChildProcess> {
    const useAgent = options.useAgent ?? false
    const agentSock = useAgent ? await mdeModel.startSshAgent() : undefined
    const ssmPath = await mdeModel.ensureSsmCli()

    if (!ssmPath.ok) {
        throw new Error('Unable to create MDE SSH command: SSM Plugin not found')
    }

    const region = parse(mdeEnv.arn).region
    const mdeClient = await mde.MdeClient.create(region, mde.mdeEndpoint())
    const session = options.session ?? (await mdeClient.startSession(mdeEnv))

    if (!session) {
        throw new Error('Unable to create MDE SSH command: could not start remote session')
    }

    // TODO: check SSH version to verify 'accept-new' is available
    const mdeEnvVars = getMdeSsmEnv(region, mde.mdeEndpoint(), ssmPath.result, session)
    const env = { [mdeModel.SSH_AGENT_SOCKET_VARIABLE]: agentSock, ...mdeEnvVars }

    const sshPath = await SystemUtilities.findSshPath()
    if (!sshPath) {
        throw new Error('Unable to create MDE SSH command: could not find ssh executable')
    }

    const sshArgs = [
        `aws-mde-${mdeEnv.id}`,
        `${useAgent ? '-A' : ''}`,
        '-o',
        'StrictHostKeyChecking=accept-new',
        'AddKeysToAgent=yes',
        commands.join(' && '),
    ].filter(c => !!c)

    return new ChildProcess(true, sshPath, { env }, ...sshArgs)
}

export async function resumeEnvironments(ctx: ExtContext) {
    const memento = ctx.extensionContext.globalState
    const pendingRestarts = memento.get<Record<string, boolean>>(MDE_RESTART_KEY, {})

    // filter out stale environments
    // TODO: write some utility code for mementos
    const activeEnvironments: mde.MdeEnvironment[] = []
    const ids = new Set<string>()
    for await (const env of ext.mde.listEnvironments({})) {
        env && activeEnvironments.push(env) && ids.add(env.id)
    }
    Object.keys(pendingRestarts).forEach(k => {
        if (!ids.has(k) || !pendingRestarts[k]) {
            delete pendingRestarts[k]
        }
    })
    memento.update(MDE_RESTART_KEY, pendingRestarts)

    getLogger().debug('MDEs waiting to be resumed: %O', pendingRestarts)

    // TODO: if multiple MDEs are in a 'restart' state, prompt user
    const target = Object.keys(pendingRestarts).pop()
    const env = activeEnvironments.find(env => env.id === target)
    if (env) {
        const region = awsArn.parse(env.arn).region
        mdeConnectCommand(env, region).then(() => {
            // TODO: we can mark this environment as 'attemptedRestart'
            // should be left up to the target environment to remove itself from the
            // pending restart global state
        })
    }
}

// this could potentially install the toolkit without needing to mess with user settings
// but it's kind of awkward still since it needs to be ran after 'vscode-server' has been
// installed on the remote
export async function installToolkit(mde: Pick<mde.MdeEnvironment, 'id'>): Promise<void> {
    // TODO: check if dev mode is enabled, then install the development toolkit into the MDE
    await new ChildProcess(
        true,
        'ssh',
        undefined,
        mde.id,
        `find ~ -path '*.vscode-server/bin/*/bin/code' -exec {} --install-extension ${VSCODE_EXTENSION_ID.awstoolkit} \\;`
    ).run(
        stdout => getLogger().verbose(`MDE install toolkit: ${mde.id}: ${stdout}`),
        stderr => getLogger().verbose(`MDE install toolkit: ${mde.id}: ${stderr}`)
    )
}

export async function tagMde(arn: string, tagMap: TagMap) {
    await ext.mde.tagResource(arn, tagMap)
}
