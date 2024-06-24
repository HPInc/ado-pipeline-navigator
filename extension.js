const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const console = require('console');
const yaml = require('js-yaml')
const axios = require('axios');
const cheerio = require('cheerio');

let decorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline',
    overviewRulerColor: 'blue',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    cursor: 'pointer',
    color: '#FFD580',
    after: {
        fontWeight: 'bold'
    },
    light: {
        color: 'darkorange',
        borderColor: 'darkblue'
    },
    dark: {
        color: 'lightorange',
        borderColor: 'lightblue'
    }
});

class AdoPipelineNavigator {
    pattern = /([-# ]{1,}[ ]{1,}(template|file|task)[ ]{0,}[: ]{1,})([^#\r\n]+)/;
    internetFetch = true;
    replaceStrings = true;
    keywordsToDisplayOnHover = [];
    replacementStrings = [];
    quickReplaceStringsCount = 1;

    constructor() {
        let featureToggles = getFeatureTogglesConfig();
        let updated = false;
        if (featureToggles['InternetFetch'] === undefined) {
            featureToggles['InternetFetch'] = true;
            updated = true;
        }
        if (featureToggles['ReplaceStrings'] === undefined) {
            featureToggles['ReplaceStrings'] = true;
            updated = true;
        }

        if (updated) {
            vscode.workspace.getConfiguration('ado-pipeline-navigator').update('featureToggles', featureToggles, vscode.ConfigurationTarget.Global);
        }
        this.internetFetch = featureToggles['InternetFetch'];
        this.replaceStrings = featureToggles['ReplaceStrings'];
        let config = vscode.workspace.getConfiguration('ado-pipeline-navigator');
        this.keywordsToDisplayOnHover = config.get('keywordsToDisplayOnHover')
        if (this.keywordsToDisplayOnHover === undefined) {
            this.keywordsToDisplayOnHover =  ['parameters', 'stages', 'jobs', 'steps'];
            vscode.workspace.getConfiguration('ado-pipeline-navigator').update('keywordsToDisplayOnHover', this.keywordsToDisplayOnHover, vscode.ConfigurationTarget.Global);
        }

        this.quickReplaceStringsCount = vscode.workspace.getConfiguration('ado-pipeline-navigator').get('quickReplaceStringsCount');
        if (this.quickReplaceStringsCount === undefined) {
            this.quickReplaceStringsCount = 1;
            vscode.workspace.getConfiguration('ado-pipeline-navigator').update('quickReplaceStringsCount', this.quickReplaceStringsCount, vscode.ConfigurationTarget.Global);
        }

        // Backward compatibility for the replacementStrings
        this.replacementStrings = config.get('replacementStrings');
        if (this.replacementStrings === undefined) {
            let pathReplacements = vscode.workspace.getConfiguration('adopipeline').get('pathReplacements');
            if (pathReplacements !== undefined) {
                vscode.workspace.getConfiguration('ado-pipeline-navigator').update('replacementStrings', pathReplacements, vscode.ConfigurationTarget.Global);
                this.replacementStrings = pathReplacements;
            } else {
                this.replacementStrings.push({ find: '', replace: '' })
            }
        }
    }

    getFilePath(document, match) {
        let rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath : '';
        let fileAbsPath;
        let filePath = match[3].trim();

        if (filePath.includes('@')) {
            filePath = filePath.substring(0, filePath.indexOf('@'));
        }

        if (this.replaceStrings) {
            filePath = this.updateFilePathFromConfig(filePath);
        }

        let found = false;
        if (filePath.startsWith('./') || filePath.startsWith('../')) {
            fileAbsPath = path.join(path.dirname(document.uri.fsPath), filePath);
            if (fs.existsSync(fileAbsPath)) {
                found = true;
            }
        } else {
            fileAbsPath = path.join(rootPath, filePath);
            if (fs.existsSync(fileAbsPath)) {
                found = true;
            } else {
                for (let workspaceFolder of vscode.workspace.workspaceFolders) {
                    fileAbsPath = path.join(workspaceFolder.uri.fsPath, filePath);
                    if (fs.existsSync(fileAbsPath)) {
                        found = true;
                        break;
                    }
                }
            }
        }

        return { found, fileAbsPath };
    }

    updateFilePathFromConfig(filePath) {
        this.replacementStrings.forEach(replacement => {
            filePath = filePath.replace(replacement.find, replacement.replace);
        });

        return filePath;
    }

    getTaskUrl(task) {
        if (task.includes('@')) {
            let urlFmt = 'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/{0}?view=azure-devops';
            let version = task.substring(task.indexOf('@') + 1);
            let taskName = task.substring(0, task.indexOf('@')).replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() + '-v' + version;
            return urlFmt.replace('{0}', taskName);
        }
        return undefined;
    }

    async getTaskDoc(url) {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        const syntaxSection = $('#syntax')
        const usage = syntaxSection.nextAll('div').find('pre > code').first().text().trim();
        return usage
    }

    // Adding the links and decorations for the matched text with underscore and text formatting
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

            let decorate = false
            let url = undefined
            switch (match[2].trim()) {
                case 'task':
                    decorate = true
                    url = this.getTaskUrl(match[3].trim())
                    break;
                case 'file':
                case 'template':
                    decorate = true
                    break;
                default:
                    break;
            }

            if (decorate) {
                let range = new vscode.Range(line, match.index + match[1].length, line, match.index + match[0].trimEnd().length);
                if (url !== undefined) {
                    const link = new vscode.DocumentLink(range, vscode.Uri.parse(url));
                    links.push(link);
                }
                let decoration = { range: range };
                decorations.push(decoration);
            }
        }

        if (vscode.window.activeTextEditor) {
            vscode.window.activeTextEditor.setDecorations(decorationType, decorations);
            vscode.window.activeTextEditor.setDocumentLinks(links);
        }
        return links;
    }

