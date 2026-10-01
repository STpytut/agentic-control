-- The panel reads the publish rows it shows (Stage 11.4 sprint B P1, rc.56 fix).
--
-- 0085's card reads the task's latest prepared publish and its intent from
-- publish_preparations and publish_intents, as infra_web — which had SELECT on
-- neither. Every project page with an active task then failed with
-- "permission denied for table publish_preparations" on the host (rc.56). The
-- web role reads each table it shows by an explicit grant (0038, 0063, 0070,
-- 0071); these two are read, never written, by it.

SET search_path TO control_plane, public, extensions;

GRANT SELECT ON publish_preparations, publish_intents TO infra_web;
