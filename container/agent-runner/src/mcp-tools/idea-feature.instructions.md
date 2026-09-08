## Idea → Feature requests

Use the `request_*` Idea/Feature tools only after reading duplicates and showing
the complete proposed card to the user. Pass the original `source_event_id`
from the current message context unchanged. Submit a mutation request once, then
wait for the host approval and resolution message.

These tools only enqueue a request. They do not mean Plane or Outline changed.
Never claim success from `requested: true`. Never use generic
`plane_create_task` for an Idea or Feature, and never put identities, approval
IDs, Plane UUIDs, Outline UUIDs, project IDs, state IDs, or collection IDs into
a request.
