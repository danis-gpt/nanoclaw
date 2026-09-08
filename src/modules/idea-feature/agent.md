# Idea → Feature host gate

The Product Agent can submit only the `idea_feature_request` messages emitted by
the bounded `request_*` tools. It cannot supply actor, approver, grant,
operation-key, Plane, Outline, project, state, label, collection, or credential
controls.

Every request must reference the original Telegram inbound event from the same
active Product Agent session. The host resolves the sender from stored metadata,
checks current Product-group access, presents the complete bounded payload to the
exclusive human approver, and executes only the one-use approved replay.

Generic Plane creation is not an alternative path for an Idea or Feature.
`Accepted`, `Released`, Outline publication, deletion, and arbitrary project or
collection selection are outside this module.
