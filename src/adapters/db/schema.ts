// Drizzle tables. Money and rates are `text` holding exact decimals (DECIMAL_PATTERN), never
// `numeric`: DSQL's bare `numeric` is numeric(18,6) and rounds silently. No foreign keys, by
// decision (ADR 0003): integrity lives in the domain, as it does in Dexie and SwiftData.
export {}
