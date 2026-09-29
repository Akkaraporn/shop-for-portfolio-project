-- ---------------------------------------------------------------------------
-- V1__init.sql — the entire schema, owned by Flyway.
--
-- Neither ORM may write this. Prisma reads it with `db pull`; JPA validates
-- against it with `ddl-auto: validate`. The moment one of them can migrate, the
-- other drifts and the parity suite stops meaning anything.
--
-- Three rules this file follows deliberately:
--
--   1. Money is BIGINT in minor units (satang). Never NUMERIC, never DOUBLE.
--      Jackson renders BigDecimal("129.50") as 129.50 while Prisma renders
--      Decimal as the string "129.5" — same row, two different JSON values, and
--      nothing notices until a client does arithmetic on it.
--
--   2. Enums are VARCHAR + CHECK, never PostgreSQL ENUM. Prisma maps a native
--      enum one way and Hibernate another, and adding a value would need an
--      ALTER TYPE deployed in lockstep with both backends. A CHECK constraint
--      gives the same guarantee and belongs to nobody.
--
--   3. No triggers, no stored procedures, no computed columns. If business logic
--      lived in here, both backends would merely be calling the same procedure
--      and the parity suite would prove nothing about either of them. The one
--      exception is a sequence for order numbers, which is a counter rather
--      than logic.
--
-- Timestamps are timestamptz(3): the API promises millisecond precision, and
-- truncating in the column means both backends read back exactly what the API
-- must render, rather than each rounding Postgres microseconds its own way.
--
-- IDs default to gen_random_uuid() so that seeds and manual inserts work, but
-- the applications generate UUIDv7 themselves. See docs/adr/008.
-- ---------------------------------------------------------------------------

-- Trigram matching, for product search. See the index on products below for why
-- this rather than tsvector.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===========================================================================
-- Identity
-- ===========================================================================

CREATE TABLE users (
    id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    email         varchar(255) NOT NULL,
    password_hash text         NOT NULL,
    full_name     varchar(120) NOT NULL,
    role          varchar(16)  NOT NULL DEFAULT 'customer',
    created_at    timestamptz(3) NOT NULL DEFAULT now(),
    updated_at    timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT users_role_check  CHECK (role IN ('customer', 'admin')),
    CONSTRAINT users_email_check CHECK (position('@' IN email) > 1)
);

-- The API compares addresses case-insensitively, so uniqueness has to be
-- case-insensitive too or 'A@x.com' and 'a@x.com' become two accounts that
-- both answer to the same login.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

COMMENT ON COLUMN users.password_hash IS
    'argon2id PHC string. Parameters live with the auth module, not here.';

-- Refresh tokens are rotated on every use. A token that is presented after
-- being rotated means a copy leaked, so the whole family is revoked — which is
-- why family_id exists and why replaced_by records the chain.
CREATE TABLE refresh_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    family_id   uuid        NOT NULL,
    token_hash  char(64)    NOT NULL,
    replaced_by uuid,
    issued_at   timestamptz(3) NOT NULL DEFAULT now(),
    expires_at  timestamptz(3) NOT NULL,
    revoked_at  timestamptz(3),

    CONSTRAINT refresh_tokens_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT refresh_tokens_replaced_by_fk
        FOREIGN KEY (replaced_by) REFERENCES refresh_tokens (id) ON DELETE SET NULL,
    CONSTRAINT refresh_tokens_expiry_check CHECK (expires_at > issued_at)
);

-- Only the hash is stored. If the database leaks, the tokens in it are useless.
CREATE UNIQUE INDEX refresh_tokens_token_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_family_idx  ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx    ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expiry_idx  ON refresh_tokens (expires_at);

COMMENT ON COLUMN refresh_tokens.token_hash IS
    'SHA-256 hex of the token. The raw token is never stored.';

-- ===========================================================================
-- Catalogue
-- ===========================================================================

