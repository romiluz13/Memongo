# MongoDB Manual — Time Series Collections (captured sections)

- source: https://www.mongodb.com/docs/manual/core/timeseries-collections/
- accessed: 2026-09-06 (Wave 1a compare phase — measurement-fields claim for
  the AccessEventDocument identity extension)
- capture scope: the measurement/metaField contract relied on for W01;
  verbatim quotes.

## Measurements

> Measurements: Documents that contain data for all metrics at a specific
> point in time. A measurement includes the time, metadata, and all
> metrics recorded at that moment.

The page's example measurement document carries the timestamp, a metaField
object, and multiple top-level metric fields (temperature, humidity,
pressure, windSpeed, windDirection) — i.e. arbitrary top-level metrics per
measurement are the documented shape.

## metaField

> Metadata is stored in a metaField. You cannot add a metaField field to a
> time series document after you create it.

## Updates

> Match expressions in update commands can only specify the metaField. You
> can't update other fields in a time series document.

## Application to W01 (analysis, not doc text)

The W01 fix adds optional top-level metric fields (scope, scopeRef, type)
to inserted access-event measurement documents. The metaField structure
({agentId, collection}) is unchanged, so the "cannot add a metaField
field" restriction is not touched; the access_events collection is
insert-only from the tracker, so the update limitation does not apply.
Live round-trip verified in the GREEN probe (raw events read back with
scope/scopeRef/type).
