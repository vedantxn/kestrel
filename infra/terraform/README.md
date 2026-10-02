# Terraform

Two stacks (v1 plan I5):

- `bootstrap/`: the state bucket and the Elastic IP. Rarely changed. Never destroyed.
- `main/`: everything else (network, host, test page, schedule, budget). Safe to destroy and recreate; the address and hostname survive because the Elastic IP lives in `bootstrap/`.

## Credentials

Terraform runs as the `kestrel-admin` IAM user, signed in with `aws login --profile kestrel-admin` (a browser sign-in, at most 12 hours). `bin/tf` exports that session into the environment for Terraform, because the provider does not read this session type directly (v1 plan I3, experiment V7). Day-to-day work (`bin/host`) uses the narrower `kestrel-dev` key instead and needs no browser.

## Use

```
bin/tf bootstrap init
bin/tf bootstrap apply
bin/tf main init        # generates main/backend.hcl from the account id
bin/tf main plan
bin/tf main apply
```

`bin/tf` never runs `apply` or `destroy` without showing the plan and asking, unless `--yes` is passed.

## Tagging

Everything carries `Project=kestrel` through the provider's `default_tags`. The `kestrel-dev` policy depends on that tag: it can start, stop and open a shell only on instances carrying it, and nothing else in this AWS account.

## Bootstrap state

The bootstrap stack's own state is local (`bootstrap/terraform.tfstate`, gitignored). After its first apply, move it into the bucket it created so it is not lost with this machine:

```
bin/tf bootstrap migrate-state
```
