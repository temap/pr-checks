# PR Checks Action

A GitHub Action that manages required checks based on GitHub repository rulesets and file changes in pull requests. This action extracts required status checks from specified rulesets and automatically marks checks as successful when:

- Workflow path filters don't match any changed files
- The job doesn't exist in any workflow in the repository

## Features

- **Ruleset Integration**: Reads required status checks directly from GitHub repository rulesets
- **Path Filtering**: Automatically detects path filters from workflow configurations
- **Conditional Check Enforcement**: Marks checks as successful when no relevant files are changed
- **Missing Job Handling**: Automatically marks jobs as successful if they don't exist in any workflow
- **Workflow Discovery**: Automatically finds workflows containing specified job name

## Use Cases

- Monorepo setups where different services have separate test suites
- Projects with multiple components that don't always need to run all checks
- Reducing CI costs by skipping irrelevant checks
- Managing required checks through GitHub rulesets
- Handling cases where required checks might not exist in all branches or configurations

## Usage

### Prerequisites

1. Create GitHub repository rulesets with required status checks
2. Configure your workflows with appropriate path filters
3. Set up this action to process the rulesets

### Basic Example

```yaml
name: PR Path Filter
on:
  pull_request:

jobs:
  filter-checks:
    runs-on: ubuntu-latest
    permissions:
      statuses: write
      pull-requests: read
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Run Path-Based Checks
        uses: temap/pr-checks@v1
        with:
          rulesets: |
            main-branch-protection
```

### Setting Up Repository Rulesets

1. Go to Settings → Rules → Rulesets in your GitHub repository
2. Create a new ruleset (e.g., "main-branch-protection")
3. Add "Require status checks to pass" rule
4. Configure the required status checks (e.g., "frontend-tests", "backend-tests")

### How It Works

1. The action fetches the specified rulesets from your repository
2. It extracts all required status checks from these rulesets
3. For each required check:
   - If a workflow with that job name doesn't exist → marks as successful
   - If the workflow exists but path filters don't match changed files → marks as successful
   - Otherwise → lets the check run normally

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `rulesets` | List of ruleset names to process (one per line) | Yes | - |
| `github-token` | GitHub token for API access | No | `${{ github.token }}` |

## Permissions

This action requires the following permissions:

```yaml
permissions:
  statuses: write      # To create commit statuses
  pull-requests: read  # To read PR information
  contents: read       # To access repository content and rulesets
```
