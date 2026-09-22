// A service version's lifecycle status against the tenant's technology catalog, as a SQL
// expression over an alias `s` exposing `technology` and `version` columns. Dependency-free so the
// technology overview (public-accounts.ts) and the contact filter (contacts.ts `tech_eol`) agree.
//
//   1. an exact catalog version wins; else the most specific catalog version that PREFIXES it
//      ("16" covers "16.4") — but only a leaf entry: a family alias like go "1" (next to "1.22")
//      doesn't vouch for an unlisted "1.21";
//   2. rolling tags (latest/canary/nightly/stable) and a versionless service of a catalogued
//      technology (object-storage) are supported;
//   3. otherwise: 'eol' when the catalog is imported from Zerops (not offered anymore = end of
//      life), 'unknown' for a manually pushed catalog.
// technology_versions / technologies / technology_catalog are RLS-scoped, so the correlated
// lookups only ever see the current tenant's catalog.
export function versionStatusSql(s: string): string {
  return `COALESCE(
    (SELECT tv.status FROM technology_versions tv
      WHERE tv.technology = ${s}.technology
        AND (${s}.version = tv.version
             OR (${s}.version LIKE tv.version || '.%'
                 AND NOT EXISTS (SELECT 1 FROM technology_versions tvc
                                  WHERE tvc.technology = tv.technology AND tvc.version LIKE tv.version || '.%')))
      ORDER BY (${s}.version = tv.version) DESC, length(tv.version) DESC
      LIMIT 1),
    CASE
      WHEN ${s}.version IN ('latest', 'canary', 'nightly', 'stable') THEN 'supported'
      WHEN ${s}.version = '' AND EXISTS (SELECT 1 FROM technologies tk WHERE tk.key = ${s}.technology) THEN 'supported'
      WHEN EXISTS (SELECT 1 FROM technology_catalog tcat WHERE tcat.source = 'zerops') THEN 'eol'
      ELSE 'unknown'
    END)`;
}
