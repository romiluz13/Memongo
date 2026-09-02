# DDD Reports

- sweep-baseline.json - compliance sweep at program start (pre-implementation)
- sweep-wsNN.json - sweep output captured after each workstream lands
- validations.yaml - validation records referenced by claims (created per workstream)
- refutation-*.yaml - independent refutation reports for T3 claims (created per workstream)
- runs/ - captured run logs backing the sha256 evidence hashes in validations.yaml and refutation reports; never edited after capture
