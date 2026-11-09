# Security policy

## Supported versions

Only the latest release on the [releases page](https://github.com/superbiche/marque/releases) receives fixes. There are no maintenance branches.

## Reporting a vulnerability

Report privately through GitHub: [Report a vulnerability](https://github.com/superbiche/marque/security/advisories/new). Do not open a public issue for a security problem.

Include the markdown input or the steps that trigger the problem, the marque version, and your platform. You will get an acknowledgement within 7 days and a fix or a decision within 30 days for confirmed reports. Credit goes to the reporter in the release notes unless you ask otherwise.

## Scope

Marque renders markdown files that may come from untrusted sources. Reports of particular interest:

- HTML or script execution that survives sanitization (DOMPurify) in rendered documents, including through Mermaid, KaTeX, or Shiki output.
- Access from a rendered document to the Tauri IPC surface, the filesystem, or the network beyond the images the document references.
- Path handling that lets a document or a folder workspace read files outside what the user opened.
- Vulnerable dependencies are tracked by Dependabot; a report is welcome when a published advisory is exploitable through marque's actual usage.

Out of scope: issues that require the user to run a modified build, and denial of service through pathological markdown that only slows the viewer down.
