# Security policy

Please report vulnerabilities privately through GitHub Security Advisories.

The app reads repository build configuration and writes check runs. It does not
execute analyzed code. Deployments should keep GitHub App private keys in a
managed secret store, validate webhook signatures through Probot, use a
dedicated runtime identity, and avoid logging repository file contents.
