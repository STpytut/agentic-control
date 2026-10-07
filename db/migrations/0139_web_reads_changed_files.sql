-- The step card lists the reviewed diff's files (rc.127), from
-- review_evidence.changed_files: paths and line counts. 0131 granted infra_web
-- four columns of review_evidence and not this one, and on rc.127 every chat
-- with a review failed on the host with "permission denied". The grant was made
-- by hand there on 2026-10-07; this records it. web-table-reads.test.mjs now
-- checks the columns the panel reads, not only the tables.

SET search_path TO control_plane, public, extensions;

GRANT SELECT (changed_files) ON review_evidence TO infra_web;
