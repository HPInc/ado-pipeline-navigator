const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const https = require('https');
const { getTaskUrl } = require('./taskUrlUtils');

const DEFAULT_FEATURE_TOGGLES = { InternetFetch: false, ReplaceStrings: true };
const DEFAULT_KEYWORDS = ['parameters', 'stages', 'jobs', 'steps'];
const DEFAULT_QUICK_REPLACE_COUNT = 1;

let navigatorInstance = null;

class AdoPipelineNavigator {
    constructor() {
        this.decorationType = this.createDecorationType();
        this.loadConfiguration();
        this.updatePattern();
        this.decorationTimeout = null;
        this.documentationCache = new Map(); // Cache for fetched task documentation
        this.pendingFetches = new Map(); // Track in-progress fetches to avoid duplicates
        this.activeHovers = new Map(); // Track active hover requests by task name
    }

    createDecorationType() {
        return vscode.window.createTextEditorDecorationType({
            textDecoration: 'underline',
            overviewRulerColor: 'blue',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            cursor: 'pointer',
            color: '#FFD580',
            after: { fontWeight: 'bold' },
            light: { color: 'darkorange', borderColor: 'darkblue' },
            dark: { color: 'lightorange', borderColor: 'lightblue' },
        });
    }

    loadConfiguration() {
        const config = vscode.workspace.getConfiguration('ado-pipeline-navigator');
        this.featureToggles = getFeatureTogglesConfig();
        this.keywordsToDisplayOnHover = config.get('keywordsToDisplayOnHover');
        if (!this.keywordsToDisplayOnHover) {
            this.keywordsToDisplayOnHover = DEFAULT_KEYWORDS;
        }
        this.quickReplaceStringsCount = config.get('quickReplaceStringsCount', DEFAULT_QUICK_REPLACE_COUNT);
        this.replacementStrings = config.get('replacementStrings', []);
        if (this.replacementStrings.length === 0) {
            const pathReplacements = vscode.workspace.getConfiguration('adopipeline').get('pathReplacements');
            if (pathReplacements && Array.isArray(pathReplacements)) {
                this.replacementStrings = pathReplacements;
            } else {
                this.replacementStrings.push({ find: '', replace: '' });
            }
        }
        // Custom keywords for local file navigation (e.g., systemTestTemplate: path/to/file.yaml)
        this.filePathKeys = config.get('filePathKeys', ['systemTestTemplate']);
        // Filter out empty strings to prevent regex issues
        this.filePathKeys = this.filePathKeys.filter((key) => key && key.trim().length > 0);
    }

    updatePattern() {
        const baseKeywords = ['template', 'file', 'task'];
        const allKeywords = [...baseKeywords, ...this.filePathKeys];
        // Escape special regex characters in keywords
        const escapedKeywords = allKeywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const keywordPattern = escapedKeywords.join('|');
        this.pattern = new RegExp(`([-# ]+ +(${keywordPattern}) *[: ]+)([^#\r\n]+)`);
    }

    isFilePathKey(keyword) {
        if (keyword === 'file' || keyword === 'template') {
            return true;
        }
        return this.filePathKeys.includes(keyword);
    }

    getFilePath(document, match) {
        let rootPath = '';
        if (vscode.workspace.workspaceFolders) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : '';
        }
        let filePath = match[3].trim();

        if (filePath.includes('@')) {
            filePath = filePath.substring(0, filePath.indexOf('@'));
        }

        if (this.featureToggles.ReplaceStrings) {
            filePath = this.applyReplacements(filePath);
        }

