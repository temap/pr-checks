import path from 'node:path';
import fs from 'node:fs';

import * as yaml from 'js-yaml';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {minimatch} from 'minimatch';

interface WorkflowConfig {
    on?: {
        pull_request?: {
            paths?: string[];
        };
    };
    jobs?: Record<PropertyKey, unknown>;
}

async function createCommitStatusWithRetry(
    octokit: ReturnType<typeof github.getOctokit>,
    params: {
        owner: string;
        repo: string;
        sha: string;
        state: 'error' | 'failure' | 'pending' | 'success';
        context: string;
        description?: string;
    },
    maxRetries: number = 3
): Promise<void> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await octokit.rest.repos.createCommitStatus(params);
            core.info(`Successfully created status for '${params.context}' on attempt ${attempt}`);
            return;
        } catch (error) {
            lastError = error as Error;
            core.warning(`Failed to create status for '${params.context}' on attempt ${attempt}/${maxRetries}: ${lastError.message}`);
            
            if (attempt < maxRetries) {
                // Wait before retrying (exponential backoff: 1s, 2s, 4s)
                const waitTime = Math.pow(2, attempt - 1) * 1000;
                core.info(`Waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    
    throw new Error(`Failed to create status for '${params.context}' after ${maxRetries} attempts: ${lastError?.message}`);
}

async function run(): Promise<void> {
    try {
        const githubToken = core.getInput('github_token', {required: true});
        const rulesetsInput = core.getInput('rulesets', {required: true});

        const octokit = github.getOctokit(githubToken);
        const context = github.context;

        if (context.eventName !== 'pull_request' || !context.payload.pull_request) {
            core.info('This action support pull_request events only');
            return;
        }

        // Parse ruleset names from input
        const requestedRulesetNames = rulesetsInput
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        core.info(`Requested rulesets: ${requestedRulesetNames.join(', ')}`);

        core.info('Fetching repository rulesets...');
        const allRulesets = await octokit.paginate(octokit.rest.repos.getRepoRulesets, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            includes_parents: true
        });

        // Filter rulesets by requested names
        const rulesets = allRulesets.filter(ruleset =>
            requestedRulesetNames.includes(ruleset.name)
        );

        core.info(`Found ${rulesets.length} matching rulesets out of ${allRulesets.length} total`);

        const allChecks = new Set<string>();

        for (const ruleset of rulesets) {
            core.info(`Processing ruleset: ${ruleset.name}`);

            const {data: rulesetDetails} = await octokit.rest.repos.getRepoRuleset({
                owner: context.repo.owner,
                repo: context.repo.repo,
                ruleset_id: ruleset.id
            });

            // Extract required status checks from rules
            if (rulesetDetails.rules) {
                for (const rule of rulesetDetails.rules) {
                    if (rule.type === 'required_status_checks' && rule.parameters?.required_status_checks) {
                        for (const check of rule.parameters.required_status_checks) {
                            console.log(check);
                            allChecks.add(check.context);
                            core.info(`  - Found required check: ${check.context}`);
                        }
                    }
                }
            }
        }

        const requiredChecks = Array.from(allChecks);
        core.info(`Found ${requiredChecks.length} required checks: ${requiredChecks.join(', ')}`);
        
        const commitSha = context.payload.pull_request!.head.sha;
        core.info(`Processing checks for commit: ${commitSha}`);

        const workflows = getWorkflowJobs();

        const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
        });

        const changedPaths = files.map((file) => file.filename);
        core.info(`Changed files in PR: ${changedPaths.join(', ')}`);

        for (const check of requiredChecks) {
            const workflowEntry = Object.values(workflows).find(w => w.jobs.includes(check));

            if (!workflowEntry) {
                core.info(`No workflow found with job '${check}', marking as successful for commit ${commitSha}`);

                await createCommitStatusWithRetry(octokit, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    sha: commitSha,
                    state: 'success',
                    context: check,
                    description: `No workflow with job '${check}' found in repository`
                });

                core.info(`Status created for '${check}' on commit ${commitSha}`);
                continue;
            }

            core.info(`Found workflow for check '${check}': ${workflowEntry.file}`);

            // Check if any changed paths match the workflow's path filters
            const pathFilters = workflowEntry.config.on?.pull_request?.paths || [];

            if (pathFilters.length === 0) {
                core.info(`No path filters defined for workflow with job '${check}'`);
                continue;
            }

            const matchesFilter = changedPaths.some((changedPath: string) =>
                pathFilters.some((filter: string) => minimatch(changedPath, filter))
            );

            if (!matchesFilter) {
                core.info(`No changed paths match filters for '${check}', marking as successful for commit ${commitSha}`);

                // Create a successful status
                await createCommitStatusWithRetry(octokit, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    sha: commitSha,
                    state: 'success',
                    context: check,
                    description: `Skipped: no files match ${workflowEntry.file} path filters`
                });

                core.info(`Status created for '${check}' on commit ${commitSha}`);
            } else {
                core.info(`Changed paths match filters for '${check}' on commit ${commitSha}, check will run normally`);
            }
        }
    } catch (error) {
        if (error instanceof Error) {
            core.error(`Action failed: ${error.message}`);
            core.setFailed(error.message);
        } else {
            core.setFailed('Unknown error occurred');
        }
    }
}

interface WorkflowInfo {
    file: string;
    jobs: string[];
    config: any;
}

function getWorkflowJobs(): Record<string, WorkflowInfo> {
    const workflowJobs: Record<string, WorkflowInfo> = {};
    const workflowDir = path.join(process.cwd(), '.github', 'workflows');

    try {
        const entries = fs.readdirSync(workflowDir);
        const workflowFiles = entries.filter(entry => entry.endsWith('.yml') || entry.endsWith('.yaml'));
        for (const workflowFile of workflowFiles) {
            const content = fs.readFileSync(path.join(workflowDir, workflowFile), 'utf8');
            const config = yaml.load(content) as any;
            const jobs = config.jobs || {};
            workflowJobs[workflowFile] = {
                file: workflowFile,
                jobs: Object.keys(jobs).map(job => jobs[job] ? jobs[job].name || job : job),
                config: config
            };
        }
    } catch (error) {
        core.warning(`Failed to read workflows: ${error}`);
    }

    return workflowJobs;
}

run();
