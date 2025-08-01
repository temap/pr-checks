import * as core from '@actions/core';
import * as github from '@actions/github';
import * as yaml from 'js-yaml';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { minimatch } from 'minimatch';

interface WorkflowConfig {
  on?: {
    pull_request?: {
      paths?: string[];
    };
  };
  jobs?: {
    [key: string]: any;
  };
}

interface GitHubRuleset {
  id: number;
  name: string;
  target: string;
  source_type?: string;
  source?: string;
  enforcement: string;
  bypass_actors?: any[];
  conditions?: any;
  rules?: any[];
}

interface RequiredStatusChecksRule {
  type: string;
  parameters?: {
    required_status_checks: Array<{
      context: string;
      integration_id?: number;
    }>;
    strict_required_status_checks_policy: boolean;
  };
}

async function run(): Promise<void> {
  try {
    const rulesetsInput = core.getInput('rulesets', { required: true });
    const githubToken = core.getInput('github-token', { required: true });

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    if (context.eventName !== 'pull_request') {
      core.info('This action only runs on pull_request events');
      return;
    }

    // Parse ruleset names from input
    const requestedRulesetNames = rulesetsInput
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .map((line: string) => {
        // Remove surrounding quotes (single or double)
        if ((line.startsWith("'") && line.endsWith("'")) || 
            (line.startsWith('"') && line.endsWith('"'))) {
          return line.slice(1, -1);
        }
        return line;
      });

    core.info(`Requested rulesets: ${requestedRulesetNames.join(', ')}`);

    // Fetch all repository rulesets
    core.info('Fetching repository rulesets...');
    const { data: allRulesets } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', {
      owner: context.repo.owner,
      repo: context.repo.repo,
      includes_parents: true
    });

    // Filter rulesets by requested names
    const rulesets = allRulesets.filter(ruleset =>
      requestedRulesetNames.includes(ruleset.name)
    );

    core.info(`Found ${rulesets.length} matching rulesets out of ${allRulesets.length} total`);

    // Extract all required status checks from rulesets
    const allChecks = new Set<string>();

    for (const ruleset of rulesets) {
      core.info(`Processing ruleset: ${ruleset.name} (ID: ${ruleset.id})`);

      // Fetch detailed ruleset information
      const { data: rulesetDetails } = await octokit.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ruleset_id: ruleset.id
      });

      // Extract required status checks from rules
      if (rulesetDetails.rules) {
        for (const rule of rulesetDetails.rules) {
          if (rule.type === 'required_status_checks' && rule.parameters?.required_status_checks) {
            for (const check of rule.parameters.required_status_checks) {
              allChecks.add(check.context);
              core.info(`  - Found required check: ${check.context}`);
            }
          }
        }
      }
    }

    const checks = Array.from(allChecks);
    core.info(`Total required checks found: ${checks.join(', ')}`);

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request!.number,
      per_page: 100
    });

    const changedPaths = files.map((file: any) => file.filename);
    core.info(`Changed files in PR: ${changedPaths.join(', ')}`);

    const workflowsDir = '.github/workflows';
    const workflowFiles = getWorkflowFiles(workflowsDir);

    for (const check of checks) {
      const workflow = findWorkflowWithJob(workflowFiles, check);

      if (!workflow) {
        // Job not found in any workflow, mark as success
        core.info(`No workflow found with job '${check}', marking as successful`);

        await octokit.rest.checks.create({
          owner: context.repo.owner,
          repo: context.repo.repo,
          name: check,
          head_sha: context.payload.pull_request!.head.sha,
          status: 'completed',
          conclusion: 'success',
          output: {
            title: 'Check marked as successful',
            summary: `This check was automatically marked as successful because no workflow with job '${check}' was found in the repository.`
          }
        });

        core.info(`Successfully created check run for '${check}'`);
        continue;
      }

      core.info(`Found workflow for check '${check}': ${workflow.file}`);

      // Check if any changed paths match the workflow's path filters
      const pathFilters = workflow.config.on?.pull_request?.paths || [];

      if (pathFilters.length === 0) {
        core.info(`No path filters defined for workflow with job '${check}'`);
        continue;
      }

      const matchesFilter = changedPaths.some((changedPath: string) =>
        pathFilters.some(filter => minimatch(changedPath, filter))
      );

      if (!matchesFilter) {
        core.info(`No changed paths match filters for '${check}', marking as successful`);

        // Create a successful check run
        await octokit.rest.checks.create({
          owner: context.repo.owner,
          repo: context.repo.repo,
          name: check,
          head_sha: context.payload.pull_request!.head.sha,
          status: 'completed',
          conclusion: 'success',
          output: {
            title: 'Check skipped due to path filters',
            summary: `This check was automatically marked as successful because no changed files match the ${workflow.file} workflow path filters.\n\nPath filters: ${pathFilters.join(', ')}`
          }
        });

        core.info(`Successfully created check run for '${check}'`);
      } else {
        core.info(`Changed paths match filters for '${check}', check will run normally`);
      }
    }

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred');
    }
  }
}

function getWorkflowFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isFile() && (entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    core.warning(`Failed to read workflow directory: ${error}`);
  }

  return files;
}

function findWorkflowWithJob(
  workflowFiles: string[],
  jobName: string
): { file: string; config: WorkflowConfig } | null {
  for (const file of workflowFiles) {
    try {
      const content = readFileSync(file, 'utf8');
      const config = yaml.load(content) as WorkflowConfig;

      if (config.jobs) {
        // Check for exact match first
        if (jobName in config.jobs) {
          return { file: basename(file), config };
        }
        
        // Normalize the job name for comparison
        const normalizedJobName = jobName.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
        
        // Check if the job name exists with different spacing/formatting
        for (const [key, job] of Object.entries(config.jobs)) {
          // Normalize the key for comparison
          const normalizedKey = key.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
          
          // Check if normalized keys match
          if (normalizedKey === normalizedJobName) {
            return { file: basename(file), config };
          }
          
          // If job has a name property, use it for comparison
          if (job && typeof job === 'object' && 'name' in job) {
            const normalizedJobNameProp = String(job.name).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
            if (normalizedJobNameProp === normalizedJobName) {
              return { file: basename(file), config };
            }
          }
        }
      }
    } catch (error) {
      core.warning(`Failed to parse workflow file ${file}: ${error}`);
    }
  }

  return null;
}

run();