        return this.resolveFilePath(document, rootPath, filePath);
    }

    applyReplacements(filePath) {
        return this.replacementStrings.reduce((updatedPath, replacement) => {
            return updatedPath.replace(replacement.find, replacement.replace);
        }, filePath);
    }

    resolveFilePath(document, rootPath, filePath) {
        const possiblePaths = [];

        if (filePath.startsWith('./') || filePath.startsWith('../')) {
            possiblePaths.push(path.join(path.dirname(document.uri.fsPath), filePath));
        }
        possiblePaths.push(path.join(rootPath, filePath));

        for (const fileAbsPath of possiblePaths) {
            if (fs.existsSync(fileAbsPath)) {
                return { found: true, fileAbsPath };
            }
        }

        const workspacePaths = this.searchWorkspaceFolders(filePath);
        if (workspacePaths.length > 0) {
            return { found: true, fileAbsPath: workspacePaths[0] };
        }

        return { found: false, fileAbsPath: filePath };
    }

    searchWorkspaceFolders(filePath) {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        for (let workspaceFolder of vscode.workspace.workspaceFolders) {
            if (fs.existsSync(path.join(workspaceFolder.uri.fsPath, filePath))) {
                return [path.join(workspaceFolder.uri.fsPath, filePath)];
            }
            try {
                let files = fs.readdirSync(workspaceFolder.uri.fsPath);
                let dirs = files.filter(
                    (file) =>
                        fs.statSync(path.join(workspaceFolder.uri.fsPath, file)).isDirectory() &&
                        fs.existsSync(path.join(workspaceFolder.uri.fsPath, file, filePath))
                );
                if (dirs.length > 0) {
                    return [path.join(workspaceFolder.uri.fsPath, dirs[0], filePath)];
                }
            } catch (error) {
                console.error(`Error reading workspace folder: ${error.message}`);
            }
        }

        return [];
    }

    async fetchTaskDocumentation(url) {
        // Check cache first
        if (this.documentationCache.has(url)) {
            return this.documentationCache.get(url);
        }

        // Check if already fetching to avoid duplicate requests
        if (this.pendingFetches.has(url)) {
            return await this.pendingFetches.get(url);
        }

        // Create fetch promise and store it
        const fetchPromise = (async () => {
            try {
                const html = await this.fetchUrl(url);

                // Extract YAML code block after #syntax section using regex
                // Look for <pre><code>...</code></pre> pattern after id="syntax"
                const syntaxMatch = html.match(
                    /id=["']syntax["'][^>]*>[\s\S]*?<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/i
                );
                const result = syntaxMatch ? this.decodeHtmlEntities(syntaxMatch[1]).trim() : null;

                // Cache the result (including null results to avoid refetching failed URLs)
                this.documentationCache.set(url, result);
                return result;
            } catch (error) {
                console.error(`Failed to fetch task documentation: ${error.message}`);
                // Cache null to avoid refetching immediately
                this.documentationCache.set(url, null);
                return null;
            } finally {
                // Remove from pending fetches
                this.pendingFetches.delete(url);
            }
        })();

        // Store the promise to prevent duplicate fetches
        this.pendingFetches.set(url, fetchPromise);
        return await fetchPromise;
    }

    fetchUrl(url) {
        return new Promise((resolve, reject) => {
            const request = https.get(url, { timeout: 5000 }, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                let data = '';
                response.on('data', (chunk) => (data += chunk));
                response.on('end', () => resolve(data));
                response.on('error', reject);
            });

            request.on('timeout', () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });

            request.on('error', reject);
        });
    }

    decodeHtmlEntities(html) {
        return html
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ');
    }

    provideDocumentLinks(document, token) {
        if (!document || token?.isCancellationRequested) {
            return;
        }

        let links = [];
        for (let line = 0; line < document.lineCount; line++) {
            if (token?.isCancellationRequested) {
                return links;
            }
            let textLine = document.lineAt(line);
            let match = textLine.text.match(this.pattern);

            if (!match) {
                continue;
            }

            // Only create document links for tasks (not for file/template)
            if (match[2].trim() === 'task') {
                let url = getTaskUrl(match[3].trim());
                if (url) {
                    let range = new vscode.Range(
                        line,
                        match.index + match[1].length,
                        line,
                        match.index + match[0].trimEnd().length
                    );
                    links.push(new vscode.DocumentLink(range, vscode.Uri.parse(url)));
                }
            }
        }

        return links;
    }

    // Apply decorations to show visual link styling
    applyDecorations(document) {
        if (!document) {
            return;
        }

        // Performance optimization: skip decoration for very large files
        if (document.lineCount > 10000) {
            console.log('Skipping decorations for large file with ' + document.lineCount + ' lines');
            return;
        }

        let decorations = [];
        for (let line = 0; line < document.lineCount; line++) {
            let textLine = document.lineAt(line);
            let match = textLine.text.match(this.pattern);

            if (!match) {
                continue;
            }

            const keyword = match[2].trim();
            const decorate = keyword === 'task' || this.isFilePathKey(keyword);
            if (decorate) {
                let range = new vscode.Range(
                    line,
                    match.index + match[1].length,
                    line,
                    match.index + match[0].trimEnd().length
                );
                decorations.push({ range: range });
            }
        }

        if (vscode.window.activeTextEditor) {
            vscode.window.activeTextEditor.setDecorations(this.decorationType, decorations);
        }
    }

    // Debounced version for text document changes
    applyDecorationsDebounced(document) {
        if (this.decorationTimeout) {
            clearTimeout(this.decorationTimeout);
        }
        this.decorationTimeout = setTimeout(() => {
            this.applyDecorations(document);
        }, 300);
    }

    // Open the file or task documentation on ctrl+click or F12
    provideDefinition(document, position, token) {
        if (!document || token?.isCancellationRequested) {
            return;
        }

        let line = document.lineAt(position.line);
        let match = line.text.match(this.pattern);

        if (!match) {
            return null;
        }

        const keyword = match[2].trim();
        if (this.isFilePathKey(keyword)) {
            let result = this.getFilePath(document, match);
            let uri = vscode.Uri.file(result.fileAbsPath);
            return new vscode.Location(uri, new vscode.Position(0, 0));
        }
        return null;
    }

    // Show the hover text on mouse hover for the resolved path, task document or error info
    async provideHover(document, position, token) {
        if (!document || token?.isCancellationRequested) {
            return null;
        }
        const line = document.lineAt(position.line);
        const match = line.text.match(this.pattern);
        if (!match) return null;

        const keyword = match[2].trim();
        if (keyword === 'task') {
            return this.getTaskHover(match[3].trim());
        } else if (this.isFilePathKey(keyword)) {
            return this.getFileHover(document, match);
        }
        return null;
    }

    async getTaskHover(task) {
        // Prevent multiple simultaneous hover requests for the same task
        if (this.activeHovers.has(task)) {
            return await this.activeHovers.get(task);
        }

        const hoverPromise = (async () => {
            try {
                if (!this.featureToggles.InternetFetch) {
                    const message = new vscode.MarkdownString();
                    message.appendMarkdown(
                        `\`InternetFetch\` is disabled. [Enable it](command:ado-pipeline-navigator.featureTogglesCommand) (Ctrl+Shift+P → "ADO Pipeline Navigator: Feature Toggles") to fetch task documentation`
                    );
                    message.isTrusted = true;
                    return new vscode.Hover(message);
                }

                const url = getTaskUrl(task);
                if (!url) return null;

                // Show loading indicator only if not cached
                const isCached = this.documentationCache.has(url);
                const statusBarDisposable = isCached
                    ? null
                    : vscode.window.setStatusBarMessage('$(sync~spin) Fetching task documentation...');

                try {
                    const usage = await this.fetchTaskDocumentation(url);
                    if (statusBarDisposable) statusBarDisposable.dispose();

                    if (!usage) return null;

                    return new vscode.Hover(
                        new vscode.MarkdownString(
                            `**Task Documentation:** [Learn more](${url})\n\n\`\`\`yaml\n${usage}\n\`\`\``
                        )
                    );
                } catch (error) {
                    if (statusBarDisposable) statusBarDisposable.dispose();
                    const message = new vscode.MarkdownString();
                    message.appendMarkdown(`**Task Documentation:** [Learn more](${url})\n\n`);
                    message.appendMarkdown(`⚠️ Error: ${error.message}`);
                    message.isTrusted = true;
                    return new vscode.Hover(message);
                }
            } finally {
                // Remove from active hovers after a short delay
                setTimeout(() => this.activeHovers.delete(task), 100);
            }
        })();

        this.activeHovers.set(task, hoverPromise);
        return await hoverPromise;
    }

    getFileHover(document, match) {
        let result = this.getFilePath(document, match);
        let filePath = result.fileAbsPath;
        let uri = vscode.Uri.file(filePath);
        let hoverText = `[${filePath}](${uri})`;
        if (result.found) {
            try {
                let fileContents = fs.readFileSync(filePath, 'utf8');
                let yamlContents = yaml.load(fileContents);
                if (yamlContents && typeof yamlContents === 'object') {
                    let displayItems = {};
                    for (let keyword of this.keywordsToDisplayOnHover) {
                        if (yamlContents[keyword]) {
                            // Check if it's an array or object with content
                            const value = yamlContents[keyword];
                            const hasContent = Array.isArray(value)
                                ? value.length > 0
                                : typeof value === 'object' && Object.keys(value).length > 0;
                            if (hasContent) {
                                displayItems[keyword] = value;
                            }
                        }
                    }
                    if (Object.keys(displayItems).length > 0) {
                        let parameters = yaml.dump(displayItems, { indent: 2, noArrayIndent: true });
                        hoverText += `\n\`\`\`yaml\n${parameters}\n\`\`\``;
                    }
                }
            } catch (error) {
                console.error(`Error reading or parsing file: ${error.message}`);
            }
        } else {
            hoverText += '\n\nFile not found.';
            if (!this.featureToggles.ReplaceStrings) {
                hoverText +=
                    ' `ReplaceStrings` feature is disabled. Enable it from command palette to replace strings in file path\n\n`ADO Pipeline Navigator: ReplaceStrings`';
            }
        }

        return new vscode.Hover(new vscode.MarkdownString(hoverText));
    }
}

