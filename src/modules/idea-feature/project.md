# Stage-one boundary

- Ordinary Idea/Feature/PRD requests and conversion return to the exact verified
  requester for confirmation.
- Product decisions require exactly one active `product_approver` scoped to the
  Product Agent group.
- Technical decisions require exactly one active `technical_approver` scoped to
  the Product Agent group.
- Owner/admin status never substitutes for either domain role.
- The agent can see only request tools and the separate read-only connector.
  Plane and Outline credentials and `IDEA_FEATURE_PRIVATE_SOCKET` remain on the
  host.
- The host requires `IDEA_FEATURE_PRODUCT_AGENT_GROUP_ID` to equal the current
  session's group and gives each confirmation card a 15-minute lifetime.
- A timeout after the private socket write is `pending verification`; it is not
  success or failure and must not be retried under a new operation key.

This source change defines capability boundaries only. It does not grant roles,
mount sockets, change live projects, or widen production API permissions.
