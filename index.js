// @ts-check
const core = require('@actions/core');
const github = require('@actions/github');
const yaml = require('yaml');
const GH_COMMIT_CONTEXT = 'pullapprove2';

/**

 @typedef {import("@octokit/core").Octokit & import('@octokit/plugin-rest-endpoint-methods/dist-types/types').Api} GitHub

 @typedef {'pending' | 'success' | 'error' | 'failure'} GHStatusType

 @typedef {{
    version: number;
    pullapprove_conditions?: {
      condition?: string;
      unmet_status: GHStatusType;
      explanation: string;
    }[];
    overrides?: {
      if: string;
      status: GHStatusType;
      explanation: string;
    }[];
    groups?: {
      [name: string]: {
          type: 'required';
          conditions?: string[];
          reviews: {
              required: number;
          };
          reviewers: {
              teams?: string[];
              users?: string[];
          };
          labels?: {
              approved?: string;
              pending?: string;
              rejected?: string;
          };
      };
    };
}} PAConfig ;

@typedef {{
  organization: {
    teams: {
      totalCount: number;
      edges: {
        node: {
          name: string;
          members: {
            edges: {
              node: {
                login: string;
              };
            }[];
          };
        };
      }[];
    }
  }
 }} GQLTeamsRes;

 @typedef {{
  name: string;
  members: string[];
 }} Team;

 @typedef {{
  data: {
    content: string;
  };
 }} GHFileResponse;

  @typedef {{
    title: string;
    state: 'open' | 'closed' | string;
    user: {
      login: string;
    };
    labels: {
      name: string;
    }[];
    base: {
      ref: string;
      sha: string;
    };
    head: {
      ref: string;
      sha: string;
      repo: {
        default_branch: string;
      };
    };
  }} GHPullRequest;

  @typedef {GHPullRequest & {
    files: GHPullFile[]
  }} Context;

  @typedef {{
    sha: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    filename: string;
    patch?: string;
  }} GHPullFile;

 @typedef {{
  state: 'APPROVED' | 'DISMISSED' | 'REJECTED' | string,
  user: {
    login: string;
  };
  commit_id: string;
 }} GHReview;

 @typedef {{
   state: 'error' | 'failure' | 'success' | 'pending';
   description: string;
  //  target_url: string;
  //  context: string;
 }} CommitStatus;
*/

/**
 * @param {string} str
 * @param {RegExp} reg
 * @param {(...args: string[]) => boolean} cb
 * @returns {boolean}
 **/
function regMatch(str, reg, cb) {
  const match = str.match(reg);
  return !!match && cb(...match);
}

/**
 * @param {string} condition
 * @param {Context} context
 * @returns {boolean}
 * 
 * Evaluates PA conditions
 * Eg:
    - 'ignore-product' not in labels
    - base.ref == 'master'
    - 'WIP' not in title
    - 'label-a' in labels or 'label-b' in labels
 */
function evalCondition(condition, context) {
  return regMatch(condition, /'([^']+)' in labels/, (_, label) => !!context.labels.find((l) => l.name === label))
  || regMatch(condition, /base.ref == '([^']+)'/, (_, branch) => context.base.ref === branch)
  || regMatch(condition, /base.ref != '([^']+)'/, (_, branch) => context.base.ref !== branch)
  || regMatch(condition, /'([^']+)' in title/, (_, subtitle) => context.title.includes(subtitle))
  || regMatch(condition, /'([^']+)' in files/, (_, path) => !!context.files.find(f => f.filename === path))
  || regMatch(condition, /'\*([^']+)' in files/, (_, path) => !!context.files.find(f => f.filename.endsWith(path)))
  || regMatch(condition, /'([^']+)\*' in files/, (_, path) => !!context.files.find(f => f.filename.startsWith(path)))
  || regMatch(condition, /'\*([^']+)\*' in files/, (_, path) => !!context.files.find(f => f.filename.includes(path)))
  || regMatch(condition, /'([^']+)' not in (\S+)/, (_, value, array) => !evalCondition(`'${value}' in ${array}`, context))
  || regMatch(condition, /^(.+) or (.+)$/, (_, a, b) => evalCondition(a, context) || evalCondition(b, context))
  ;
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @returns {Promise<Team[]>}
 */
async function getTeams(api, owner) {
  const res = /** @type {GQLTeamsRes} */(await api.graphql(`
    query getOrg($login: String = "${owner}" ){
      organization(login:$login) {
        teams(first: 100) {
          totalCount
          edges {
            node {
              name
              members {
                edges {
                  node {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `));
  const teams = /** @type {Team[]} */(res.organization.teams.edges.map((t) => ({
    name: t.node.name,
    members: t.node.members.edges.map((m) => m.node.login),
  })));
  return teams;
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @param {string} repo 
 * @param {string} path 
 * @param {string} ref 
 * @returns {Promise<string>}
 */
async function getFileContent(api, owner, repo, path, ref) {
  const base64Data = /** @type {GHFileResponse} */ (await api.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  })).data.content;
  return Buffer.from(base64Data, 'base64').toString('utf8');
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @param {string} repo 
 * @returns {Promise<PAConfig>}
 */
