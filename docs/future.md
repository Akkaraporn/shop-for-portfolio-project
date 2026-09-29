# Deliberately not built

Scope creep is this project's top risk. When something interesting turns up
mid-build, it gets written down here **and then left alone**.

Each entry says what it is, why it was skipped, and what would have to be true
to revisit it. An entry here is evidence of a decision, not a backlog.

## Cut on purpose

| Idea | Why not | Would revisit if |
| --- | --- | --- |
| Real Kafka consumer | The `outbox_events` table is enough to show the design accounts for async delivery; a broker adds infrastructure without adding anything the contract can test. | The demo needed to show real event fan-out. |
| Elasticsearch | Postgres `to_tsvector` + a GIN index covers a 15-product catalogue and stays inside the one shared source of truth. | The catalogue grew past what full-text Postgres handles well. |
| Kubernetes | `docker compose` swaps backends in one command, which is the whole point. K8s would make the swap harder to demonstrate, not easier. | The project needed to show a real deployment topology. |
| Multi-currency | Every price is integer minor units in one currency. `currency` exists on the response to show the seam. | A second currency was actually required. |
| Coupons / promotions | An entire pricing engine, no new architectural idea. | The checkout story needed discount logic. |
| MinIO + presigned uploads | Seed images are Unsplash URLs, which look real and cost nothing. | Admin product creation needed genuine image upload. |
| Dark mode | Doubles the work on every component for something no interviewer asks about. shadcn's CSS variables leave the door open, so this is "not now", not "can't". | There was time left after Phase 6. |

## Parked notes

<!-- Append below. Date each entry. Do not act on them. -->
