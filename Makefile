# ---------------------------------------------------------------------------
# One command to a working web store. Keep it that way.
#
# The point of this file: a reviewer types `make up-node`, gets a running
# store, then types `make up-java` and gets the same store on a different
# backend. Anything that needs more than one command belongs in here.
# ---------------------------------------------------------------------------
COMPOSE := docker compose --env-file .env -f infra/compose.yaml
CONTRACT := contract/openapi.yaml

.DEFAULT_GOAL := help
.PHONY: help up-node up-java down clean logs ps \
        lint-contract gen-client gen-prisma test-parity db-dump db-psql db-verify

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

hooks: ## Install the git hooks in .githooks (run once per clone)
	git config core.hooksPath .githooks
	@echo "hooks installed: contract changes now lint before commit"

# --- run -------------------------------------------------------------------

up-node: ## Bring up the stack on the NestJS backend
	BACKEND_HOST=api-node BACKEND_PORT=3000 $(COMPOSE) --profile node up -d --build

up-java: ## Bring up the stack on the Spring Boot backend
	BACKEND_HOST=api-java BACKEND_PORT=8080 $(COMPOSE) --profile java up -d --build

down: ## Stop everything (keeps the database volume)
	$(COMPOSE) --profile node --profile java down

clean: ## Stop everything and wipe the database volume (next up re-seeds)
	$(COMPOSE) --profile node --profile java down -v

logs: ## Tail logs from every running service
	$(COMPOSE) logs -f --tail=100

ps: ## Show service status
	$(COMPOSE) ps

# --- contract --------------------------------------------------------------

lint-contract: ## Lint the OpenAPI contract (must be clean before any codegen)
	npx --yes @stoplight/spectral-cli lint $(CONTRACT) --ruleset contract/.spectral.yaml

gen-client: lint-contract ## Regenerate the frontend's types from the contract
	npx --yes openapi-typescript $(CONTRACT) -o apps/web/src/api/schema.d.ts

gen-prisma: ## Re-run migrations, then pull the schema into Prisma (never the reverse)
	$(COMPOSE) up flyway
	cd apps/api-node && npx prisma db pull && npx prisma generate

# --- test ------------------------------------------------------------------

test-parity: ## Run the parity suite against whichever backend is currently up
	cd tests/parity && npm test

# --- database --------------------------------------------------------------

db-dump: ## Dump the live schema (to diff against V1__init.sql)
	$(COMPOSE) exec -T postgres pg_dump -U $${POSTGRES_USER:-shop} \
	  --schema-only $${POSTGRES_DB:-shop} > migrations/.schema-dump.sql
	@echo "wrote migrations/.schema-dump.sql"

db-verify: ## Prove the schema's constraints reject what they claim to reject
	$(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 -U $${POSTGRES_USER:-shop} -d $${POSTGRES_DB:-shop} -f - < tests/schema/verify-constraints.sql

db-psql: ## Open a psql shell on the dev database
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-shop} $${POSTGRES_DB:-shop}
