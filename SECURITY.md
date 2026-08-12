# Security policy

## Reporting a vulnerability

Report privately through GitHub, not in a public issue:

**https://github.com/waydock/pulse/security/advisories/new**

That opens a draft advisory visible only to you and the maintainers. Expect an
acknowledgement within three working days.

If GitHub is not an option, email **daniel@montoya.com.au** with `SECURITY` in
the subject line.

Please do not open a public issue for anything that lets an attacker run code
on a user's machine, exfiltrate credentials, or publish to `@waydock/*`.

## Supported versions

Fixes ship in a new patch release of the affected package. Only the latest
published version of each package is supported:

| Package | Supported |
| --- | --- |
| `@waydock/pulse` | latest |
| `@waydock/pulse-core` | latest |

## Release integrity

Both packages are published from `.github/workflows/publish.yml` on a `v*` tag,
using npm trusted publishing over OIDC. There is no `NPM_TOKEN` secret in this
repository, so there is no long-lived credential to steal.

Creating, moving or deleting a `v*` tag is restricted to organization admins.
That restriction, not branch protection, is what governs what reaches npm:
a tag can point at any commit, so protecting `main` alone would leave the
release path open to anyone with write access.

Actions in every workflow are pinned to a commit SHA rather than a tag.

Once the Trusted Publisher is configured at npmjs.com for both packages, npm
attaches a provenance attestation to each release automatically, and you can
verify a published tarball back to the commit and workflow that built it with
`npm audit signatures`.

## Scope

In scope: the CLI, the agent, `@waydock/pulse-core`, and the release pipeline
in this repository.

Out of scope: the Waydock service and its MCP server, which are not in this
repository. Report those to **daniel@montoya.com.au**.
