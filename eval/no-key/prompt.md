What dependency updates have I missed for this repo? ({{REPO}}, commit {{COMMIT}}). Don't change any files.

unstale, a dependency-change tool, is installed here without a model provider: its report is `.unstale/onboarding-report.md`, and the unparsed release notes it refers to are in `.unstale/change-events.md`. Use them as leads and verify each; they can be wrong or incomplete, and they are not the only source.

When you're done, reply with only this JSON so it can be scored, no prose or code fence:

{"items": [{"package": "<name>", "kind": "capability|deprecation|breaking|security", "installed": "<version>", "target": "<version>", "summary": "<one sentence>", "evidence_url": "<source URL>", "sites": ["<path>:<line>"]}]}
