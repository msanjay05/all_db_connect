# AI-Assisted PR Checklist

## Product

- [ ] User outcome is clear.
- [ ] Scope is small enough to review.
- [ ] Non-goals are explicit.

## Engineering

- [ ] Architecture matches existing patterns.
- [ ] API contracts are documented.
- [ ] Error behavior is explicit.
- [ ] Tests cover non-happy paths.
- [ ] Observability/logging is adequate.

## Security

- [ ] No secrets committed.
- [ ] No private memory or customer data exposed.
- [ ] Auth-sensitive behavior has tests.
- [ ] Tool permissions are least-privilege.
- [ ] External actions require approval.

## Agent Discipline

- [ ] Agents had clear ownership.
- [ ] No duplicate analysis.
- [ ] No uncontrolled agent loops.
- [ ] Escalations and assumptions are documented.

## Release

- [ ] CI passes.
- [ ] Rollback plan exists.
- [ ] Deployment evidence is captured.

