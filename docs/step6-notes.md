# Step 6: GitHub Actions deploy with OIDC

## Files
- `.github/workflows/deploy.yml`: push to main (path-filtered) or manual run. `test` job (npm ci, tsc), then `deploy` job (`needs: test`) assumes an AWS role via OIDC and runs `sam build && sam deploy`.
- `infra/github-oidc-trust.json`: trust policy for the deploy role. Replace `<AWS_ACCOUNT_ID>` and `<GITHUB_USER>`.
- `samconfig.toml`: had no `profile` line, so nothing removed. Added `parameter_overrides` so CI deploys `FailRate=0.3 ConsumerFail=false`.

## The permissions block
```yaml
permissions:
  id-token: write   # job may request an OIDC JWT from GitHub
  contents: read    # checkout only; token can't push or touch releases
```
- Setting `permissions` at all drops everything not listed to `none`. Least privilege for the `GITHUB_TOKEN`.
- `id-token: write` is the odd name for "may mint an identity token". It writes nothing to the repo.
- `configure-aws-credentials` sends that JWT to STS `AssumeRoleWithWebIdentity` and gets ~1h credentials. No AWS keys stored in GitHub.

## The sub condition
- The JWT carries claims. `aud` = `sts.amazonaws.com` (token meant for AWS). `sub` = who is running: `repo:<owner>/<repo>:ref:refs/heads/main`.
- `StringEquals` on `sub` means only workflows on **main of this repo** can assume the role. A fork, a PR branch, or any other repo gets AccessDenied.
- Without a `sub` condition, any GitHub repo in the world using this provider could assume your role. That is the classic OIDC misconfiguration.
- Variants: `repo:x/y:environment:prod` (gate on a GitHub Environment with required reviewers), `repo:x/y:pull_request` (PR plan-only role). Use `StringLike` with `*` only deliberately.

## Parameters choice
`sam deploy` without overrides uses template defaults, not the stack's previous values. Pinning them in samconfig makes the value versioned and identical for CI and laptop. Local `--parameter-overrides` still wins when you want FailRate=1.

## Design decisions (interview)
- `concurrency: deploy-main, cancel-in-progress: false`: never kill a CloudFormation update midway; queue the next deploy instead.
- `needs: test`: no deploy if typecheck fails. Rejected alternative: one job (simpler, but a deploy step could run on a broken build if someone reorders steps, and no separate red/green signal).
- `--no-confirm-changeset` overrides `confirm_changeset = true` in samconfig, so local stays interactive and CI is not.
- `--no-fail-on-empty-changeset`: a docs-only change that passes the path filter isn't a failure.
- Path filter includes `samconfig.toml` (added beyond the ask, since it changes deploy parameters).
- OIDC vs access keys: no long-lived secret to leak or rotate; creds expire in an hour and are scoped by trust policy. Rejected: IAM user keys in GitHub secrets.
- Real OFC comparison: Jenkins X GitOps on EKS with IRSA uses the same idea. A Kubernetes service account's OIDC token is exchanged for an IAM role, with the `sub` scoped to `system:serviceaccount:<ns>:<sa>`.
- Senior improvement: separate dev/prod roles and GitHub Environments with approval, `sam validate --lint` in test, unit tests, and a narrower deploy role policy than admin.

## Setup steps (Topaz)
1. Create the GitHub repo `mini-ofc`, then `git add . && git commit && git push -u origin main` (check `.gitignore` covers node_modules/.aws-sam first).
2. IAM > Identity providers > add OpenID Connect: URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
3. Fill placeholders in `infra/github-oidc-trust.json`, then:
   `aws iam create-role --role-name mini-ofc-deploy --assume-role-policy-document file://infra/github-oidc-trust.json --profile mini-ofc`
4. Attach permissions. Quick for the demo: `AdministratorAccess` (say in the interview you'd scope to CloudFormation, S3, Lambda, IAM PassRole, etc.).
5. Repo Settings > Secrets and variables > Actions > **Variables**: `AWS_DEPLOY_ROLE_ARN` = role ARN, `AWS_REGION` = `us-east-1`.
6. Actions tab > deploy > Run workflow (or push a change under src/).