CREATE TABLE categories (
    id         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  uuid,
    slug       varchar(120) NOT NULL,
    name       varchar(120) NOT NULL,
    position   integer      NOT NULL DEFAULT 0,
    is_active  boolean      NOT NULL DEFAULT true,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT categories_parent_fk
        FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE RESTRICT,
    CONSTRAINT categories_no_self_parent_check CHECK (parent_id IS DISTINCT FROM id),
    CONSTRAINT categories_slug_format_check
        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX categories_slug_key  ON categories (slug);
CREATE INDEX        categories_parent_idx ON categories (parent_id);

COMMENT ON TABLE categories IS
    'Self-referencing tree. Filtering products by a category includes its whole '
    'subtree, resolved with a recursive CTE in both backends.';

CREATE TABLE products (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id     uuid         NOT NULL,
    slug            varchar(160) NOT NULL,
    name            varchar(200) NOT NULL,
    description     text         NOT NULL,
    status          varchar(16)  NOT NULL DEFAULT 'draft',
    min_price_cents bigint       NOT NULL DEFAULT 0,
    currency        char(3)      NOT NULL DEFAULT 'THB',
    created_at      timestamptz(3) NOT NULL DEFAULT now(),
    updated_at      timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT products_category_fk
        FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT,
    CONSTRAINT products_status_check
        CHECK (status IN ('draft', 'active', 'archived')),
    CONSTRAINT products_min_price_check CHECK (min_price_cents >= 0),
    CONSTRAINT products_currency_check  CHECK (currency = 'THB'),
    CONSTRAINT products_slug_format_check
        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX products_slug_key    ON products (slug);
CREATE INDEX        products_category_idx ON products (category_id);

-- One index per cursor sort, each ending in id so the tiebreaker is covered.
-- Without id in the index the sort spills, and without it in the ORDER BY the
-- cursor duplicates or skips rows whose sort values tie.
CREATE INDEX products_newest_idx
    ON products (status, created_at DESC, id DESC);
CREATE INDEX products_price_asc_idx
    ON products (status, min_price_cents ASC, id ASC);
CREATE INDEX products_price_desc_idx
    ON products (status, min_price_cents DESC, id DESC);
CREATE INDEX products_name_asc_idx
    ON products (status, name ASC, id ASC);

-- Trigram substring matching, NOT tsvector full-text search.
--
-- tsvector was the obvious choice and it does not work here. Thai is written
-- without spaces between words, and no text search configuration Postgres ships
-- can segment it — so `เสื้อเชิ้ตลินินคอปกเปิด` becomes one enormous token, and
-- searching for `ลินิน` matches nothing at all. Verified: the index was used,
-- the query was correct, and zero rows came back.
--
-- Trigrams have no notion of a word, which is exactly why they survive the
-- absence of word boundaries. `ILIKE '%q%'` against this index matches mid-word
-- in Thai, and still matches Latin text and numerals ('400' finds the 400-thread
-- sheets). Both backends must implement search the same way:
--
--     WHERE (name || ' ' || description) ILIKE '%' || :q || '%'
--
-- Terms shorter than three characters cannot use a trigram index and fall back
-- to a scan. Fine at this catalogue size, and the same in both backends.
CREATE INDEX products_search_idx ON products
    USING gin ((name || ' ' || description) gin_trgm_ops);

COMMENT ON COLUMN products.min_price_cents IS
    'Denormalised price of the cheapest active variant. sort=price_asc reads '
    'this; a MIN() subquery over variants cannot use an index. Both backends '
    'must maintain it on variant insert, reprice, and deactivation.';

CREATE TABLE product_variants (
    id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id     uuid         NOT NULL,
    sku            varchar(64)  NOT NULL,
    name           varchar(120) NOT NULL,
    price_cents    bigint       NOT NULL,
    stock_on_hand  integer      NOT NULL DEFAULT 0,
    stock_reserved integer      NOT NULL DEFAULT 0,
    is_active      boolean      NOT NULL DEFAULT true,
    position       integer      NOT NULL DEFAULT 0,
    created_at     timestamptz(3) NOT NULL DEFAULT now(),
    updated_at     timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT product_variants_product_fk
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
    CONSTRAINT product_variants_price_check    CHECK (price_cents >= 0),
    CONSTRAINT product_variants_on_hand_check  CHECK (stock_on_hand >= 0),
    CONSTRAINT product_variants_reserved_check CHECK (stock_reserved >= 0),

    -- The last line of defence. Even if the locking is wrong in both backends,
    -- the database cannot promise goods that are not there.
    CONSTRAINT product_variants_reserved_lte_on_hand_check
        CHECK (stock_reserved <= stock_on_hand)
);

CREATE UNIQUE INDEX product_variants_sku_key     ON product_variants (sku);
CREATE INDEX        product_variants_product_idx ON product_variants (product_id);

COMMENT ON COLUMN product_variants.stock_reserved IS
    'Units promised to in-flight orders. Available stock is on_hand - reserved, '
    'computed at read time and advisory only — checkout re-verifies under lock.';

CREATE TABLE product_images (
    id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid    NOT NULL,
    url        text    NOT NULL,
    alt        varchar(200),
    position   integer NOT NULL DEFAULT 0,
    created_at timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT product_images_product_fk
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
    CONSTRAINT product_images_position_check CHECK (position >= 0)
);

CREATE UNIQUE INDEX product_images_product_position_key
    ON product_images (product_id, position);

-- ===========================================================================
-- Cart
--
-- In Postgres, not Redis. In Redis the two backends would have to agree on a
-- serialisation format the contract cannot describe — a gap the parity suite
-- could not see into. Here it is ordinary shared state, and a guest basket
-- created against one backend is readable by the other.
-- ===========================================================================

CREATE TABLE carts (
    id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid,
    token_hash char(64),
    currency   char(3) NOT NULL DEFAULT 'THB',
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),
    expires_at timestamptz(3),

    CONSTRAINT carts_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT carts_currency_check CHECK (currency = 'THB'),

    -- A basket belongs to a signed-in user or to a guest token, never both and
    -- never neither. Guest baskets expire; a user's basket does not.
    CONSTRAINT carts_single_owner_check CHECK (
        (user_id IS NOT NULL AND token_hash IS NULL     AND expires_at IS NULL)
     OR (user_id IS NULL     AND token_hash IS NOT NULL AND expires_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX carts_user_key  ON carts (user_id)    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX carts_token_key ON carts (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX carts_expiry_idx ON carts (expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN carts.token_hash IS
    'SHA-256 hex of the X-Cart-Token. The raw token only ever exists in transit.';

CREATE TABLE cart_items (
    id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id    uuid    NOT NULL,
    variant_id uuid    NOT NULL,
    quantity   integer NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT cart_items_cart_fk
        FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE CASCADE,
    CONSTRAINT cart_items_variant_fk
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
    CONSTRAINT cart_items_quantity_check CHECK (quantity BETWEEN 1 AND 99)
);

-- The upsert target: adding a variant already in the basket bumps its quantity
-- instead of creating a second line.
CREATE UNIQUE INDEX cart_items_cart_variant_key ON cart_items (cart_id, variant_id);

COMMENT ON TABLE cart_items IS
    'No price column on purpose. A basket shows live prices, recomputed from the '
    'variant on every read; only order_items freeze them.';

-- ===========================================================================
-- Orders
-- ===========================================================================

-- A counter, not logic. Both backends call nextval() and format the result as
-- ORD-<year>-<7 digits>. The sequence is global rather than per-year: restarting
-- annually would need either a counter table (a contention point on every
-- checkout) or a trigger (banned above), and neither is worth it for a number
-- whose only job is to be unique and readable.
CREATE SEQUENCE order_number_seq AS bigint START WITH 1 INCREMENT BY 1 MAXVALUE 9999999;

CREATE TABLE orders (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number     varchar(20) NOT NULL,
    user_id          uuid        NOT NULL,
    status           varchar(24) NOT NULL DEFAULT 'pending_payment',
    subtotal_cents   bigint      NOT NULL,
    shipping_cents   bigint      NOT NULL,
    total_cents      bigint      NOT NULL,
    currency         char(3)     NOT NULL DEFAULT 'THB',
    shipping_address jsonb       NOT NULL,
    note             varchar(500),
    placed_at        timestamptz(3) NOT NULL DEFAULT now(),
    paid_at          timestamptz(3),
    cancelled_at     timestamptz(3),
    updated_at       timestamptz(3) NOT NULL DEFAULT now(),

    -- RESTRICT, not CASCADE: deleting a user must not silently erase the
    -- financial record of what they bought.
    CONSTRAINT orders_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT orders_status_check CHECK (status IN (
        'pending_payment', 'paid', 'fulfilled', 'completed',
        'cancelled', 'expired', 'payment_failed'
    )),
    CONSTRAINT orders_subtotal_check CHECK (subtotal_cents >= 0),
    CONSTRAINT orders_shipping_check CHECK (shipping_cents >= 0),
    CONSTRAINT orders_total_check    CHECK (total_cents = subtotal_cents + shipping_cents),
    CONSTRAINT orders_currency_check CHECK (currency = 'THB'),
    CONSTRAINT orders_number_format_check
        CHECK (order_number ~ '^ORD-[0-9]{4}-[0-9]{7}$')
);

CREATE UNIQUE INDEX orders_number_key ON orders (order_number);
CREATE INDEX orders_user_idx   ON orders (user_id, placed_at DESC, id DESC);
CREATE INDEX orders_status_idx ON orders (status, placed_at DESC, id DESC);

COMMENT ON COLUMN orders.shipping_address IS
    'JSONB snapshot of where this order went, not a reference to the user''s '
    'current address. Editing an address must not rewrite delivery history.';

CREATE TABLE order_items (
    id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         uuid         NOT NULL,
    variant_id       uuid         NOT NULL,
    product_id       uuid         NOT NULL,
    product_name     varchar(200) NOT NULL,
    variant_name     varchar(120) NOT NULL,
    sku              varchar(64)  NOT NULL,
    image_url        text,
    unit_price_cents bigint       NOT NULL,
    quantity         integer      NOT NULL,
    line_total_cents bigint       NOT NULL,

    CONSTRAINT order_items_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,

    -- RESTRICT is what makes "archive, never delete" enforceable rather than a
    -- convention: a variant referenced by any order cannot be removed, however
    -- much someone wants to.
    CONSTRAINT order_items_variant_fk
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
    CONSTRAINT order_items_product_fk
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,

    CONSTRAINT order_items_price_check    CHECK (unit_price_cents >= 0),
    CONSTRAINT order_items_quantity_check CHECK (quantity > 0),
    CONSTRAINT order_items_line_total_check
        CHECK (line_total_cents = unit_price_cents * quantity)
);

CREATE INDEX order_items_order_idx ON order_items (order_id);

COMMENT ON TABLE order_items IS
    'Every descriptive field is a snapshot, not a join. Repricing or archiving a '
    'product must never change what someone was charged.';

-- Stock is held here between checkout and payment. The sweeper releases rows
-- whose expires_at has passed, which is the only thing standing between an
-- abandoned checkout and stock locked up forever.
CREATE TABLE stock_reservations (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    uuid        NOT NULL,
    variant_id  uuid        NOT NULL,
    quantity    integer     NOT NULL,
    status      varchar(16) NOT NULL DEFAULT 'held',
    expires_at  timestamptz(3) NOT NULL,
    created_at  timestamptz(3) NOT NULL DEFAULT now(),
    resolved_at timestamptz(3),

    CONSTRAINT stock_reservations_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
    CONSTRAINT stock_reservations_variant_fk
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
    CONSTRAINT stock_reservations_quantity_check CHECK (quantity > 0),
    CONSTRAINT stock_reservations_status_check
        CHECK (status IN ('held', 'released', 'committed')),

    -- A held reservation has not been resolved; a resolved one is not held.
    CONSTRAINT stock_reservations_resolution_check CHECK (
        (status = 'held' AND resolved_at IS NULL)
     OR (status <> 'held' AND resolved_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX stock_reservations_order_variant_key
    ON stock_reservations (order_id, variant_id);

-- The sweeper's index: partial, so it stays small no matter how many
-- reservations have already been resolved.
CREATE INDEX stock_reservations_sweep_idx
    ON stock_reservations (expires_at) WHERE status = 'held';

CREATE TABLE payments (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        uuid        NOT NULL,
    status          varchar(20) NOT NULL DEFAULT 'requires_action',
    method          varchar(16) NOT NULL,
    amount_cents    bigint      NOT NULL,
    currency        char(3)     NOT NULL DEFAULT 'THB',
    provider        varchar(32) NOT NULL DEFAULT 'mock',
    provider_ref    varchar(128),
    failure_reason  varchar(200),
    created_at      timestamptz(3) NOT NULL DEFAULT now(),
    updated_at      timestamptz(3) NOT NULL DEFAULT now(),

    CONSTRAINT payments_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
    CONSTRAINT payments_status_check
        CHECK (status IN ('requires_action', 'processing', 'succeeded', 'failed')),
    CONSTRAINT payments_method_check CHECK (method IN ('card', 'promptpay')),
    CONSTRAINT payments_amount_check CHECK (amount_cents >= 0),
    CONSTRAINT payments_currency_check CHECK (currency = 'THB'),

    -- A reason belongs to a failure and nothing else.
    CONSTRAINT payments_failure_reason_check CHECK (
        (status = 'failed') OR (failure_reason IS NULL)
    )
);

-- One payment per order, which is what lets the contract embed it in Order
-- unconditionally instead of as a list.
CREATE UNIQUE INDEX payments_order_key ON payments (order_id);

-- ===========================================================================
-- Integration plumbing
-- ===========================================================================

-- Providers redeliver. The unique constraint is the whole deduplication
-- mechanism: the handler inserts first with ON CONFLICT DO NOTHING, and a
-- conflict means this event was already applied, so stock moves exactly once.
CREATE TABLE webhook_events (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider     varchar(32) NOT NULL,
    event_id     varchar(128) NOT NULL,
    event_type   varchar(64) NOT NULL,
    payload      jsonb       NOT NULL,
    received_at  timestamptz(3) NOT NULL DEFAULT now(),
    processed_at timestamptz(3)
);

CREATE UNIQUE INDEX webhook_events_provider_event_key
    ON webhook_events (provider, event_id);

-- Shared, so a checkout retried against the *other* backend replays instead of
-- placing a second order. That cross-backend replay is the demo this project
-- exists to show, and it only works because this table is in Postgres rather
-- than in one process's memory.
CREATE TABLE idempotency_keys (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid         NOT NULL,
    endpoint        varchar(64)  NOT NULL,
    idempotency_key varchar(128) NOT NULL,
    request_hash    char(64)     NOT NULL,
    status          varchar(16)  NOT NULL DEFAULT 'in_progress',
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz(3) NOT NULL DEFAULT now(),
    completed_at    timestamptz(3),
    expires_at      timestamptz(3) NOT NULL,

    CONSTRAINT idempotency_keys_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT idempotency_keys_status_check
        CHECK (status IN ('in_progress', 'completed', 'failed')),

    -- A completed key must carry the response it is going to replay, or the
    -- replay would return nothing.
    CONSTRAINT idempotency_keys_completed_check CHECK (
        (status <> 'completed')
     OR (response_status IS NOT NULL AND response_body IS NOT NULL
         AND completed_at IS NOT NULL)
    )
);

-- Scoped per user: one client's key can never collide with another's.
CREATE UNIQUE INDEX idempotency_keys_scope_key
    ON idempotency_keys (user_id, endpoint, idempotency_key);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

COMMENT ON COLUMN idempotency_keys.request_hash IS
    'SHA-256 hex of the canonicalised request body: keys sorted recursively, no '
    'whitespace. Same key with a different hash is a 422, never a replay.';

-- Written in the same transaction as the state change it describes. There is no
-- consumer: the table is the evidence that the design accounts for async
-- delivery, and a real broker is deliberately out of scope (docs/future.md).
CREATE TABLE outbox_events (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type varchar(32) NOT NULL,
    aggregate_id   uuid        NOT NULL,
    event_type     varchar(64) NOT NULL,
    payload        jsonb       NOT NULL,
    created_at     timestamptz(3) NOT NULL DEFAULT now(),
    published_at   timestamptz(3)
);

-- Partial index: the only interesting query is "what is still unpublished",
-- and this keeps that lookup cheap as the table grows.
CREATE INDEX outbox_events_unpublished_idx
    ON outbox_events (created_at) WHERE published_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx
    ON outbox_events (aggregate_type, aggregate_id);
