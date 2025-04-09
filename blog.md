Simplifying Azure DevOps Pipeline Workflows with ADO Pipeline Navigator
Managing Azure DevOps YAML pipelines can be challenging, especially when dealing with complex pipelines involving multiple templates, tasks, and parameters. Enter the ADO Pipeline Navigator, a Visual Studio Code extension designed to streamline and enhance your workflow. In this blog, we'll explore how this extension can revolutionize the way you work with Azure DevOps pipelines.
The Challenge
Consider a scenario where you're tasked with updating a complex pipeline involving multiple templates and tasks. Typically, a microservice pipeline contains templates for linting, building artifacts, scanning for vulnerabilities in artifacts, creating Docker images, scanning for vulnerabilities in images, publishing images, and deploying images. To simplify this complexity for most developers, a top-level template is often created, which includes multiple sub-templates for each action. Developers only need to include this top-level template in their pipeline file and pass the required parameters.
While this approach simplifies the process for developers, it makes understanding or modifying the pipeline challenging due to the multiple templates and tasks involved.
The Solution: ADO Pipeline Navigator
The ADO Pipeline Navigator extension is a game-changer for developers working with Azure DevOps pipelines. It integrates seamlessly with Visual Studio Code, offering various features to simplify and enhance your workflow.
Syntax highlighting
Once the extension is installed, your files will automatically display decorations and clickable links, where applicable. These decorations use underlines and colors to indicate recognized paths, tasks, and templates:
Template Navigation and Preview file
Clickable links are decorated with yellow color with an underline. Hovering overing it shows the resolved path. It also previews the contents of the template/file. By default, parameters, stages, jobs, and steps are previewed. The keywords that need to previewed can be configurated from settings(ado-pipeline-navigator.keywordsToDisplayOnHover). This will show the resolved path and the contents of it without opening template file. This will be typically useful in knowing the parameters to a template without opening the template file. Use Ctrl+click or F12 to switch to the referenced path
Document Fetching
Microsoft Azure Pipeline tasks also will be decorated with yellow color and underline. Hovering over a task name will fetch the documentation for the internet. Ctrl+click or F12 on it will open the documentation link in browser
Dynamic String Replacements
If your template path contains variable like for e.g. templates/${{ parameters.language }}/build.yaml, you could dynamically change its value from command palette (Ctrl+Shift+P) and select ADO Pipeline Navigator: Replacement Strings and add the find/replace strings. This will come in handy when you have language specific configuration, and you want to set to a specific language
Feature Toggles
Internet Fetch: Enable or disable fetching documentation from the internet.
String Replacements: Enable or disable dynamic string replacements.

How to Get Started
Installation
Install the ADO Pipeline Navigator extension from the Visual Studio Code marketplace.
If the templates are in a different repo, make sure to add that also to the workspace or include that repo in one of the folder

Activating the Extension
Note: Please make sure that the Language Mode in Status bar (Towards bottom right corner of VSCode -> Select Lanaguage Mode) is set to "Plain Text", "Terraform", "Terragrunt" or "hcl" for the .hcl and .tf file
The extension activates automatically when you open a YAML file in your workspace.
Conclusion
The ADO Pipeline Navigator extension is more than just a tool; it's a productivity enhancer for developers working with Azure DevOps pipelines. By simplifying navigation, improving understanding, it allows you to focus on what truly matters - building and managing robust CI/CD pipelines.
Try the ADO Pipeline Navigator today and experience the difference it can make in your workflow. Happy coding!
Bugs or feature requests can be added here: [Issues · ado-pipeline-navigator]. Please note this is a side project, so expect delays.
