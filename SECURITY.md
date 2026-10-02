# Security policy

agents-everywhere runs a model with access to a real machine, so a flaw in its permission checks, its runner or its control plane can hand that machine to whoever controls the model's input. Reports of that kind are the ones we most want.

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability reporting](https://github.com/codity-ai/agents-everywhere/security/advisories/new). Do not open a public issue or pull request for it.

Include what you can of:

- the component (engine, runner, control plane) and the version or commit
- the permission config or install setup involved
- the steps, prompt or tool call that reproduces it, and what happened as a result

We aim to acknowledge a report within 3 working days and to agree a disclosure date with you once the issue is confirmed.

## In scope

- A tool call that reads, writes or runs something the permission config does not allow, including through shell redirection, symlinks, command wrappers or path tricks
- The runner leaking the LLM key, a fetched secret, or a run token (to logs, to disk, to the model, or to another host)
- Control plane authentication, authorization, CSRF, token replay, or one run reaching another run's data
- Anything that lets a remote page or host drive a local engine server

## Known limits (not vulnerabilities)

- Allowing a command that runs other commands or writes wherever it is pointed (`sh`, `python`, `make`, `tee`, `sed -i`, `curl -o` and similar) makes the path rules advisory. The control plane refuses such rules unless they are explicitly acknowledged.
- An agent granted write access to a repository can change that repository's own configuration, including `.git/config`.