async function replacementStringsCommand(navigator) {
    let updated = false;

    let replacementStrings = navigator.replacementStrings;

    let maxIterations = Math.min(navigator.quickReplaceStringsCount, replacementStrings.length);
    for (let i = 0; i < maxIterations; i++) {
        let replacement = replacementStrings[i];

        let find = await vscode.window.showInputBox({
            prompt: 'Enter the string to find for replacement',
            value: replacement.find,
        });
        let replace = await vscode.window.showInputBox({
            prompt: 'Enter the replacement string',
            value: replacement.replace,
        });

        if (find !== undefined && replace !== undefined) {
            replacement.find = find;
            replacement.replace = replace;
            updated = true;
        }
    }

    if (updated) {
        let config = vscode.workspace.getConfiguration('ado-pipeline-navigator', null);
        await config.update('replacementStrings', replacementStrings, vscode.ConfigurationTarget.Global);
    }
}

function getFeatureTogglesConfig() {
    let config = vscode.workspace.getConfiguration('ado-pipeline-navigator');
    let featureToggles = { ...DEFAULT_FEATURE_TOGGLES, ...config.get('featureToggles', {}) };
    return featureToggles;
}

async function featureTogglesCommand(navigator) {
    let featureToggles = getFeatureTogglesConfig();
    let featureTogglesMap = Object.entries(featureToggles).map(([featureName, isEnabled]) => ({
        label: `${isEnabled ? '✅' : '❌'} ${featureName}`,
        featureName,
        isEnabled,
    }));

    const selected = await vscode.window.showQuickPick(featureTogglesMap, {
        placeHolder: 'Select a feature to toggle',
    });

    if (selected) {
        featureToggles[selected.featureName] = !selected.isEnabled;
        let config = vscode.workspace.getConfiguration('ado-pipeline-navigator');
        await config.update('featureToggles', featureToggles, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
            `Feature "${selected.featureName}" is now ${featureToggles[selected.featureName] ? 'enabled' : 'disabled'}.`
        );
    }
}