    // Open the file or task documentation on ctrl+click or F12
    provideDefinition(document, position, token) {
        let line = document.lineAt(position.line);
        let match = line.text.match(this.pattern);

        if (!match) {
            return null;
        }

        switch (match[2].trim()) {
            case 'task':
                let url = this.getTaskUrl(match[3].trim())
                if (url !== undefined) {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            case 'file':
            case 'template':
                let result = this.getFilePath(document, match);
                let uri = vscode.Uri.file(result.fileAbsPath);
                return new vscode.Location(uri, new vscode.Position(0, 0));
            default:
                break;
        }
        return null;
    }

    // Show the hover text on mouse hover for the resolved path, task document or error info
    async provideHover(document, position, token) {
        let line = document.lineAt(position.line);
        let match = line.text.match(this.pattern);
        if (!match) {
            return null;
        }

        let hoverText = '';
        switch (match[2].trim()) {
            case 'task':
                let url = this.getTaskUrl(match[3].trim())
                if (url !== undefined) {
                    if (!this.internetFetch) {
                        hoverText = '`InternetFetch` feature is disabled. Enable it from command palette to fetch task documentation\n\n`ADO Pipeline Navigator: InternetFetch`';
                        break;
                    }
                    try {
                        let usage = await this.getTaskDoc(url);
                        hoverText = `**Task Documentation:** [Learn more](${url})\n\n`;
                        hoverText += `\`\`\`yaml\n${usage}\n\`\`\``;
                    } catch (error) {
                        hoverText = `Error fetching task documentation: ${error.message}`;
                    }
                }
                break;
            case 'file':
            case 'template':
                let result = this.getFilePath(document, match);
                let filePath = result.fileAbsPath;
                let uri = vscode.Uri.file(filePath);
                hoverText = `[${filePath}](${uri})`;
                if (result.found) {
                    let fileContents = fs.readFileSync(filePath, 'utf8');
                    try {
                        let yamlContents = yaml.load(fileContents);
                        let displayItems = {}
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
                        hoverText += ' `ReplaceStrings` feature is disabled. Enable it from command palette to replace strings in file path\n\n`ADO Pipeline Navigator: ReplaceStrings`';
                    }
                }
                break;
            default:
                break;
        }
        if (hoverText !== '') {
            return new vscode.Hover(new vscode.MarkdownString(hoverText));
        }
        return null;
    }
}

async function replacementStringsCommand(adoPipelineNavigator) {
    let updated = false;

    let replacementStrings = adoPipelineNavigator.replacementStrings;

    let maxIterations = Math.min(adoPipelineNavigator.quickReplaceStringsCount, replacementStrings.length);
    for (let i = 0; i < maxIterations; i++) {
        let replacement = replacementStrings[i];

        let find = await vscode.window.showInputBox({ prompt: 'Enter the string to find for replacement', value: replacement.find });
        let replace = await vscode.window.showInputBox({ prompt: 'Enter the replacement string', value: replacement.replace });

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
    let featureToggles = config.get('featureToggles') || {'InternetFetch': undefined, 'ReplaceStrings': undefined};
    return featureToggles;
}

async function featureTogglesCommand(adoPipelineNavigator) {
    let featureToggles = getFeatureTogglesConfig();
    let featureTogglesMap = Object.entries(featureToggles).map(([featureName, isEnabled]) => ({
        label: `${isEnabled ? '✅' : '❌'} ${featureName}`,
        featureName,
        isEnabled
    }));

    const selected = await vscode.window.showQuickPick(featureTogglesMap, {
        placeHolder: 'Select a feature to toggle',
    });

    if (selected) {
        featureToggles[selected.featureName] = !selected.isEnabled;
        let config = vscode.workspace.getConfiguration('ado-pipeline-navigator');
        await config.update('featureToggles', featureToggles, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Feature "${selected.featureName}" is now ${featureToggles[selected.featureName] ? 'enabled' : 'disabled'}.`);
    }
}

function activate(context) {
    let adoPipelineNavigator = new AdoPipelineNavigator();

    let languages = ['azure-pipelines', 'yaml', 'markdown', 'plaintext']
    for (let language of languages) {
        context.subscriptions.push(vscode.languages.registerDocumentLinkProvider({ language: language }, adoPipelineNavigator));
        context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: language }, adoPipelineNavigator));
        context.subscriptions.push(vscode.languages.registerHoverProvider({ language: language }, adoPipelineNavigator));
    }

    let commandFunctionMap = { 'replacementStringsCommand': replacementStringsCommand, 'featureTogglesCommand': featureTogglesCommand}
    for (let command in commandFunctionMap) {
        context.subscriptions.push(vscode.commands.registerCommand(`ado-pipeline-navigator.${command}`, commandFunctionMap[command].bind(null, adoPipelineNavigator)));
    }

    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('ado-pipeline-navigator.replaceStrings')) {
            if (vscode.window.activeTextEditor) {
                adoPipelineNavigator.provideDocumentLinks(vscode.window.activeTextEditor.document, null);
            }
        }
        // Update the feature toggles when the settings are changed
        if (event.affectsConfiguration('ado-pipeline-navigator.featureToggles')) {
            let featureToggles = getFeatureTogglesConfig();
            adoPipelineNavigator.internetFetch = featureToggles['InternetFetch'];
            adoPipelineNavigator.replaceStrings = featureToggles['ReplaceStrings'];
        }
    });
}


exports.activate = activate;

function deactivate() { }

module.exports = {
    activate,
    deactivate
}
