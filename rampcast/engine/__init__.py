"""RAMPCAST decision engine (Role 3): strategies, stand plan, priority queue, alerts, alternates, what-if,
Claude explanations and the audit log.

Every function here is pure or append-only and returns contract-shaped dicts (contracts/README.md).
Nothing here takes an action: each output is a suggestion with reasons and the role that must approve it.
`rampcast` is a namespace package so the forecast team can add `rampcast/forecast/` beside this.
"""
