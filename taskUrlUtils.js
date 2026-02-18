/**
 * Utility function to generate Azure DevOps task documentation URLs
 * @param {string} task - Task name with version (e.g., "NuGetAuthenticate@1")
 * @returns {string|null} - Documentation URL or null if invalid task format
 */
function getTaskUrl(task) {
    if (!task.includes('@')) return null;

    const [taskName, version] = task.split('@');

    let formattedTaskName = taskName;

    // First, handle compound brand/product names by treating them as single units
    // These should not be split with hyphens
    formattedTaskName = formattedTaskName
        .replace(/DotNet/g, 'Dotnet') // DotNetCoreCLI → DotnetCoreCLI → dotnet-core-cli
        .replace(/NuGet/g, 'Nuget') // NuGetAuthenticate → NugetAuthenticate → nuget-authenticate
        .replace(/PowerShell/g, 'Powershell') // PowerShell → Powershell → powershell
        .replace(/VSBuild/g, 'Vsbuild') // VSBuild → Vsbuild → vsbuild
        .replace(/VSTest/g, 'Vstest') // VSTest → Vstest → vstest
        .replace(/MSBuild/g, 'Msbuild') // MSBuild → Msbuild → msbuild
        .replace(/PyPI/g, 'Pypi'); // PyPI → Pypi → pypi

    // Now convert camelCase to kebab-case then lowercase
    // Microsoft Learn URLs use kebab-case format (e.g., nuget-authenticate, install-ssh-key)
    formattedTaskName = formattedTaskName
        .replace(/([a-z])([A-Z])/g, '$1-$2') // Add hyphen between lowercase and uppercase
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2') // Add hyphen between consecutive uppercase followed by lowercase
        .toLowerCase();

    return `https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/${formattedTaskName}-v${version}?view=azure-pipelines`;
}

module.exports = { getTaskUrl };
