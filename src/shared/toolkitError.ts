/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AWSError } from 'aws-sdk'
import { Result } from './telemetry/telemetry'
import { CancellationError } from './utilities/timeoutUtils'

interface ErrorMetadata {
    // TODO: when `cause` is natively supported this can be removed
    /**
     * A reason for the error. This can be a string or another error.
     */
    readonly cause?: ToolkitError | Error | string

    /**
     * Detailed information about the error. This may be added to logs.
     */
    readonly detail?: string

    /**
     * Flag to determine if the error was from a user-initiated cancellation.
     */
    readonly cancelled?: boolean
}

/**
 * Error class for user-facing messages along with extra metadata.
 */
export class ToolkitError extends Error implements ErrorMetadata {
    /**
     * A message that could potentially be shown to the user. This should not contain any
     * sensitive information and should be limited in technical detail.
     */
    public readonly message: string
    public readonly cause = this.metadata.cause
    public readonly detail = this.metadata.detail

    public constructor(message: string, protected readonly metadata: ErrorMetadata = {}) {
        super(message)
        this.message = message

        if (this === metadata.cause) {
            throw new TypeError('The cause of an error cannot be a circular reference')
        }
    }

    public get cancelled(): boolean {
        const cause = this.metadata.cause

        return (
            this.metadata.cancelled ??
            (CancellationError.isUserCancelled(cause) || (cause instanceof ToolkitError && cause.cancelled))
        )
    }

    public get trace(): string {
        const message = this.detail ?? this.message

        if (!this.cause) {
            return message
        }

        const cause = typeof this.cause === 'string' ? this.cause : formatError(this.cause)
        return `${message}\n\t -> ${cause}`
    }
}

function formatError(err: Error): string {
    const extraInfo: Record<string, string | undefined> = {}

    if (isAwsError(err)) {
        extraInfo['statusCode'] = String(err.statusCode ?? '')
        extraInfo['requestId'] = err.requestId
        extraInfo['extendedRequestId'] = err.extendedRequestId
    }

    const content = err instanceof ToolkitError ? err.trace : `${err.name}: ${err.message}`
    const extras = Object.entries(extraInfo)
        .filter(([_, v]) => !!v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')

    return extras.length > 0 ? `${content} (${extras})` : content
}

export class UnknownError extends Error {
    public constructor(public readonly cause: unknown) {
        super(`Unknown error: ${String(cause)}`)
    }

    public static cast(obj: unknown): Error {
        return obj instanceof Error ? obj : new UnknownError(obj)
    }
}

export function getTelemetryResult(err: unknown | undefined): Result {
    if (err === undefined) {
        return 'Succeeded'
    } else if (CancellationError.isUserCancelled(err) || (err instanceof ToolkitError && err.cancelled)) {
        return 'Cancelled'
    }

    return 'Failed'
}

export function getTelemetryReason(err: unknown | undefined): string | undefined {
    if (err === undefined) {
        return undefined
    } else if (err instanceof CancellationError) {
        return err.agent
    } else if (err instanceof ToolkitError) {
        return getTelemetryReason(err.cause) ?? err.message
    } else if (err instanceof Error) {
        return err.name
    }

    return 'Unknown'
}

export function isAwsError(err: unknown | undefined): err is AWSError {
    if (err === undefined) {
        return false
    }

    return (
        err instanceof Error &&
        (err as { time?: unknown }).time instanceof Date &&
        typeof (err as { code?: unknown }).code === 'string'
    )
}
