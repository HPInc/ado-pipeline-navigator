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
        this.uriExistsCache = new Map();
        this.aliasWorkspaceMatchCache = new Map();
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
        const { filePathWithNoAlias, repositoryAlias } = this.parseReferencedPath(match[3]);
        let filePath = filePathWithNoAlias;

        if (this.featureToggles.ReplaceStrings) {
            filePath = this.applyReplacements(filePath);
        }

        return this.resolveFilePath(document, rootPath, filePath, repositoryAlias);
    }

    parseReferencedPath(filePath) {
        const normalizedPath = this.normalizeReferencedPath(filePath);
        const atIndex = normalizedPath.indexOf('@');
        if (atIndex < 0) {
            return { filePathWithNoAlias: normalizedPath, repositoryAlias: '' };
        }

        return {
            filePathWithNoAlias: normalizedPath.substring(0, atIndex),
            repositoryAlias: normalizedPath.substring(atIndex + 1).trim(),
        };
    }

    normalizeReferencedPath(filePath) {
        let normalizedPath = filePath.trim();
        if (
            (normalizedPath.startsWith('"') && normalizedPath.endsWith('"')) ||
            (normalizedPath.startsWith("'") && normalizedPath.endsWith("'"))
        ) {
            normalizedPath = normalizedPath.substring(1, normalizedPath.length - 1);
        }

        return normalizedPath;
    }

    applyReplacements(filePath) {
        return this.replacementStrings.reduce((updatedPath, replacement) => {
            return updatedPath.replace(replacement.find, replacement.replace);
        }, filePath);
    }

    splitPathSegments(filePath) {
        return filePath
            .replace(/^[/\\]+/, '')
            .split(/[/\\]+/)
            .filter((segment) => segment.length > 0);
    }

    buildWorkspaceUri(baseUri, filePath) {
        const pathSegments = this.splitPathSegments(filePath);
        if (pathSegments.length === 0) {
            return baseUri;
        }

        return vscode.Uri.joinPath(baseUri, ...pathSegments);
    }

    normalizePathForSuffixMatch(filePath) {
        return filePath
            .replace(/^[/\\]+/, '')
            .replace(/\\/g, '/')
            .toLowerCase();
    }

    clearResolutionCaches() {
        this.uriExistsCache.clear();
        this.aliasWorkspaceMatchCache.clear();
    }

    getConventionFallbackRelativePaths(filePath, repoRelativePath) {
        const normalizedRepoRelativePath = this.normalizePathForSuffixMatch(repoRelativePath || filePath);
        const fallbackPaths = [];
        const projectTemplateMatch = normalizedRepoRelativePath.match(/^projects\/[^/]+\/templates\/([^/]+\.ya?ml)$/i);

        if (projectTemplateMatch) {
            const templateFileName = projectTemplateMatch[1];
            fallbackPaths.push(`templates/codeway-${templateFileName}`);
        }

        return fallbackPaths;
    }

    async uriExists(uri) {
        const cacheKey = uri.toString();
        if (this.uriExistsCache.has(cacheKey)) {
            return this.uriExistsCache.get(cacheKey);
        }

        try {
            await vscode.workspace.fs.stat(uri);
            this.uriExistsCache.set(cacheKey, true);
            return true;
        } catch {
            if (uri.scheme === 'file') {
                const exists = fs.existsSync(uri.fsPath);
                this.uriExistsCache.set(cacheKey, exists);
                return exists;
            }
            this.uriExistsCache.set(cacheKey, false);
            return false;
        }
    }

    async readTextFile(fileReference) {
        const uri = typeof fileReference === 'string' ? vscode.Uri.file(fileReference) : fileReference;
        try {
            const fileContents = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(fileContents).toString('utf8');
        } catch {
            return fs.readFileSync(uri.fsPath, 'utf8');
        }
    }

    async findAliasWorkspaceMatch(
        repositoryWorkspaceFolders,
        filePath,
        repoRelativePath,
        useConventionFallback = false
    ) {
        if (!repositoryWorkspaceFolders || repositoryWorkspaceFolders.length === 0) {
            return null;
        }

        const normalizedFilePath = this.normalizePathForSuffixMatch(filePath);
        const normalizedRepoRelativePath = this.normalizePathForSuffixMatch(repoRelativePath);
        const folderCacheKey = repositoryWorkspaceFolders
            .map((workspaceFolder) => workspaceFolder.uri.toString())
            .sort()
            .join('|');
        const matchCacheKey = `${folderCacheKey}|${normalizedFilePath}|${normalizedRepoRelativePath}|${useConventionFallback}`;
        if (this.aliasWorkspaceMatchCache.has(matchCacheKey)) {
            const cachedMatch = this.aliasWorkspaceMatchCache.get(matchCacheKey);
            return cachedMatch ? vscode.Uri.parse(cachedMatch) : null;
        }

        const matchingSuffixes = [normalizedRepoRelativePath, normalizedFilePath].filter((value) => value.length > 0);
        const basename = path.posix.basename(normalizedRepoRelativePath || normalizedFilePath);
        if (!basename) {
            this.aliasWorkspaceMatchCache.set(matchCacheKey, null);
            return null;
        }

        const fallbackRelativePaths = useConventionFallback
            ? this.getConventionFallbackRelativePaths(filePath, repoRelativePath)
            : [];
        const fallbackBasenames = fallbackRelativePaths
            .map((fallbackRelativePath) => path.posix.basename(this.normalizePathForSuffixMatch(fallbackRelativePath)))
            .filter((fallbackBasename) => fallbackBasename.length > 0);
        const basenamesToSearch = [basename, ...fallbackBasenames];

        for (const workspaceFolder of repositoryWorkspaceFolders) {
            let matches = [];
            for (const basenameToSearch of basenamesToSearch) {
                const filePattern = new vscode.RelativePattern(workspaceFolder, `**/${basenameToSearch}`);
                const matchesForBasename = await vscode.workspace.findFiles(filePattern, null, 200);
                if (matchesForBasename.length > 0) {
                    matches = matches.concat(matchesForBasename);
                }
            }

            if (matches.length === 0) {
                continue;
            }

            const normalizedFallbackSuffixes = fallbackRelativePaths
                .map((fallbackRelativePath) => this.normalizePathForSuffixMatch(fallbackRelativePath))
                .filter((fallbackSuffix) => fallbackSuffix.length > 0);

            const bestMatch = matches.find((matchUri) => {
                const normalizedMatchPath = this.normalizePathForSuffixMatch(matchUri.path);
                return (
                    matchingSuffixes.some((suffix) => normalizedMatchPath.endsWith(suffix)) ||
                    normalizedFallbackSuffixes.some((suffix) => normalizedMatchPath.endsWith(suffix))
                );
            });

            if (bestMatch) {
                this.aliasWorkspaceMatchCache.set(matchCacheKey, bestMatch.toString());
                return bestMatch;
            }

            this.aliasWorkspaceMatchCache.set(matchCacheKey, matches[0].toString());
            return matches[0];
        }

        this.aliasWorkspaceMatchCache.set(matchCacheKey, null);
        return null;
    }

    async resolveFilePath(document, rootPath, filePath, repositoryAlias = '') {
        const possiblePaths = [];
        const repoRelativePath = filePath.replace(/^[/\\]+/, '');
        const currentWorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        const repositoryWorkspaceFolders = this.getWorkspaceFoldersByAlias(document, repositoryAlias);
        for (const workspaceFolder of repositoryWorkspaceFolders) {
            if (repoRelativePath.length > 0) {
                possiblePaths.push(this.buildWorkspaceUri(workspaceFolder.uri, repoRelativePath));
            }
            possiblePaths.push(this.buildWorkspaceUri(workspaceFolder.uri, filePath));
        }

        if (path.isAbsolute(filePath)) {
            possiblePaths.push(vscode.Uri.file(filePath));
        }

        if (filePath.startsWith('./') || filePath.startsWith('../')) {
            possiblePaths.push(vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), filePath)));
        }

        if (repoRelativePath.length > 0) {
            if (currentWorkspaceFolder) {
                possiblePaths.push(this.buildWorkspaceUri(currentWorkspaceFolder.uri, repoRelativePath));
            } else {
                possiblePaths.push(vscode.Uri.file(path.join(rootPath, repoRelativePath)));
            }
        }

        for (const candidateUri of possiblePaths) {
            const exists = await this.uriExists(candidateUri);
            if (exists) {
                return { found: true, fileAbsPath: candidateUri.fsPath, uri: candidateUri };
            }
        }

        const aliasWorkspaceMatch = await this.findAliasWorkspaceMatch(
            repositoryWorkspaceFolders,
            filePath,
            repoRelativePath,
            false
        );
        if (aliasWorkspaceMatch) {
            return { found: true, fileAbsPath: aliasWorkspaceMatch.fsPath, uri: aliasWorkspaceMatch };
        }

        const workspacePaths = await this.searchWorkspaceFolders(filePath, repoRelativePath, repositoryAlias);
        if (workspacePaths.length > 0) {
            return { found: true, fileAbsPath: workspacePaths[0].fsPath, uri: workspacePaths[0] };
        }

        const fallbackRelativePaths = this.getConventionFallbackRelativePaths(filePath, repoRelativePath);
        if (fallbackRelativePaths.length > 0) {
            for (const workspaceFolder of repositoryWorkspaceFolders) {
                for (const fallbackRelativePath of fallbackRelativePaths) {
                    const fallbackUri = this.buildWorkspaceUri(workspaceFolder.uri, fallbackRelativePath);
                    const fallbackExists = await this.uriExists(fallbackUri);
                    if (fallbackExists) {
                        return { found: true, fileAbsPath: fallbackUri.fsPath, uri: fallbackUri };
                    }
                }
            }

            const conventionAliasMatch = await this.findAliasWorkspaceMatch(
                repositoryWorkspaceFolders,
                filePath,
                repoRelativePath,
                true
            );
            if (conventionAliasMatch) {
                return { found: true, fileAbsPath: conventionAliasMatch.fsPath, uri: conventionAliasMatch };
            }
        }

        return { found: false, fileAbsPath: filePath };
    }

    getWorkspaceFoldersByAlias(document, repositoryAlias) {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        if (!repositoryAlias) {
            return [];
        }

        if (repositoryAlias === 'self') {
            const currentWorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            return currentWorkspaceFolder ? [currentWorkspaceFolder] : [];
        }

        const matchingFolders = vscode.workspace.workspaceFolders.filter(
            (workspaceFolder) =>
                path.basename(workspaceFolder.uri.fsPath).toLowerCase() === repositoryAlias.toLowerCase()
        );
        return matchingFolders;
    }

    async searchWorkspaceFolders(filePath, repoRelativePath = filePath, repositoryAlias = '') {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const candidatePaths = [filePath];
        if (repoRelativePath && repoRelativePath !== filePath) {
            candidatePaths.unshift(repoRelativePath);
        }

        let workspaceFolders = vscode.workspace.workspaceFolders;
        if (repositoryAlias) {
            const aliasLower = repositoryAlias.toLowerCase();
            const aliasMatches = workspaceFolders.filter(
                (workspaceFolder) => path.basename(workspaceFolder.uri.fsPath).toLowerCase() === aliasLower
            );
            if (aliasMatches.length > 0) {
                workspaceFolders = aliasMatches;
            }
        }

        for (let workspaceFolder of workspaceFolders) {
            for (const candidatePath of candidatePaths) {
                const directCandidateUri = this.buildWorkspaceUri(workspaceFolder.uri, candidatePath);
                const exists = await this.uriExists(directCandidateUri);
                if (exists) {
                    return [directCandidateUri];
                }
            }

            try {
                const files = await vscode.workspace.fs.readDirectory(workspaceFolder.uri);
                for (const [fileName, fileType] of files) {
                    if (fileType !== vscode.FileType.Directory) {
                        continue;
                    }

                    const nestedFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
                    for (const candidatePath of candidatePaths) {
                        const nestedCandidateUri = this.buildWorkspaceUri(nestedFolderUri, candidatePath);
                        if (await this.uriExists(nestedCandidateUri)) {
                            return [nestedCandidateUri];
                        }
                    }
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
    async provideDefinition(document, position, token) {
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
            let result = await this.getFilePath(document, match);
            let uri = result.uri || vscode.Uri.file(result.fileAbsPath);
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

    async getFileHover(document, match) {
        let result = await this.getFilePath(document, match);
        let filePath = result.fileAbsPath;
        let uri = result.uri || vscode.Uri.file(filePath);
        let hoverText = `[${filePath}](${uri})`;
        if (result.found) {
            try {
                let fileContents = await this.readTextFile(uri);
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

    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(() => {
            navigator.clearResolutionCaches();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles(() => {
            navigator.clearResolutionCaches();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles(() => {
            navigator.clearResolutionCaches();
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
                navigator.clearResolutionCaches();
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
                navigator.clearResolutionCaches();
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
        navigatorInstance.clearResolutionCaches?.();
        navigatorInstance.documentationCache?.clear();
        navigatorInstance.pendingFetches?.clear();
        navigatorInstance.activeHovers?.clear();
    }
    navigatorInstance = null;
}

module.exports = { activate, deactivate };
