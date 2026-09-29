# Deliberately not built

Scope creep is this project's top risk. When something interesting turns up
mid-build, it gets written down here **and then left alone**.

Each entry says what it is, why it was skipped, and what would have to be true
to revisit it. An entry here is evidence of a decision, not a backlog.

## Cut on purpose

| Idea | Why not | Would revisit if |
| --- | --- | --- |
| Real Kafka consumer | The `outbox_events` table is enough to show the design accounts for async delivery; a broker adds infrastructure without adding anything the contract can test. | The demo needed to show real event fan-out. |
| Elasticsearch | A `pg_trgm` GIN index covers a 15-product catalogue and stays inside the one shared source of truth. It is substring matching, not real search: no ranking, no stemming, no Thai word segmentation. | The catalogue grew, or search quality (ranking, typo tolerance, Thai segmentation) started to matter. A Thai tokeniser such as PyThaiNLP feeding a tsvector column would be the step before a separate search engine. |
| Kubernetes | `docker compose` swaps backends in one command, which is the whole point. K8s would make the swap harder to demonstrate, not easier. | The project needed to show a real deployment topology. |
| Multi-currency | Every price is integer minor units in one currency. `currency` exists on the response to show the seam. | A second currency was actually required. |
| Coupons / promotions | An entire pricing engine, no new architectural idea. | The checkout story needed discount logic. |
| MinIO + presigned uploads | Seed images are `picsum.photos` URLs seeded per slug — always resolve, cost nothing, never 404. | Admin product creation needed genuine image upload. Curating real product photography is task 6.2, and does not need object storage. |
| Dark mode | Doubles the work on every component for something no interviewer asks about. shadcn's CSS variables leave the door open, so this is "not now", not "can't". | There was time left after Phase 6. |

## Parked notes

<!-- Append below. Date each entry. Do not act on them. -->
