const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_FEATURE_TOGGLES = { InternetFetch: false, ReplaceStrings: true };
const DEFAULT_KEYWORDS = ['parameters', 'stages', 'jobs', 'steps'];
const DEFAULT_QUICK_REPLACE_COUNT = 1;

class AdoPipelineNavigator {
    constructor() {
        this.pattern = /([-# ]+ +(template|file|task) *[: ]+)([^#\r\n]+)/;
        this.decorationType = this.createDecorationType();
        this.loadConfiguration();
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
            if (pathReplacements) {
                this.replacementStrings = pathReplacements;
            } else {
                this.replacementStrings.push({ find: '', replace: '' });
            }
        }
    }

    getFilePath(document, match) {
        const rootPath = vscode.workspace.workspaceFolders
            ? vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath
            : '';
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
            let files = fs.readdirSync(workspaceFolder.uri.fsPath);
            let dirs = files.filter(
                (file) =>
                    fs.statSync(path.join(workspaceFolder.uri.fsPath, file)).isDirectory() &&
                    fs.existsSync(path.join(workspaceFolder.uri.fsPath, file, filePath)),
            );
            if (dirs.length > 0) {
                return [path.join(workspaceFolder.uri.fsPath, dirs[0], filePath)];
            }
        }

        return [];
    }

    async fetchTaskDocumentation(url) {
        try {
            const response = await axios.get(url);
            const $ = cheerio.load(response.data);
            const syntaxSection = $('#syntax');
            return syntaxSection.nextAll('div').find('pre > code').first().text().trim();
        } catch (error) {
            console.error(`Error fetching task documentation: ${error.message}`);
            return null;
        }
    }

    provideDocumentLinks(document, token) {
        if (!document) {
            return;
        }

        let decorations = [];
        let links = [];
        for (let line = 0; line < document.lineCount; line++) {
            let textLine = document.lineAt(line);
            let match = textLine.text.match(this.pattern);

            if (!match) {
                continue;
            }

            let url = null;
            let decorate = true;
            switch (match[2].trim()) {
                case 'task':
                    url = this.getTaskUrl(match[3].trim());
                    break;
                case 'file':
                case 'template':
                    break;
                default:
                    decorate = false;
                    break;
            }

            if (decorate) {
                let range = new vscode.Range(
                    line,
                    match.index + match[1].length,
                    line,
                    match.index + match[0].trimEnd().length,
                );
                decorations.push({ range: range });
                if (url) {
                    links.push(new vscode.DocumentLink(range, vscode.Uri.parse(url)));
                }
            }
        }

        if (vscode.window.activeTextEditor) {
            vscode.window.activeTextEditor.setDecorations(this.decorationType, decorations);
        }

        return links;
    }

    // Open the file or task documentation on ctrl+click or F12
    provideDefinition(document, position, token) {
        if (!document) {
            return;
        }

        let line = document.lineAt(position.line);
        let match = line.text.match(this.pattern);

        if (!match) {
            return null;
        }

        switch (match[2].trim()) {
            case 'task': {
                let url = this.getTaskUrl(match[3].trim());
                if (url !== undefined) {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            }
            case 'file':
            case 'template': {
                let result = this.getFilePath(document, match);
                let uri = vscode.Uri.file(result.fileAbsPath);
                return new vscode.Location(uri, new vscode.Position(0, 0));
            }
            default:
                break;
        }
        return null;
    }

    // Show the hover text on mouse hover for the resolved path, task document or error info
    async provideHover(document, position) {
        if (!document) {
            return null;
        }
        const line = document.lineAt(position.line);
        const match = line.text.match(this.pattern);
        if (!match) return null;

        switch (match[2].trim()) {
            case 'task':
                return this.getTaskHover(match[3].trim());
            case 'file':
            case 'template':
                return this.getFileHover(document, match);
            default:
                return null;
        }
    }

    async getTaskHover(task) {
        const url = this.getTaskUrl(task);
        if (!url) return null;

        if (!this.featureToggles.InternetFetch) {
            return new vscode.Hover('`InternetFetch` is disabled. Enable it to fetch task documentation.');
        }

        const usage = await this.fetchTaskDocumentation(url);
        if (!usage) return null;

        return new vscode.Hover(
            new vscode.MarkdownString(`**Task Documentation:** [Learn more](${url})\n\n\`\`\`yaml\n${usage}\n\`\`\``),
        );
    }

    getTaskUrl(task) {
        if (!task.includes('@')) return null;

        const [taskName, version] = task.split('@');
        const formattedTaskName = taskName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

        return `https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/${formattedTaskName}-v${version}?view=azure-devops`;
    }

    getFileHover(document, match) {
        let result = this.getFilePath(document, match);
        let filePath = result.fileAbsPath;
        let uri = vscode.Uri.file(filePath);
        let hoverText = `[${filePath}](${uri})`;
        if (result.found) {
            let fileContents = fs.readFileSync(filePath, 'utf8');
            try {
                let yamlContents = yaml.load(fileContents);
                let displayItems = {};
                for (let keyword of this.keywordsToDisplayOnHover) {
                    if (Object.keys(yamlContents[keyword] || {}).length > 0) {
                        displayItems[keyword] = yamlContents[keyword];
                    }
                }
                let parameters = yaml.dump(displayItems, { indent: 2, noArrayIndent: true });
                hoverText += `\n\`\`\`yaml\n${parameters}\n\`\`\``;
            } catch (error) {
                hoverText += '\n\nparameters not found';
            }
        } else {
            hoverText += '\n\nFile not found.';
            if (!this.replaceStrings) {
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
            `Feature "${selected.featureName}" is now ${featureToggles[selected.featureName] ? 'enabled' : 'disabled'}.`,
        );
    }
}

function activate(context) {
    console.log('ADO Pipeline Navigator is now active!');
    const navigator = new AdoPipelineNavigator();

    const languages = ['azure-pipelines', 'yaml', 'markdown', 'plaintext'];
    languages.forEach((language) => {
        context.subscriptions.push(vscode.languages.registerDocumentLinkProvider({ language }, navigator));
        context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language }, navigator));
        context.subscriptions.push(vscode.languages.registerHoverProvider({ language }, navigator));
    });

    let commandFunctionMap = {
        replacementStringsCommand: replacementStringsCommand,
        featureTogglesCommand: featureTogglesCommand,
    };
    for (let command in commandFunctionMap) {
        context.subscriptions.push(
            vscode.commands.registerCommand(
                `ado-pipeline-navigator.${command}`,
                commandFunctionMap[command].bind(null, navigator),
            ),
        );
    }

    vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('ado-pipeline-navigator.replaceStrings')) {
            if (vscode.window.activeTextEditor) {
                navigator.provideDocumentLinks(vscode.window.activeTextEditor.document, null);
            }
        }
        // Update the feature toggles when the settings are changed
        if (event.affectsConfiguration('ado-pipeline-navigator.featureToggles')) {
            navigator.featureToggles = getFeatureTogglesConfig();
        }
    });
}

module.exports = { activate };
