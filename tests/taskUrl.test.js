const { getTaskUrl } = require('../taskUrlUtils');

// Test cases with expected URLs
const testCases = [
    // NuGet tasks
    {
        task: 'NuGetAuthenticate@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/nuget-authenticate-v1?view=azure-pipelines',
    },
    {
        task: 'NuGetCommand@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/nuget-command-v2?view=azure-pipelines',
    },
    {
        task: 'NuGetToolInstaller@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/nuget-tool-installer-v1?view=azure-pipelines',
    },
    // VS/MS tasks
    {
        task: 'VSBuild@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/vsbuild-v1?view=azure-pipelines',
    },
    {
        task: 'MSBuild@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/msbuild-v1?view=azure-pipelines',
    },
    {
        task: 'VSTest@3',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/vstest-v3?view=azure-pipelines',
    },
    // DotNet tasks
    {
        task: 'DotNetCoreCLI@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/dotnet-core-cli-v2?view=azure-pipelines',
    },
    {
        task: 'UseDotNet@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/use-dotnet-v2?view=azure-pipelines',
    },
    // CLI acronym tasks
    {
        task: 'AzureCLI@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-cli-v2?view=azure-pipelines',
    },
    // SSH acronym tasks
    {
        task: 'InstallSSHKey@0',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/install-ssh-key-v0?view=azure-pipelines',
    },
    // PyPI tasks
    {
        task: 'PyPIPublisher@0',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/pypi-publisher-v0?view=azure-pipelines',
    },
    // Regular camelCase tasks
    {
        task: 'PublishBuildArtifacts@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/publish-build-artifacts-v1?view=azure-pipelines',
    },
    {
        task: 'DownloadPipelineArtifact@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/download-pipeline-artifact-v2?view=azure-pipelines',
    },
    {
        task: 'PublishTestResults@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/publish-test-results-v2?view=azure-pipelines',
    },
    {
        task: 'UsePythonVersion@0',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/use-python-version-v0?view=azure-pipelines',
    },
    {
        task: 'UseNode@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/use-node-v1?view=azure-pipelines',
    },
    {
        task: 'NodeTool@0',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/node-tool-v0?view=azure-pipelines',
    },
    // Azure tasks
    {
        task: 'AzurePowerShell@5',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-powershell-v5?view=azure-pipelines',
    },
    {
        task: 'AzureKeyVault@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-key-vault-v2?view=azure-pipelines',
    },
    {
        task: 'AzureWebApp@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/azure-web-app-v1?view=azure-pipelines',
    },
    // Utility tasks
    {
        task: 'BatchScript@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/batch-script-v1?view=azure-pipelines',
    },
    {
        task: 'ShellScript@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/shell-script-v2?view=azure-pipelines',
    },
    {
        task: 'CopyFiles@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/copy-files-v2?view=azure-pipelines',
    },
    {
        task: 'ArchiveFiles@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/archive-files-v2?view=azure-pipelines',
    },
    // Docker tasks
    {
        task: 'Docker@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/docker-v2?view=azure-pipelines',
    },
    {
        task: 'DockerCompose@0',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/docker-compose-v0?view=azure-pipelines',
    },
    // Kubernetes tasks
    {
        task: 'KubernetesManifest@1',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/kubernetes-manifest-v1?view=azure-pipelines',
    },
    // PowerShell/Bash
    {
        task: 'PowerShell@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/powershell-v2?view=azure-pipelines',
    },
    {
        task: 'Bash@3',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/bash-v3?view=azure-pipelines',
    },
    // Command line
    {
        task: 'CmdLine@2',
        expected:
            'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/cmd-line-v2?view=azure-pipelines',
    },
];

// Run tests
function runTests() {
    let passed = 0;
    let failed = 0;
    const failures = [];

    console.log('Running Task URL Tests...\n');

    testCases.forEach(({ task, expected }) => {
        const actual = getTaskUrl(task);

        if (actual === expected) {
            passed++;
            console.log(`✓ ${task}`);
        } else {
            failed++;
            console.log(`✗ ${task}`);
            console.log(`  Expected: ${expected}`);
            console.log(`  Actual:   ${actual}`);
            failures.push({ task, expected, actual });
        }
    });

    console.log('\n' + '='.repeat(80));
    console.log(`Results: ${passed} passed, ${failed} failed out of ${testCases.length} tests`);

    if (failed > 0) {
        console.log('\nFailed tests:');
        failures.forEach(({ task, expected, actual }) => {
            console.log(`\n  ${task}`);
            console.log(`    Expected: ${expected}`);
            console.log(`    Actual:   ${actual}`);
        });
    }

    return failed === 0;
}

// Run the tests
const success = runTests();
process.exit(success ? 0 : 1);
