/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { CodeScanIssue } from '../models/model'
import globals from '../../shared/extensionGlobals'
import { telemetry } from '../../shared/telemetry/telemetry'
import path from 'path'
import { AuthUtil } from '../util/authUtil'
import { TelemetryHelper } from '../util/telemetryHelper'
import { SecurityIssueProvider } from './securityIssueProvider'
import { amazonqCodeIssueDetailsTabTitle } from '../models/constants'

export class SecurityIssueHoverProvider implements vscode.HoverProvider {
    static #instance: SecurityIssueHoverProvider
    private issueProvider: SecurityIssueProvider = SecurityIssueProvider.instance

    public static get instance() {
        return (this.#instance ??= new this())
    }

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover {
        const contents: vscode.MarkdownString[] = []

        for (const group of this.issueProvider.issues) {
            if (document.fileName !== group.filePath) {
                continue
            }

            for (const issue of group.issues) {
                if (!issue.visible) {
                    continue
                }
                const range = new vscode.Range(issue.startLine, 0, issue.endLine, 0)
                if (range.contains(position)) {
                    contents.push(this._getContent(group.filePath, issue))
                    telemetry.codewhisperer_codeScanIssueHover.emit({
                        findingId: issue.findingId,
                        detectorId: issue.detectorId,
                        ruleId: issue.ruleId,
                        includesFix: !!issue.suggestedFixes.length,
                        credentialStartUrl: AuthUtil.instance.startUrl,
                        autoDetected: issue.autoDetected,
                    })
                    TelemetryHelper.instance.sendCodeScanRemediationsEvent(
                        document.languageId,
                        'CODESCAN_ISSUE_HOVER',
                        issue.detectorId,
                        issue.findingId,
                        issue.ruleId,
                        undefined,
                        undefined,
                        undefined,
                        !!issue.suggestedFixes.length
                    )
                }
            }
        }

        return new vscode.Hover(contents)
    }

    private _getContent(filePath: string, issue: CodeScanIssue) {
        const markdownString = new vscode.MarkdownString()
        markdownString.isTrusted = true
        markdownString.supportHtml = true
        markdownString.supportThemeIcons = true
        markdownString.baseUri = vscode.Uri.file(path.join(globals.context.extensionPath, 'resources/images/'))

        const [suggestedFix] = issue.suggestedFixes

        markdownString.appendMarkdown(`## ${issue.title} ${this._makeSeverityBadge(issue.severity)}\n`)
        markdownString.appendMarkdown(
            `${suggestedFix?.code && suggestedFix.description !== '' ? suggestedFix.description : issue.recommendation.text}\n\n`
        )

        const viewDetailsCommand = this._getCommandMarkdown(
            'aws.amazonq.openSecurityIssuePanel',
            [issue, filePath],
            'eye',
            'View Details',
            `Open "${amazonqCodeIssueDetailsTabTitle}"`
        )
        markdownString.appendMarkdown(viewDetailsCommand)

        const explainWithQCommand = this._getCommandMarkdown(
            'aws.amazonq.explainIssue',
            [issue],
            'comment',
            'Explain',
            'Explain with Amazon Q'
        )
        markdownString.appendMarkdown(' | ' + explainWithQCommand)

        const ignoreIssueCommand = this._getCommandMarkdown(
            'aws.amazonq.security.ignore',
            [issue, filePath, 'hover'],
            'error',
            'Ignore',
            'Ignore Issue'
        )
        markdownString.appendMarkdown(' | ' + ignoreIssueCommand)

        const ignoreSimilarIssuesCommand = this._getCommandMarkdown(
            'aws.amazonq.security.ignoreAll',
            [issue, 'hover'],
            'error',
            'Ignore All',
            'Ignore Similar Issues'
        )
        markdownString.appendMarkdown(' | ' + ignoreSimilarIssuesCommand)

        if (suggestedFix && suggestedFix.code) {
            const applyFixCommand = this._getCommandMarkdown(
                'aws.amazonq.applySecurityFix',
                [issue, filePath, 'hover'],
                'wrench',
                'Fix',
                'Fix with Amazon Q'
            )
            markdownString.appendMarkdown(' | ' + applyFixCommand)

            markdownString.appendMarkdown('### Suggested Fix Preview\n')
            markdownString.appendMarkdown(
                `${this._makeCodeBlock(suggestedFix.code, issue.detectorId.split('/').shift())}\n`
            )
        }

        return markdownString
    }

    private _getCommandMarkdown(command: string, args: any, icon: string, text: string, description: string) {
        const commandUri = vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify(args))}`)
        return `[$(${icon}) ${text}](${commandUri} '${description}')\n`
    }

    private _makeSeverityBadge(severity: string) {
        if (!severity) {
            return ''
        }
        return `![${severity}](severity-${severity.toLowerCase()}.svg)`
    }

    /**
     * Creates a markdown string to render a code diff block for a given code block. Lines
     * that are highlighted red indicate deletion while lines highlighted in green indicate
     * addition. An optional language can be provided for syntax highlighting on lines which are
     * not additions or deletions.
     *
     * @param code The code containing the diff
     * @param language The language for syntax highlighting
     * @returns The markdown string
     */
    private _makeCodeBlock(code: string, language?: string) {
        const lines = code
            .replaceAll('\n\\ No newline at end of file', '')
            .replaceAll('--- buggyCode\n', '')
            .replaceAll('+++ fixCode\n', '')
            .split('\n')
        const maxLineChars = lines.reduce((acc, curr) => Math.max(acc, curr.length), 0)
        const paddedLines = lines.map((line) => line.padEnd(maxLineChars + 2))

        // Group the lines into sections so consecutive lines of the same type can be placed in
        // the same span below
        const sections = [paddedLines[0]]
        let i = 1
        while (i < paddedLines.length) {
            if (paddedLines[i][0] === sections[sections.length - 1][0]) {
                sections[sections.length - 1] += '\n' + paddedLines[i]
            } else {
                sections.push(paddedLines[i])
            }
            i++
        }

        // Return each section with the correct syntax highlighting and background color
        return sections
            .map(
                (section) => `
<span class="codicon codicon-none" style="background-color:var(${
                    section.startsWith('-')
                        ? '--vscode-diffEditor-removedTextBackground'
                        : section.startsWith('+')
                          ? '--vscode-diffEditor-insertedTextBackground'
                          : section.startsWith('@@')
                            ? '--vscode-editorMarkerNavigationInfo-headerBackground'
                            : '--vscode-diffEditor-unchangedCodeBackground'
                });">

\`\`\`${section.startsWith('-') || section.startsWith('+') ? 'diff' : section.startsWith('@@') ? undefined : language}
${section}
\`\`\`

</span>
`
            )
            .join('<br />')
    }
}
