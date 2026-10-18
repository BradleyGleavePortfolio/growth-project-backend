// scripts/ci/rls-grant-floor.mjs
//
// RLSGRANTS: the grant floor for the public API roles (check f of
// scripts/ci/assert-rls-floor.mjs). One SELECT returning a JSON array with a
// row per right above the floor:
//   - anon or authenticated holds TRUNCATE, TRIGGER, REFERENCES or MAINTAIN on
//     any public table, view or partition (table or column grant). Never allowed;
//   - anon holds INSERT, UPDATE or DELETE on one. Allowed only by a reviewed
//     "anonWrites" entry in scripts/ci/rls-known-gaps.json (may only shrink);
//   - a default privilege (role's, for new tables in public or in every schema)
//     would hand either of the above to the next new table. Never allowed.
// A grant to PUBLIC counts for both roles. Exported so the self-test can run
// the exact same query inside a transaction it rolls back.
export const GRANT_FLOOR_SQL = String.raw`
SELECT coalesce(json_agg(json_build_object('object', target, 'kind', kind, 'role', role, 'priv', priv)
         ORDER BY target, role, priv), '[]')
FROM (
  SELECT DISTINCT h.target, h.kind, r.role, h.privilege_type AS priv
  FROM (
    SELECT n.nspname || '.' || c.relname AS target, a.grantee, a.privilege_type,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table'
                          WHEN 'p' THEN 'partitioned table' ELSE 'table' END AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL (
      SELECT grantee, privilege_type FROM aclexplode(c.relacl)
      UNION ALL
      SELECT x.grantee, x.privilege_type FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) x
      WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
    ) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.oid NOT IN (SELECT objid FROM pg_depend WHERE deptype = 'e')
    UNION ALL
    SELECT 'default privileges of ' || pg_get_userbyid(d.defaclrole) || ' for new tables in ' || coalesce(n.nspname, 'every schema'),
           a.grantee, a.privilege_type, 'default privileges'
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype = 'r' AND (d.defaclnamespace = 0 OR n.nspname = 'public')
  ) h
  CROSS JOIN LATERAL unnest(CASE WHEN h.grantee = 0 THEN ARRAY['anon', 'authenticated']
                                 ELSE ARRAY[pg_get_userbyid(h.grantee)::text] END) r(role)
  WHERE (r.role IN ('anon', 'authenticated') AND h.privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN'))
     OR (r.role = 'anon' AND h.privilege_type IN ('INSERT', 'UPDATE', 'DELETE'))
) f`;

export const grantId = (f) => `${f.object} :: ${f.role} ${f.priv}`;
export const ANON_WRITES = ['INSERT', 'UPDATE', 'DELETE'];