function activate(context) {
    console.log('ADO Pipeline Navigator is now active!');
    navigatorInstance = new AdoPipelineNavigator();
    const navigator = navigatorInstance;

    // Ensure decorationType is disposed when extension deactivates
    context.subscriptions.push(navigator.decorationType);

    const languages = ['azure-pipelines', 'yaml', 'markdown', 'plaintext'];
    languages.forEach((language) => {
        // Document link provider enabled for tasks only (ctrl+click without ctrl+hover opening)
        context.subscriptions.push(vscode.languages.registerDocumentLinkProvider({ language }, navigator));
        context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language }, navigator));
        context.subscriptions.push(vscode.languages.registerHoverProvider({ language }, navigator));
    });

    // Apply decorations when the active editor changes or document changes
    if (vscode.window.activeTextEditor) {
        navigator.applyDecorations(vscode.window.activeTextEditor.document);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                navigator.applyDecorations(editor.document);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
                navigator.applyDecorationsDebounced(event.document);
            }
        })
    );

    let commandFunctionMap = {
        replacementStringsCommand: replacementStringsCommand,
        featureTogglesCommand: featureTogglesCommand,
    };
    for (let command in commandFunctionMap) {
        context.subscriptions.push(
            vscode.commands.registerCommand(
                `ado-pipeline-navigator.${command}`,
                commandFunctionMap[command].bind(null, navigator)
            )
        );
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('ado-pipeline-navigator.replacementStrings')) {
                if (vscode.window.activeTextEditor) {
                    navigator.applyDecorations(vscode.window.activeTextEditor.document);
                }
            }
            // Update the feature toggles when the settings are changed
            if (event.affectsConfiguration('ado-pipeline-navigator.featureToggles')) {
                navigator.featureToggles = getFeatureTogglesConfig();
            }
            // Update custom template keywords when settings change
            if (event.affectsConfiguration('ado-pipeline-navigator.filePathKeys')) {
                navigator.loadConfiguration();
                navigator.updatePattern();
                if (vscode.window.activeTextEditor) {
                    navigator.applyDecorations(vscode.window.activeTextEditor.document);
                }
            }
        })
    );
}

function deactivate() {
    // Clear any pending decoration timeouts
    if (navigatorInstance && navigatorInstance.decorationTimeout) {
        clearTimeout(navigatorInstance.decorationTimeout);
        navigatorInstance.decorationTimeout = null;
    }
    // Clear caches
    if (navigatorInstance) {
        navigatorInstance.documentationCache?.clear();
        navigatorInstance.pendingFetches?.clear();
        navigatorInstance.activeHovers?.clear();
    }
    navigatorInstance = null;
}

module.exports = { activate, deactivate };
