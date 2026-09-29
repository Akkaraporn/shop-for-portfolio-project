-- ---------------------------------------------------------------------------
-- Proves the schema's guarantees actually hold, by trying to break them.
--
--   make db-verify
--
-- Not a migration, and deliberately outside migrations/ so Flyway does not even
-- scan it. It is the answer to
-- "the CHECK constraint is there" versus "the CHECK constraint works". A
-- constraint nobody has ever seen reject anything is a comment.
--
-- Every block below attempts an illegal write inside a savepoint, catches the
-- rejection, and fails loudly if the write was *allowed*. Nothing is left
-- behind: the whole thing runs in one transaction that rolls back at the end.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE
    v_variant_id uuid;
    v_product_id uuid;
    v_user_id    uuid;
    v_order_id   uuid;
    -- A check "passes" when the database refuses the illegal write. It fails
    -- when the write is allowed through.
    v_passed     integer := 0;
    v_failed     integer := 0;
BEGIN
    SELECT id INTO v_variant_id FROM product_variants WHERE sku = 'TEE-CR-M';
    SELECT id INTO v_product_id FROM products WHERE slug = 'crewneck-organic-tee';
    SELECT id INTO v_user_id    FROM users WHERE email = 'somchai@example.com';

    IF v_variant_id IS NULL THEN
        RAISE EXCEPTION 'seed data missing — run `make clean && make up-node` first';
    END IF;

    -- ===================================================================
    -- 1. stock_reserved may never exceed stock_on_hand.
    --    The one that matters most: it is the last line of defence if the
    --    locking is wrong in both backends at once.
    -- ===================================================================
    BEGIN
        UPDATE product_variants
        SET stock_reserved = stock_on_hand + 1
        WHERE id = v_variant_id;
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: reserved > on_hand was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: reserved > on_hand rejected';
    END;

    -- Reserving exactly everything is legal, and must stay legal — the boundary
    -- is <=, not <. A constraint that is one off here would break the very last
    -- unit of every product.
    BEGIN
        UPDATE product_variants
        SET stock_reserved = stock_on_hand
        WHERE id = v_variant_id;
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: reserving the full quantity allowed';
        UPDATE product_variants SET stock_reserved = 0 WHERE id = v_variant_id;
    EXCEPTION WHEN check_violation THEN
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: reserving exactly stock_on_hand was rejected';
    END;

    -- Dropping on-hand below what is already reserved is the same violation
    -- seen from the other direction — the admin stock-adjustment path.
    BEGIN
        UPDATE product_variants SET stock_reserved = 5 WHERE id = v_variant_id;
        UPDATE product_variants SET stock_on_hand  = 2 WHERE id = v_variant_id;
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: on_hand dropped below reserved';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: on_hand below reserved rejected';
    END;
    UPDATE product_variants SET stock_reserved = 0 WHERE id = v_variant_id;

    -- Negative stock.
    BEGIN
        UPDATE product_variants SET stock_on_hand = -1 WHERE id = v_variant_id;
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: negative stock_on_hand was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: negative stock rejected';
    END;

    -- ===================================================================
    -- 2. A basket belongs to a user or to a guest token, never both.
    -- ===================================================================
    BEGIN
        INSERT INTO carts (user_id, token_hash, expires_at)
        VALUES (v_user_id, repeat('a', 64), now() + interval '7 days');
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: cart with both an owner and a guest token was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: cart with two owners rejected';
    END;

    BEGIN
        INSERT INTO carts (user_id, token_hash, expires_at) VALUES (NULL, NULL, NULL);
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: ownerless cart was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: ownerless cart rejected';
    END;

    -- A guest basket must carry an expiry, or the sweeper can never collect it.
    BEGIN
        INSERT INTO carts (token_hash, expires_at) VALUES (repeat('b', 64), NULL);
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: guest cart without an expiry was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: guest cart without expiry rejected';
    END;

    -- ===================================================================
    -- 3. Cart quantities stay inside 1..99.
    -- ===================================================================
    DECLARE
        v_cart_id uuid;
    BEGIN
        INSERT INTO carts (token_hash, expires_at)
        VALUES (repeat('c', 64), now() + interval '7 days')
        RETURNING id INTO v_cart_id;

        BEGIN
            INSERT INTO cart_items (cart_id, variant_id, quantity)
            VALUES (v_cart_id, v_variant_id, 100);
            v_failed := v_failed + 1;
            RAISE WARNING 'FAIL: cart quantity 100 was allowed';
        EXCEPTION WHEN check_violation THEN
            v_passed := v_passed + 1;
            RAISE NOTICE 'ok: cart quantity above 99 rejected';
        END;

        BEGIN
            INSERT INTO cart_items (cart_id, variant_id, quantity)
            VALUES (v_cart_id, v_variant_id, 0);
            v_failed := v_failed + 1;
            RAISE WARNING 'FAIL: cart quantity 0 was allowed';
        EXCEPTION WHEN check_violation THEN
            v_passed := v_passed + 1;
            RAISE NOTICE 'ok: cart quantity 0 rejected';
        END;

        -- One line per variant per basket: this uniqueness is what makes the
        -- add-to-cart upsert correct rather than duplicating lines.
        INSERT INTO cart_items (cart_id, variant_id, quantity)
        VALUES (v_cart_id, v_variant_id, 1);
        BEGIN
            INSERT INTO cart_items (cart_id, variant_id, quantity)
            VALUES (v_cart_id, v_variant_id, 1);
            v_failed := v_failed + 1;
            RAISE WARNING 'FAIL: duplicate (cart, variant) line was allowed';
        EXCEPTION WHEN unique_violation THEN
            v_passed := v_passed + 1;
            RAISE NOTICE 'ok: duplicate cart line rejected';
        END;
    END;

    -- ===================================================================
    -- 4. Order arithmetic must add up, and the number must be well formed.
    -- ===================================================================
    BEGIN
        INSERT INTO orders (order_number, user_id, subtotal_cents, shipping_cents,
                            total_cents, shipping_address)
        VALUES ('ORD-2026-9000001', v_user_id, 10000, 5000, 99999, '{}'::jsonb);
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: order total not equal to subtotal + shipping was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: inconsistent order total rejected';
    END;

    BEGIN
        INSERT INTO orders (order_number, user_id, subtotal_cents, shipping_cents,
                            total_cents, shipping_address)
        VALUES ('ORDER-1', v_user_id, 10000, 5000, 15000, '{}'::jsonb);
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: malformed order number was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: malformed order number rejected';
    END;

    BEGIN
        INSERT INTO orders (order_number, user_id, status, subtotal_cents,
                            shipping_cents, total_cents, shipping_address)
        VALUES ('ORD-2026-9000002', v_user_id, 'shipped', 10000, 5000, 15000, '{}'::jsonb);
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: unknown order status was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: unknown order status rejected';
    END;

    -- ===================================================================
    -- 5. Order lines snapshot arithmetic.
    -- ===================================================================
    DECLARE
        v_line_order uuid;
    BEGIN
        INSERT INTO orders (order_number, user_id, subtotal_cents, shipping_cents,
                            total_cents, shipping_address)
        VALUES ('ORD-2026-9000003', v_user_id, 39000, 5000, 44000, '{}'::jsonb)
        RETURNING id INTO v_line_order;

        BEGIN
            INSERT INTO order_items (order_id, variant_id, product_id, product_name,
                                     variant_name, sku, unit_price_cents, quantity,
                                     line_total_cents)
            VALUES (v_line_order, v_variant_id, v_product_id, 'x', 'y', 'z',
                    39000, 2, 39000);
            v_failed := v_failed + 1;
            RAISE WARNING 'FAIL: line total not equal to price x quantity was allowed';
        EXCEPTION WHEN check_violation THEN
            v_passed := v_passed + 1;
            RAISE NOTICE 'ok: inconsistent line total rejected';
        END;

        v_order_id := v_line_order;
    END;

    -- ===================================================================
    -- 6. A variant referenced by order history cannot be deleted.
    --    This is what makes "archive, never delete" enforceable rather than a
    --    convention someone can forget.
    -- ===================================================================
    INSERT INTO order_items (order_id, variant_id, product_id, product_name,
                             variant_name, sku, unit_price_cents, quantity,
                             line_total_cents)
    VALUES (v_order_id, v_variant_id, v_product_id, 'เสื้อยืดคอกลม', 'ขาว / M',
            'TEE-CR-M', 39000, 1, 39000);

    BEGIN
        DELETE FROM product_variants WHERE id = v_variant_id;
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: deleting a variant with order history was allowed';
    EXCEPTION WHEN foreign_key_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: deleting an ordered variant rejected';
    END;

    BEGIN
        DELETE FROM products WHERE id = v_product_id;
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: deleting a product with order history was allowed';
    EXCEPTION WHEN foreign_key_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: deleting an ordered product rejected';
    END;

    -- ===================================================================
    -- 7. Webhook deduplication. The unique constraint *is* the mechanism, so
    --    if it does not hold, stock gets decremented twice.
    -- ===================================================================
    INSERT INTO webhook_events (provider, event_id, event_type, payload)
    VALUES ('mock', 'evt_dedupe_probe', 'payment.succeeded', '{}'::jsonb);
    BEGIN
        INSERT INTO webhook_events (provider, event_id, event_type, payload)
        VALUES ('mock', 'evt_dedupe_probe', 'payment.succeeded', '{}'::jsonb);
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: duplicate webhook event was allowed';
    EXCEPTION WHEN unique_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: duplicate webhook event rejected';
    END;

    -- And the form the handler actually uses must be the silent one.
    INSERT INTO webhook_events (provider, event_id, event_type, payload)
    VALUES ('mock', 'evt_dedupe_probe', 'payment.succeeded', '{}'::jsonb)
    ON CONFLICT (provider, event_id) DO NOTHING;
    v_passed := v_passed + 1;
    RAISE NOTICE 'ok: ON CONFLICT DO NOTHING absorbs the redelivery';

    -- ===================================================================
    -- 8. Idempotency keys are scoped per user, and a completed one must carry
    --    the response it is going to replay.
    -- ===================================================================
    INSERT INTO idempotency_keys (user_id, endpoint, idempotency_key, request_hash, expires_at)
    VALUES (v_user_id, 'POST /checkout', 'key-probe', repeat('d', 64), now() + interval '1 day');
    BEGIN
        INSERT INTO idempotency_keys (user_id, endpoint, idempotency_key, request_hash, expires_at)
        VALUES (v_user_id, 'POST /checkout', 'key-probe', repeat('e', 64), now() + interval '1 day');
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: duplicate idempotency key for one user was allowed';
    EXCEPTION WHEN unique_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: duplicate idempotency key rejected';
    END;

    BEGIN
        UPDATE idempotency_keys SET status = 'completed'
        WHERE user_id = v_user_id AND idempotency_key = 'key-probe';
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: completed idempotency key without a stored response was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: completed key without a response rejected';
    END;

    -- ===================================================================
    -- 9. A held reservation cannot already be resolved.
    -- ===================================================================
    BEGIN
        INSERT INTO stock_reservations (order_id, variant_id, quantity, status,
                                        expires_at, resolved_at)
        VALUES (v_order_id, v_variant_id, 1, 'held',
                now() + interval '15 minutes', now());
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: held reservation with a resolved_at was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: held-but-resolved reservation rejected';
    END;

    -- ===================================================================
    -- 10. Currency is pinned to THB.
    -- ===================================================================
    BEGIN
        UPDATE products SET currency = 'USD' WHERE id = v_product_id;
        v_failed := v_failed + 1;
        RAISE WARNING 'FAIL: a non-THB currency was allowed';
    EXCEPTION WHEN check_violation THEN
        v_passed := v_passed + 1;
        RAISE NOTICE 'ok: non-THB currency rejected';
    END;

    -- ===================================================================
    RAISE NOTICE '---';
    IF v_failed > 0 THEN
        RAISE EXCEPTION 'constraint verification FAILED: % passed, % failed', v_passed, v_failed;
    END IF;
    RAISE NOTICE 'constraint verification passed: % checks', v_passed;
END
$$;

-- Nothing above is meant to persist.
ROLLBACK;
