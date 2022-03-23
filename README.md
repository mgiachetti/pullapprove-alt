## PullApprove alternative that runs entirely inside GitHub Actions.
it use same .pullapprove.yml configuration, no need to change anything.

Just create a workflow and call the step, eg:  

```yml
# .github/workflows/code-review.yml
name: Update CR Status
on:
  pull_request_review:
    types: [submitted, edited, dismissed]
  pull_request:
    types: [synchronize, opened]
jobs:
  cr:
    runs-on: ubuntu-latest
    name: Update CR Status
    steps:
      - name: Run CR Status
        uses: mgiachetti/pullapprove-alt@master
        with:
          github-token: ${{ secrets.CR_GITHUB_TOKEN }}
```
secrets.GITHUB_TOKEN is a [Personal access token](https://github.com/settings/tokens) with this permission: 
 - repo
 - read:org (for teams)

features:
- [x] overrides
  - [x] if
  - [x] status
  - [x] explanation
- [x] pullapprove_conditions
  - [x] condition
  - [x] unmet_status
  - [x] explanation
- [x] groups
  - [x] type
    - [x] required
    - [ ] optional
  - [x] conditions
  - [x] reviewers
    - [x] users
    - [x] teams
  - [x] reviews
    - [x] required
    - [ ] request
    - [ ] request_order
    - [ ] reviewed_for
  - [ ] description
  - [ ] labels
  - [x] meta
- [ ] notifications
- [ ] extends
- [ ] github_api_version
- [x] meta

Conditions:
 - [x] `base.ref != 'branch'`
 - [x] `base.ref == 'branch'`
 - [x] `'some-label' in labels`
 - [x] `'some-label' not in labels`
 - [x] `some-cond or some-cond`  
    - eg: `'some-label' in labels or 'other-label' in labels`
 - [x] `'text' in title`
 - [x] `'text' not in title`
 - [x] `'.some-file' in files`
 - [x] `'app/*' in files`
 - [x] `'*.js' in files`
 - [ ] `'*travis*' not in statuses.successful`
 - [ ] `'global' not in groups.approved`
 - [ ] `not commits.are_signed_off`
 - [ ] `author_association == 'FIRST_TIME_CONTRIBUTOR'`
 - [ ] `len(groups.active) == 0`
 - [ ] `len(groups.active) < 1`