async function getConfig(api, owner, repo, ref) {
  const configData = await getFileContent(api, owner, repo, '.pullapprove.yml', ref);
  // TODO: sanitize config
  return yaml.parse(configData);
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @param {string} repo 
 * @param {number} pull_number 
 * @returns {Promise<GHReview[]>}
 */
async function getReviews(api, owner, repo, pull_number) {
  const reviewResponse = await api.rest.pulls.listReviews({
    owner,
    repo,
    pull_number,
  });
  return reviewResponse.data;
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @param {string} repo 
 * @param {number} pull_number 
 * @returns {Promise<GHPullRequest>}
 */
async function getPullRequest(api, owner, repo, pull_number) {
  const response = await api.rest.pulls.get({
    owner,
    repo,
    pull_number,
  });
  return {
    ...response.data,
    labels: response.data.labels.map(l => ({
      ...l,
      name: l.name || ''
    }))
  }
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @param {string} repo 
 * @param {number} pull_number 
 * @returns {Promise<GHPullFile[]>}
 */
async function getPullRequestFiles(api, owner, repo, pull_number) {
  const response = await api.rest.pulls.listFiles({
    owner,
    repo,
    pull_number,
  });
  return response.data;
}

/**
 * 
 * @param {GitHub} api 
 * @param {string} owner 
 * @param {string} repo 
 * @param {number} pull_number 
 * @returns {Promise<Context>}
 */
async function getContext(api, owner, repo, pull_number) {
  const pr = await getPullRequest(api, owner, repo, pull_number);
  const files = await getPullRequestFiles(api, owner, repo, pull_number);
  return {
    ...pr,
    files,
  };
}

/**
* @param {Team[]} teams
 * @param {string} login
 * @returns {string[]}
**/
function getUserTeams(teams, login) {
  return teams.
    filter(t => t.members.includes(login))
    .map(t => t.name);
}

/**
 * 
 * @param {PAConfig} config 
 * @param {Team[]} teams
 * @param {Context} context 
 * @param {GHReview[]} reviews
 * @returns {CommitStatus}
 */
function evalStatus(config, teams, context, reviews) {
  for (const cond of (config.overrides || [])) {
    if (cond.if && !evalCondition(cond.if, context)) {
      return {
        state: cond.status,
        description: cond.explanation || 'Pr conditions not met!',
      };
    }
  }

  for (const cond of (config.pullapprove_conditions || [])) {
    if (cond.condition && !evalCondition(cond.condition, context)) {
      return {
        state: 'failure',
        description: cond.explanation || 'Pr conditions not met!',
      };
    }
  }

  const rejectedReviews = reviews.filter(rev => rev.state === 'REJECTED');
  if (rejectedReviews.length) {
    return {
      state: 'failure',
      description: `${rejectedReviews.map(rev => rev.user.login).join(',')} rejected pr`,
    };
  }

  for (const [groupName, group] of Object.entries(config.groups || {})) {
    const validGroup = !group.conditions || !group.conditions.find((c) => !evalCondition(c, context));
    if (!validGroup) continue;
    const groupReviews = reviews.filter(rev => rev.state === 'APPROVED'
      && rev.user.login !== context.user.login
      && rev.commit_id === context.head.sha
      && (
        !!getUserTeams(teams, rev.user.login).find((ut) => (group.reviewers.teams || []).includes(ut))
        || (group.reviewers.users || []).includes(rev.user.login)
      )
    );
    if (groupReviews.length < group.reviews.required) {
      return  {
        state: 'failure',
        description: `${groupName} ${groupReviews.length}/${group.reviews.required}`,
      };
    } else {
      console.log(`OK ${groupName} ${groupReviews.length}/${group.reviews.required}`);
    }
  }

  return {
    state: 'success',
    description: 'pr ok',
  };
}

/**
 * @param {GitHub} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} pull_number
 */
async function runForRepo(octokit, owner, repo, pull_number) {
  const context = await getContext(octokit, owner, repo, pull_number);
  const config = await getConfig(octokit, owner, repo, context.head.repo.default_branch);
  const reviews = await getReviews(octokit, owner, repo, pull_number);
  const teams = await getTeams(octokit, owner);
  const res = evalStatus(config, teams, context, reviews);

  console.log(JSON.stringify(res,undefined,2));

  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: context.head.sha,
    state: res.state,
    description: res.description,
    context: GH_COMMIT_CONTEXT,
  });
}

async function run() {
  try {
    console.log('CONTEXT', JSON.stringify(github.context, undefined, 2));
    console.log('PAYLOAD', JSON.stringify(github.context.payload, undefined, 2));
    const token = core.getInput('github-token', { required: true });
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;
    // const pull_number = github.context.issue.number;
    const pull_number = github.context.payload.pull_request.number;
    const octokit = github.getOctokit(token);

    await runForRepo(octokit, owner, repo, pull_number);
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run().then(() => { });
