# Security policy

Typst Side Agent handles model credentials, project-derived content, and
user-configured network integrations. Please report suspected vulnerabilities
privately so users can be protected before technical details are published.

## Supported versions

Security fixes target the latest published release. If a report affects an
older release, maintainers may ask reporters to confirm it against the latest
version before investigating a backport.

## Report a vulnerability

Do not include vulnerability details, credentials, private Typst content, or
working exploit material in a public issue.

Use GitHub's private vulnerability-reporting form:

<https://github.com/dbccccccc/Typst-Side-Agent/security/advisories/new>

If that form is unavailable, open a minimal public issue asking the maintainer
to establish a private contact channel. Do not describe the vulnerability in
that issue.

A useful private report includes:

- the affected extension version and browser version;
- the affected component or workflow;
- the security impact and required preconditions;
- concise reproduction steps using non-sensitive test data; and
- any suggested mitigation, if known.

Never send real API keys, custom headers, account data, or private documents.
Replace them with clearly marked test values.

## What happens next

Maintainers will validate the report, assess affected versions, prepare a fix
and regression test when appropriate, and coordinate disclosure with the
reporter. Please allow a reasonable remediation window before publishing
details. GitHub Security Advisories will be used for coordinated disclosure
when available.

Reports about Typst, a model provider, a custom-tool operator, an MCP server, or
the Chrome Web Store itself should be sent to the operator of that service.
General questions and ordinary bugs belong in the public issue tracker.
