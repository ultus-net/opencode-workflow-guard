name: Pull Request
description: Submit a change to opencode-workflow-guard
labels: []
body:
  - type: markdown
    attributes:
      value: |
        Thanks for contributing! Before submitting, please ensure your PR
        meets the requirements below. Also check `CONTRIBUTING.md`.

  - type: input
    id: policy
    attributes:
      label: Related Policy
      description: Which policy(s) does this change affect?
      placeholder: "Policies 4, 7, 8"
    validations:
      required: true

  - type: textarea
    id: summary
    attributes:
      label: Summary
      description: What changed and why?
    validations:
      required: true

  - type: textarea
    id: testing
    attributes:
      label: Testing
      description: What tests were added or updated?
      placeholder: |
        - Added regression test for `some-command` evasion
        - Verified typecheck passes (`npm run typecheck`)
        - All unit tests pass (`npm test`)
    validations:
      required: true

  - type: textarea
    id: changelog
    attributes:
      label: Changelog
      description: |
        Required entry. Add a `Changelog:` section or paste the
        CHANGELOG.md addition here.
      placeholder: |
        Changelog: added guard for X command, hardened Y against bypass Z
    validations:
      required: true

  - type: checkboxes
    id: checklist
    attributes:
      label: PR Checklist
      options:
        - label: CHANGELOG.md updated (or `Changelog:` section in body)
          required: true
        - label: Documentation updated (README, docs/policies.md, docs/troubleshooting.md if applicable)
          required: true
        - label: Typecheck passes (`npm run typecheck`)
          required: true
        - label: Unit tests pass (`npm test`)
          required: true