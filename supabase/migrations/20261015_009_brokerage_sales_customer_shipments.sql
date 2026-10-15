-- DEBOSS GLOBAL: Brokerage Sales customer shipment lifecycle values.
-- Run before 20261015_010_brokerage_sales_customer_shipments_backfill.sql.

-- This migration intentionally only adds enum values. PostgreSQL requires a
-- commit before a new enum value can be used as a default or in a backfill.
alter type public.shipment_stage add value if not exists 'QUOTED' before 'BOOKED';
alter type public.shipment_stage add value if not exists 'PAID' after 'DELIVERED';
