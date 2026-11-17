-- TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
--
-- NOT APPLIED. Run once, as the database owner, in the KelevoTMS production
-- database, after the owner approves this exact text. Replace
-- __IRON_WING_ORG_ID__ (an integer) with Iron Wing's organization id first.
--
-- A function, not a view: Postgres does not tie a plpgsql body to columns, so
-- KelevoTMS migrations that alter or drop columns still run. If a column
-- changes, calling the function fails (billing stops) instead of a deploy.

BEGIN;

CREATE ROLE iwd_billing_ro LOGIN CONNECTION LIMIT 2;
ALTER ROLE iwd_billing_ro SET statement_timeout = '20s';
GRANT USAGE ON SCHEMA public TO iwd_billing_ro;

CREATE OR REPLACE FUNCTION public.iwd_billing_loads(from_ts timestamptz, to_ts timestamptz)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET timezone = 'UTC'
AS $$
BEGIN
    RETURN (
        SELECT coalesce(json_agg(r ORDER BY r.id), '[]'::json)
        FROM (
            SELECT
                l.id,
                l.load_number,
                l.status::text AS status,
                l.driver_id,
                l.truck_id,
                l.rate::text AS rate,
                coalesce(l.currency, 'USD') AS currency,
                s.linehaul_amount::text AS entered_linehaul,
                to_char(l.delivered_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
                to_char(l.delivery_end, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivery_end,
                to_char(l.canceled_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS canceled_at
            FROM public."load" l
            LEFT JOIN public.settlement_load_input s
                ON s.organization_id = l.organization_id AND s.load_id = l.id
            WHERE l.organization_id = __IRON_WING_ORG_ID__
              AND l.deleted_at IS NULL
              AND l.status::text IN ('DELIVERED', 'PAID', 'CANCELED')
              AND (
                    (coalesce(l.delivered_at, l.delivery_end) >= from_ts
                     AND coalesce(l.delivered_at, l.delivery_end) < to_ts)
                 OR (l.canceled_at >= from_ts AND l.canceled_at < to_ts)
                 OR (l.status::text = 'CANCELED' AND l.canceled_at IS NULL)
              )
        ) r
    );
END
$$;

REVOKE ALL ON FUNCTION public.iwd_billing_loads(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.iwd_billing_loads(timestamptz, timestamptz) TO iwd_billing_ro;

COMMIT;

-- Disposal (see DISPOSE.md):
--   DROP FUNCTION public.iwd_billing_loads(timestamptz, timestamptz);
--   REVOKE USAGE ON SCHEMA public FROM iwd_billing_ro;
--   DROP ROLE iwd_billing_ro;
