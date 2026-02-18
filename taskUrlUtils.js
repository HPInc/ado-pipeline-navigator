/**
 * Utility function to generate Azure DevOps task documentation URLs
 * @param {string} task - Task name with version (e.g., "NuGetAuthenticate@1")
 * @returns {string|null} - Documentation URL or null if invalid task format
 */
function getTaskUrl(task) {
    if (!task.includes('@')) return null;

    const [taskName, version] = task.split('@');

    let formattedTaskName = taskName;

    // Handle special multi-capital prefixes (NuGet, PyPI, DotNet)
    // Convert them to single-capital format for proper kebab-case conversion
    // NuGet -> Nuget, PyPI -> Pypi, DotNet -> Dotnet
    formattedTaskName = formattedTaskName
        .replace(/^NuGet/g, 'Nuget')
        .replace(/^PyPI/g, 'Pypi')
        .replace(/DotNet/g, 'Dotnet');

    // Handle consecutive uppercase letters (acronyms)
    // First: Handle acronyms at start followed by uppercase: VSBuild -> vs-Build
    formattedTaskName = formattedTaskName.replace(/^([A-Z]{2,})([A-Z][a-z])/g, (match, acronym, nextChar) => {
        return acronym.toLowerCase() + '-' + nextChar;
    });

    // Handle acronyms in middle: AzureCLI -> Azure-CLI, InstallSSHKey -> Install-SSH-Key
    formattedTaskName = formattedTaskName.replace(
        /([a-z])([A-Z]{2,})([A-Z][a-z]|$)/g,
        (match, before, acronym, after) => {
            return before + '-' + acronym.toLowerCase() + (after ? '-' + after : '');
        }
    );

    // Apply standard camelCase to kebab-case conversion
    formattedTaskName = formattedTaskName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

    return `https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/${formattedTaskName}-v${version}?view=azure-pipelines`;
}

module.exports = { getTaskUrl };
