# TS-018: Unkey Persisted Rate-Limit Buckets

## Metadata

- `id`: TS-018
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: rate-limit service, local counter windows, origin sync, cross-region denial propagation, MySQL schema, limiter tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 850-1,150
- `represented_diff_lines`: 1,140
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about counter identity, tenant scoping, window boundaries, origin sync, cross-region behavior, and recovery semantics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR persists recent rate-limit buckets to MySQL so gateway restarts do not lose in-memory counters.

Unkey's limiter currently keeps hot counters in memory and asynchronously syncs successful requests to the distributed origin counter. That is fast, but a regional gateway restart can briefly under-count recent accepted requests until the origin catches up. This PR adds a persisted minute-bucket table, records every successful rate-limit decision into that table, hydrates local counters from MySQL on startup, and exposes a small diagnostic query for recent bucket usage.

The PR adds:

- a `ratelimit_minute_buckets` table,
- SQL helpers to upsert and read persisted buckets,
- a `persistedBucketStore` used by the rate-limit service,
- limiter integration that writes buckets after successful checks,
- startup hydration for recent buckets,
- tests covering persistence, restart recovery, and namespace reuse.

## Existing Code Context

The real Unkey codebase has these relevant contracts:

- `internal/services/ratelimit/interface.go` documents that `WorkspaceID` scopes every other rate-limit field. Two workspaces using the same namespace and identifier must be isolated.
- `internal/services/ratelimit/keys.go` models `counterKey` as `(workspaceID, namespace, identifier, durationMs, sequence)` and its Redis key includes the workspace. The code comment explicitly says the workspace prevents two workspaces sharing a namespace string from colliding.
- `internal/services/ratelimit/sequence.go` converts `req.Time` to a fixed window sequence with `calculateSequence(req.Time, req.Duration)`.
- `internal/services/ratelimit/ratelimit.go` validates `WorkspaceID`, `Namespace`, `Identifier`, `Duration`, `Limit`, `Cost`, and `Time`, then computes the current and previous window keys from the request time.
- `internal/services/ratelimit/origin.go` replays accepted requests to the distributed origin using the same request time and same compound counter key.
- `pkg/mysql/schema/ratelimit_namespaces.sql` scopes namespace rows by `workspace_id`.
- `pkg/clickhouse/schema/006_ratelimits_raw_v2.sql` records raw rate-limit events with `workspace_id`, `namespace_id`, `identifier`, and reset timing.
- Cross-region denial propagation already has a separate blocklist path. It writes rows keyed by workspace, namespace, identifier, duration, and sequence only after a denial transition.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `pkg/mysql/schema/ratelimit_minute_buckets.sql`
- `pkg/db/queries/ratelimit_buckets.sql`
- `internal/services/ratelimit/persisted_bucket.go`
- `internal/services/ratelimit/service.go`
- `internal/services/ratelimit/ratelimit.go`
- `internal/services/ratelimit/origin.go`
- `internal/services/ratelimit/persisted_bucket_test.go`

The line references below use synthetic PR line numbers. The represented diff is focused on counter identity, window calculation, persistence semantics, and recovery behavior.

## Diff

```diff
diff --git a/pkg/mysql/schema/ratelimit_minute_buckets.sql b/pkg/mysql/schema/ratelimit_minute_buckets.sql
new file mode 100644
index 0000000000..bda9237a10
--- /dev/null
+++ b/pkg/mysql/schema/ratelimit_minute_buckets.sql
@@ -0,0 +1,118 @@
+CREATE TABLE IF NOT EXISTS ratelimit_minute_buckets (
+  id varchar(255) NOT NULL,
+  workspace_id varchar(255) NOT NULL,
+  namespace varchar(255) NOT NULL,
+  identifier varchar(255) NOT NULL,
+  region varchar(64) NOT NULL DEFAULT '',
+  bucket_start_ms bigint unsigned NOT NULL,
+  bucket_end_ms bigint unsigned NOT NULL,
+  limit_value bigint unsigned NOT NULL,
+  duration_ms bigint unsigned NOT NULL,
+  accepted bigint unsigned NOT NULL DEFAULT 0,
+  denied bigint unsigned NOT NULL DEFAULT 0,
+  cost bigint unsigned NOT NULL DEFAULT 0,
+  last_request_at bigint unsigned NOT NULL,
+  expires_at bigint unsigned NOT NULL,
+  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
+  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
+  PRIMARY KEY (id),
+  UNIQUE KEY ratelimit_minute_buckets_identity_idx (
+    namespace,
+    identifier,
+    bucket_start_ms
+  ),
+  KEY ratelimit_minute_buckets_workspace_recent_idx (
+    workspace_id,
+    bucket_start_ms
+  ),
+  KEY ratelimit_minute_buckets_expiry_idx (
+    expires_at
+  )
+) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
+
+CREATE TABLE IF NOT EXISTS ratelimit_minute_bucket_hydration_runs (
+  id varchar(255) NOT NULL,
+  region varchar(64) NOT NULL,
+  started_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
+  completed_at timestamp(3) NULL,
+  rows_loaded int unsigned NOT NULL DEFAULT 0,
+  PRIMARY KEY (id),
+  KEY ratelimit_minute_bucket_hydration_runs_region_idx (region, started_at)
+) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
+
+CREATE EVENT IF NOT EXISTS ratelimit_minute_buckets_cleanup
+ON SCHEDULE EVERY 5 MINUTE
+DO
+  DELETE FROM ratelimit_minute_buckets
+  WHERE expires_at < UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000;
+
+-- The bucket table is intentionally compact. It stores one row per subject per
+-- minute and lets the service reconstruct in-memory counters after a restart.
+-- The persisted bucket is not meant to replace Redis as the origin counter.
+--
+-- The diagnostic query in pkg/db/queries/ratelimit_buckets.sql reads this table
+-- for recent hot keys. Dashboard-facing analytics continue to use ClickHouse.
+--
+-- Example:
+--
+-- namespace     identifier     bucket_start_ms     accepted
+-- tokens        user_123       1778932320000       93
+-- tokens        user_456       1778932320000       12
+--
+-- The same subject will have at most one bucket per minute.
+--
+-- Operational notes:
+--
+-- * The cleanup event keeps only active windows plus a short grace period.
+-- * The table is small enough to read on regional gateway startup.
+-- * The service writes with INSERT .. ON DUPLICATE KEY UPDATE.
+-- * Hydration ignores expired rows.
+-- * The schema is additive and can be deployed before application code.
+--
+-- Rollback:
+--
+-- * Stop writing from the service.
+-- * Drop the cleanup event.
+-- * Drop the two tables after all gateway pods have rolled back.
+--
+-- This migration intentionally does not backfill historical rate-limit events.
+-- Only buckets created after deployment are eligible for restart recovery.
+--
+-- A future migration can add materialized dashboard rollups if product wants
+-- persisted rate-limit diagnostics beyond the last few windows.
+--
+-- The service treats bucket_start_ms and bucket_end_ms as unix milliseconds.
+-- All cleanup decisions compare against unix milliseconds as well.
+--
+-- The row id is generated by the application because the rate-limit service
+-- already has stable key material when it decides a request.
+--
+-- Hydration rows are recorded for operational visibility only. A failed
+-- hydration run does not block the gateway from serving traffic.
+--
+-- NOTE: This table should remain write-light. It sits in the request path.
+-- Do not add secondary indexes without measuring hot-key write amplification.
+--
+-- Query examples:
+--
+-- SELECT * FROM ratelimit_minute_buckets
+-- WHERE workspace_id = 'ws_123'
+-- ORDER BY bucket_start_ms DESC
+-- LIMIT 20;
+--
+-- SELECT SUM(accepted), SUM(denied)
+-- FROM ratelimit_minute_buckets
+-- WHERE namespace = 'tokens'
+--   AND identifier = 'user_123';
+--
+-- SELECT COUNT(*)
+-- FROM ratelimit_minute_buckets
+-- WHERE expires_at < UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000;
+--
+-- The cleanup event is best effort. The rate-limit service never trusts rows
+-- whose expires_at is in the past.
+--
+-- End of migration.
diff --git a/pkg/db/queries/ratelimit_buckets.sql b/pkg/db/queries/ratelimit_buckets.sql
new file mode 100644
index 0000000000..2eebf6b3bb
--- /dev/null
+++ b/pkg/db/queries/ratelimit_buckets.sql
@@ -0,0 +1,168 @@
+-- name: RatelimitBucketUpsert :exec
+INSERT INTO ratelimit_minute_buckets (
+  id,
+  workspace_id,
+  namespace,
+  identifier,
+  region,
+  bucket_start_ms,
+  bucket_end_ms,
+  limit_value,
+  duration_ms,
+  accepted,
+  denied,
+  cost,
+  last_request_at,
+  expires_at
+)
+VALUES (
+  sqlc.arg(id),
+  sqlc.arg(workspace_id),
+  sqlc.arg(namespace),
+  sqlc.arg(identifier),
+  sqlc.arg(region),
+  sqlc.arg(bucket_start_ms),
+  sqlc.arg(bucket_end_ms),
+  sqlc.arg(limit_value),
+  sqlc.arg(duration_ms),
+  sqlc.arg(accepted),
+  sqlc.arg(denied),
+  sqlc.arg(cost),
+  sqlc.arg(last_request_at),
+  sqlc.arg(expires_at)
+)
+ON DUPLICATE KEY UPDATE
+  accepted = accepted + VALUES(accepted),
+  denied = denied + VALUES(denied),
+  cost = cost + VALUES(cost),
+  limit_value = VALUES(limit_value),
+  duration_ms = VALUES(duration_ms),
+  bucket_end_ms = VALUES(bucket_end_ms),
+  last_request_at = GREATEST(last_request_at, VALUES(last_request_at)),
+  expires_at = GREATEST(expires_at, VALUES(expires_at)),
+  updated_at = CURRENT_TIMESTAMP(3);
+
+-- name: RatelimitBucketGet :one
+SELECT
+  id,
+  workspace_id,
+  namespace,
+  identifier,
+  region,
+  bucket_start_ms,
+  bucket_end_ms,
+  limit_value,
+  duration_ms,
+  accepted,
+  denied,
+  cost,
+  last_request_at,
+  expires_at,
+  created_at,
+  updated_at
+FROM ratelimit_minute_buckets
+WHERE namespace = sqlc.arg(namespace)
+  AND identifier = sqlc.arg(identifier)
+  AND bucket_start_ms = sqlc.arg(bucket_start_ms)
+LIMIT 1;
+
+-- name: RatelimitBucketListRecentForWorkspace :many
+SELECT
+  id,
+  workspace_id,
+  namespace,
+  identifier,
+  region,
+  bucket_start_ms,
+  bucket_end_ms,
+  limit_value,
+  duration_ms,
+  accepted,
+  denied,
+  cost,
+  last_request_at,
+  expires_at,
+  created_at,
+  updated_at
+FROM ratelimit_minute_buckets
+WHERE workspace_id = sqlc.arg(workspace_id)
+  AND expires_at >= sqlc.arg(now_ms)
+ORDER BY bucket_start_ms DESC, accepted DESC
+LIMIT sqlc.arg(limit_rows);
+
+-- name: RatelimitBucketListActiveForHydration :many
+SELECT
+  id,
+  workspace_id,
+  namespace,
+  identifier,
+  region,
+  bucket_start_ms,
+  bucket_end_ms,
+  limit_value,
+  duration_ms,
+  accepted,
+  denied,
+  cost,
+  last_request_at,
+  expires_at,
+  created_at,
+  updated_at
+FROM ratelimit_minute_buckets
+WHERE expires_at >= sqlc.arg(now_ms)
+ORDER BY bucket_start_ms DESC
+LIMIT sqlc.arg(limit_rows);
+
+-- name: RatelimitBucketDeleteExpired :execrows
+DELETE FROM ratelimit_minute_buckets
+WHERE expires_at < sqlc.arg(now_ms)
+LIMIT sqlc.arg(limit_rows);
+
+-- name: RatelimitBucketHydrationRunCreate :exec
+INSERT INTO ratelimit_minute_bucket_hydration_runs (
+  id,
+  region
+) VALUES (
+  sqlc.arg(id),
+  sqlc.arg(region)
+);
+
+-- name: RatelimitBucketHydrationRunComplete :exec
+UPDATE ratelimit_minute_bucket_hydration_runs
+SET
+  completed_at = CURRENT_TIMESTAMP(3),
+  rows_loaded = sqlc.arg(rows_loaded)
+WHERE id = sqlc.arg(id);
+
+-- name: RatelimitBucketListForSubject :many
+SELECT
+  id,
+  workspace_id,
+  namespace,
+  identifier,
+  region,
+  bucket_start_ms,
+  bucket_end_ms,
+  limit_value,
+  duration_ms,
+  accepted,
+  denied,
+  cost,
+  last_request_at,
+  expires_at,
+  created_at,
+  updated_at
+FROM ratelimit_minute_buckets
+WHERE namespace = sqlc.arg(namespace)
+  AND identifier = sqlc.arg(identifier)
+  AND expires_at >= sqlc.arg(now_ms)
+ORDER BY bucket_start_ms DESC
+LIMIT sqlc.arg(limit_rows);
+
+-- name: RatelimitBucketCountActive :one
+SELECT COUNT(*) AS active_count
+FROM ratelimit_minute_buckets
+WHERE expires_at >= sqlc.arg(now_ms);
+
+-- name: RatelimitBucketRecentHotKeys :many
+SELECT
+  namespace,
+  identifier,
+  SUM(accepted) AS accepted,
+  SUM(denied) AS denied,
+  MAX(last_request_at) AS last_request_at
+FROM ratelimit_minute_buckets
+WHERE expires_at >= sqlc.arg(now_ms)
+GROUP BY namespace, identifier
+ORDER BY accepted DESC
+LIMIT sqlc.arg(limit_rows);
diff --git a/internal/services/ratelimit/persisted_bucket.go b/internal/services/ratelimit/persisted_bucket.go
new file mode 100644
index 0000000000..3db5328612
--- /dev/null
+++ b/internal/services/ratelimit/persisted_bucket.go
@@ -0,0 +1,283 @@
+package ratelimit
+
+import (
+	"context"
+	"crypto/sha1"
+	"encoding/hex"
+	"fmt"
+	"time"
+
+	"github.com/unkeyed/unkey/pkg/db"
+	"github.com/unkeyed/unkey/pkg/logger"
+)
+
+type persistedBucketDB interface {
+	RatelimitBucketUpsert(ctx context.Context, arg db.RatelimitBucketUpsertParams) error
+	RatelimitBucketGet(ctx context.Context, arg db.RatelimitBucketGetParams) (db.RatelimitBucket, error)
+	RatelimitBucketListActiveForHydration(ctx context.Context, arg db.RatelimitBucketListActiveForHydrationParams) ([]db.RatelimitBucket, error)
+	RatelimitBucketHydrationRunCreate(ctx context.Context, id string, region string) error
+	RatelimitBucketHydrationRunComplete(ctx context.Context, id string, rowsLoaded int32) error
+}
+
+type persistedBucketStore struct {
+	db     persistedBucketDB
+	region string
+}
+
+type persistedBucketWrite struct {
+	WorkspaceID   string
+	Namespace     string
+	Identifier    string
+	Limit         int64
+	Duration      time.Duration
+	Cost          int64
+	Accepted      bool
+	RequestTime   time.Time
+	EffectiveUsed int64
+}
+
+type hydratedBucket struct {
+	WorkspaceID string
+	Namespace   string
+	Identifier  string
+	Limit       int64
+	Duration    time.Duration
+	Sequence    int64
+	Count       int64
+}
+
+func newPersistedBucketStore(db persistedBucketDB, region string) *persistedBucketStore {
+	if db == nil {
+		return nil
+	}
+	return &persistedBucketStore{
+		db:     db,
+		region: region,
+	}
+}
+
+func (s *persistedBucketStore) write(ctx context.Context, req persistedBucketWrite) {
+	if s == nil {
+		return
+	}
+
+	start, end := bucketWindowForRequest(req.RequestTime)
+	id := bucketID(req.Namespace, req.Identifier, start)
+
+	accepted := uint64(0)
+	denied := uint64(0)
+	if req.Accepted {
+		accepted = 1
+	} else {
+		denied = 1
+	}
+
+	cost := req.Cost
+	if cost < 0 {
+		cost = 0
+	}
+
+	err := s.db.RatelimitBucketUpsert(ctx, db.RatelimitBucketUpsertParams{
+		ID:            id,
+		WorkspaceID:   req.WorkspaceID,
+		Namespace:     req.Namespace,
+		Identifier:    req.Identifier,
+		Region:        s.region,
+		BucketStartMs: uint64(start.UnixMilli()),
+		BucketEndMs:   uint64(end.UnixMilli()),
+		LimitValue:    uint64(req.Limit),
+		DurationMs:    uint64(req.Duration.Milliseconds()),
+		Accepted:      accepted,
+		Denied:        denied,
+		Cost:          uint64(cost),
+		LastRequestAt: uint64(time.Now().UnixMilli()),
+		ExpiresAt:     uint64(end.Add(req.Duration).UnixMilli()),
+	})
+	if err != nil {
+		logger.Error("failed to persist ratelimit bucket",
+			"workspace_id", req.WorkspaceID,
+			"namespace", req.Namespace,
+			"identifier", req.Identifier,
+			"bucket_start", start.UnixMilli(),
+			"error", err.Error(),
+		)
+	}
+}
+
+func (s *persistedBucketStore) get(ctx context.Context, namespace, identifier string, requestTime time.Time) (db.RatelimitBucket, bool) {
+	if s == nil {
+		return db.RatelimitBucket{}, false
+	}
+	start, _ := bucketWindowForRequest(requestTime)
+	row, err := s.db.RatelimitBucketGet(ctx, db.RatelimitBucketGetParams{
+		Namespace:     namespace,
+		Identifier:    identifier,
+		BucketStartMs: uint64(start.UnixMilli()),
+	})
+	if err != nil {
+		return db.RatelimitBucket{}, false
+	}
+	if row.ExpiresAt < uint64(time.Now().UnixMilli()) {
+		return db.RatelimitBucket{}, false
+	}
+	return row, true
+}
+
+func (s *persistedBucketStore) hydrate(ctx context.Context, limitRows int32) ([]hydratedBucket, error) {
+	if s == nil {
+		return nil, nil
+	}
+	runID := fmt.Sprintf("rhb_%d", time.Now().UnixNano())
+	err := s.db.RatelimitBucketHydrationRunCreate(ctx, runID, s.region)
+	if err != nil {
+		logger.Error("failed to record ratelimit hydration start", "error", err.Error())
+	}
+
+	rows, err := s.db.RatelimitBucketListActiveForHydration(ctx, db.RatelimitBucketListActiveForHydrationParams{
+		NowMs:     uint64(time.Now().UnixMilli()),
+		LimitRows: limitRows,
+	})
+	if err != nil {
+		return nil, err
+	}
+
+	buckets := make([]hydratedBucket, 0, len(rows))
+	for _, row := range rows {
+		duration := time.Duration(row.DurationMs) * time.Millisecond
+		if duration <= 0 {
+			duration = time.Minute
+		}
+		sequence := int64(row.BucketStartMs / row.DurationMs)
+		buckets = append(buckets, hydratedBucket{
+			WorkspaceID: row.WorkspaceID,
+			Namespace:   row.Namespace,
+			Identifier:  row.Identifier,
+			Limit:       int64(row.LimitValue),
+			Duration:    duration,
+			Sequence:    sequence,
+			Count:       int64(row.Cost),
+		})
+	}
+
+	err = s.db.RatelimitBucketHydrationRunComplete(ctx, runID, int32(len(buckets)))
+	if err != nil {
+		logger.Error("failed to record ratelimit hydration completion", "error", err.Error())
+	}
+	return buckets, nil
+}
+
+func (s *persistedBucketStore) debugSubject(ctx context.Context, namespace, identifier string, at time.Time) (int64, bool) {
+	row, ok := s.get(ctx, namespace, identifier, at)
+	if !ok {
+		return 0, false
+	}
+	return int64(row.Cost), true
+}
+
+func bucketWindowForRequest(requestTime time.Time) (time.Time, time.Time) {
+	now := time.Now()
+	if requestTime.IsZero() {
+		requestTime = now
+	}
+	start := now.Truncate(time.Minute)
+	end := start.Add(time.Minute)
+	return start, end
+}
+
+func bucketID(namespace, identifier string, start time.Time) string {
+	sum := sha1.Sum([]byte(fmt.Sprintf("%s:%s:%d", namespace, identifier, start.UnixMilli())))
+	return "rlb_" + hex.EncodeToString(sum[:])
+}
+
+func bucketWriteFromRequest(req RatelimitRequest, success bool, used int64) persistedBucketWrite {
+	return persistedBucketWrite{
+		WorkspaceID:   req.WorkspaceID,
+		Namespace:     req.Namespace,
+		Identifier:    req.Identifier,
+		Limit:         req.Limit,
+		Duration:      req.Duration,
+		Cost:          req.Cost,
+		Accepted:      success,
+		RequestTime:   req.Time,
+		EffectiveUsed: used,
+	}
+}
+
+func hydrateCounterKey(row hydratedBucket) counterKey {
+	return counterKey{
+		workspaceID: row.WorkspaceID,
+		namespace:   row.Namespace,
+		identifier:  row.Identifier,
+		durationMs:  row.Duration.Milliseconds(),
+		sequence:    row.Sequence,
+	}
+}
+
+func (s *service) hydratePersistedBuckets(ctx context.Context) {
+	if s.persistedBuckets == nil {
+		return
+	}
+	rows, err := s.persistedBuckets.hydrate(ctx, 10_000)
+	if err != nil {
+		logger.Error("failed to hydrate persisted ratelimit buckets", "error", err.Error())
+		return
+	}
+	for _, row := range rows {
+		key := hydrateCounterKey(row)
+		counter := s.loadCounter(key)
+		atomicMax(&counter.val, row.Count)
+	}
+	logger.Info("hydrated persisted ratelimit buckets", "count", len(rows))
+}
+
+func (s *service) maybeHydratePersistedBucket(ctx context.Context, req RatelimitRequest) {
+	if s.persistedBuckets == nil {
+		return
+	}
+	row, ok := s.persistedBuckets.get(ctx, req.Namespace, req.Identifier, req.Time)
+	if !ok {
+		return
+	}
+	duration := time.Duration(row.DurationMs) * time.Millisecond
+	if duration <= 0 {
+		duration = req.Duration
+	}
+	sequence := int64(row.BucketStartMs / row.DurationMs)
+	key := counterKey{
+		workspaceID: req.WorkspaceID,
+		namespace:   req.Namespace,
+		identifier:  req.Identifier,
+		durationMs:  duration.Milliseconds(),
+		sequence:    sequence,
+	}
+	counter := s.loadCounter(key)
+	atomicMax(&counter.val, int64(row.Cost))
+}
+
+func (s *service) persistRatelimitDecision(ctx context.Context, req RatelimitRequest, success bool, used int64) {
+	if s.persistedBuckets == nil {
+		return
+	}
+	s.persistedBuckets.write(ctx, bucketWriteFromRequest(req, success, used))
+}
+
+func bucketDebugLogFields(req RatelimitRequest) []any {
+	start, end := bucketWindowForRequest(req.Time)
+	return []any{
+		"workspace_id", req.WorkspaceID,
+		"namespace", req.Namespace,
+		"identifier", req.Identifier,
+		"bucket_start_ms", start.UnixMilli(),
+		"bucket_end_ms", end.UnixMilli(),
+		"duration_ms", req.Duration.Milliseconds(),
+	}
+}
+
+func (s *service) logPersistedBucketPreview(ctx context.Context, req RatelimitRequest) {
+	if s.persistedBuckets == nil {
+		return
+	}
+	count, ok := s.persistedBuckets.debugSubject(ctx, req.Namespace, req.Identifier, req.Time)
+	if !ok {
+		logger.Debug("ratelimit persisted bucket empty", bucketDebugLogFields(req)...)
+		return
+	}
+	fields := bucketDebugLogFields(req)
+	fields = append(fields, "persisted_count", count)
+	logger.Debug("ratelimit persisted bucket found", fields...)
+}
+
+func persistedBucketEnabled(region string, db persistedBucketDB) bool {
+	return region != "" && db != nil
+}
+
+func persistedBucketRegion(region string) string {
+	if region == "" {
+		return "unknown"
+	}
+	return region
+}
diff --git a/internal/services/ratelimit/service.go b/internal/services/ratelimit/service.go
index c81b760dd2..4d10e2f19c 100644
--- a/internal/services/ratelimit/service.go
+++ b/internal/services/ratelimit/service.go
@@ -144,6 +144,7 @@ type service struct {
 	blocklistWriter *batch.BatchProcessor[db.BlocklistInsertParams]
 
 	blocklistCircuitBreaker circuitbreaker.CircuitBreaker[any]
+	persistedBuckets *persistedBucketStore
 }
 
 // Config holds configuration for creating a new rate limiting service.
@@ -165,6 +166,15 @@ type Config struct {
 	// no adapter is needed.
 	DB DB
+
+	// Region identifies this gateway region for persisted local bucket rows.
+	// It is used for diagnostic filtering and hydration run visibility.
+	Region string
+
+	// PersistedBucketDB is optional. When provided, recent successful
+	// rate-limit decisions are written to MySQL so a gateway restart can
+	// rebuild hot counters before Redis replay catches up.
+	PersistedBucketDB persistedBucketDB
 }
 
 // New creates a new rate limiting service.
@@ -196,6 +206,7 @@ func New(config Config) (*service, error) {
 		blocklistCircuitBreaker: circuitbreaker.New[any]("ratelimit_blocklist_writes"),
 		db:                      db.New(config.DB.RW(), config.DB.RO()),
+		persistedBuckets:        newPersistedBucketStore(config.PersistedBucketDB, persistedBucketRegion(config.Region)),
 	}
 	s.blocklistWriter = batch.New[db.BlocklistInsertParams](batch.Config[db.BlocklistInsertParams]{
 		Name:          "ratelimit_blocklist",
@@ -213,6 +224,7 @@ func New(config Config) (*service, error) {
 	})
 	s.startBlocklistSync()
 
+	go s.hydratePersistedBuckets(context.Background())
 	s.startJanitor()
 
 	for range 8 {
@@ -232,6 +244,7 @@ func (s *service) Close() error {
 // Newly created entries carry a fetcher closure bound to the key, so callers
 // only need to invoke entry.Hydrate(ctx) to ensure the counter has been
 // populated from origin. Callers that skip Hydrate risk reading a zero-valued
+// counter. Persisted buckets are applied separately during startup hydration.
 // counter while another goroutine is mid-fetch.
 //
 // Counters created here are attributed to traffic via RatelimitWindowsCreated.
@@ -310,6 +323,8 @@ func (s *service) activateStrictMode(req RatelimitRequest, cs *checkState, effectiveCount int64) {
 		return
 	}
 
+	s.persistRatelimitDecision(context.Background(), req, false, effectiveCount)
+
 	if !cs.cur.blocked.CompareAndSwap(false, true) {
 		return
 	}
diff --git a/internal/services/ratelimit/ratelimit.go b/internal/services/ratelimit/ratelimit.go
index d2c6ea1b2f..96bbf6a817 100644
--- a/internal/services/ratelimit/ratelimit.go
+++ b/internal/services/ratelimit/ratelimit.go
@@ -32,6 +32,7 @@ func (s *service) Ratelimit(ctx context.Context, req RatelimitRequest) (RatelimitResponse, error) {
 		return RatelimitResponse{}, err
 	}
 
+	s.logPersistedBucketPreview(ctx, req)
 	cs := s.prepareCheck(req)
 	if cs.err != nil {
 		return RatelimitResponse{}, cs.err
@@ -40,6 +41,8 @@ func (s *service) Ratelimit(ctx context.Context, req RatelimitRequest) (RatelimitResponse, error) {
 	if cs.strict {
 		cs.cur.Hydrate(ctx)
 	}
+
+	s.maybeHydratePersistedBucket(ctx, req)
 
 	current := cs.cur.val.Load()
 	previous := cs.prev.val.Load()
@@ -59,6 +62,7 @@ func (s *service) Ratelimit(ctx context.Context, req RatelimitRequest) (RatelimitResponse, error) {
 		return RatelimitResponse{
 			Limit:     req.Limit,
 			Remaining: 0,
+			Reset:     time.UnixMilli((cs.curSequence + 1) * req.Duration.Milliseconds()),
 			Success:   false,
 			Current:   effectiveCount,
 		}, nil
@@ -76,6 +80,7 @@ func (s *service) Ratelimit(ctx context.Context, req RatelimitRequest) (RatelimitResponse, error) {
 		return RatelimitResponse{}, err
 	}
 
+	s.persistRatelimitDecision(context.Background(), req, true, newCount)
 	s.replayBuffer.Buffer(req)
 
 	return RatelimitResponse{
@@ -96,6 +101,7 @@ func (s *service) RatelimitMany(ctx context.Context, requests []RatelimitRequest) ([]RatelimitResponse, error) {
 	responses := make([]RatelimitResponse, len(requests))
 	checks := make([]checkState, len(requests))
 	for i, req := range requests {
+		s.logPersistedBucketPreview(ctx, req)
 		cs := s.prepareCheck(req)
 		if cs.err != nil {
 			return nil, cs.err
@@ -103,6 +109,7 @@ func (s *service) RatelimitMany(ctx context.Context, requests []RatelimitRequest) ([]RatelimitResponse, error) {
 		if cs.strict {
 			cs.cur.Hydrate(ctx)
 		}
+		s.maybeHydratePersistedBucket(ctx, req)
 		checks[i] = cs
 	}
 
@@ -141,6 +148,7 @@ func (s *service) RatelimitMany(ctx context.Context, requests []RatelimitRequest) ([]RatelimitResponse, error) {
 			responses[i] = RatelimitResponse{
 				Limit:     req.Limit,
 				Remaining: 0,
+				Reset:     time.UnixMilli((checks[i].curSequence + 1) * req.Duration.Milliseconds()),
 				Success:   false,
 				Current:   effectiveCount,
 			}
@@ -175,6 +183,7 @@ func (s *service) RatelimitMany(ctx context.Context, requests []RatelimitRequest) ([]RatelimitResponse, error) {
 		checks[i].cur.val.Add(req.Cost)
 		responses[i].Success = true
 		responses[i].Current = checks[i].cur.val.Load()
+		s.persistRatelimitDecision(context.Background(), req, true, responses[i].Current)
 		s.replayBuffer.Buffer(req)
 	}
 
@@ -218,6 +227,21 @@ func (s *service) prepareCheck(req RatelimitRequest) checkState {
 	durationMs := req.Duration.Milliseconds()
 	curSequence := calculateSequence(req.Time, req.Duration)
 	prevSequence := curSequence - 1
+
+	// Opportunistically prefer a persisted bucket if it exists. This lets a
+	// restarted gateway recover hot counters before Redis origin replay has
+	// converged. The request-time sequence is still used below for the in-memory
+	// counter keys, but hydration may raise those counters from MySQL.
+	if s.persistedBuckets != nil {
+		row, ok := s.persistedBuckets.get(context.Background(), req.Namespace, req.Identifier, req.Time)
+		if ok && int64(row.DurationMs) == durationMs {
+			curSequence = int64(row.BucketStartMs / row.DurationMs)
+			prevSequence = curSequence - 1
+		}
+	}
+
 	curKey := counterKey{
 		workspaceID: req.WorkspaceID,
 		namespace:   req.Namespace,
@@ -242,6 +266,16 @@ func (s *service) prepareCheck(req RatelimitRequest) checkState {
 		sequence:    prevSequence,
 	}
 
+	if s.persistedBuckets != nil {
+		row, ok := s.persistedBuckets.get(context.Background(), req.Namespace, req.Identifier, req.Time)
+		if ok {
+			logger.Debug("using persisted ratelimit bucket",
+				"workspace_id", req.WorkspaceID,
+				"namespace", req.Namespace,
+				"identifier", req.Identifier,
+				"bucket_start_ms", row.BucketStartMs)
+		}
+	}
 	cur := s.loadCounter(curKey)
 	prev := s.loadCounter(prevKey)
 	strictKey := strictKey{
diff --git a/internal/services/ratelimit/origin.go b/internal/services/ratelimit/origin.go
index 726c5e3f53..61dc333713 100644
--- a/internal/services/ratelimit/origin.go
+++ b/internal/services/ratelimit/origin.go
@@ -69,6 +69,12 @@ func (s *service) syncWithOrigin(ctx context.Context, req RatelimitRequest) error {
 		return err
 	}
 
+	if s.persistedBuckets != nil {
+		// Keep the persisted bucket warm even if a request was accepted before
+		// a regional crash and is being replayed after the fact.
+		s.persistRatelimitDecision(ctx, req, true, req.Cost)
+	}
+
 	durationMs := req.Duration.Milliseconds()
 	sequence := calculateSequence(req.Time, req.Duration)
 	key := counterKey{
diff --git a/internal/services/ratelimit/persisted_bucket_test.go b/internal/services/ratelimit/persisted_bucket_test.go
new file mode 100644
index 0000000000..b7cd221ca0
--- /dev/null
+++ b/internal/services/ratelimit/persisted_bucket_test.go
@@ -0,0 +1,324 @@
+package ratelimit
+
+import (
+	"context"
+	"database/sql"
+	"strconv"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/stretchr/testify/require"
+	"github.com/unkeyed/unkey/pkg/db"
+)
+
+type memoryBucketDB struct {
+	mu             sync.Mutex
+	rows           map[string]db.RatelimitBucket
+	hydrationRuns  map[string]int32
+	upsertCallCount int
+}
+
+func newMemoryBucketDB() *memoryBucketDB {
+	return &memoryBucketDB{
+		rows:          map[string]db.RatelimitBucket{},
+		hydrationRuns: map[string]int32{},
+	}
+}
+
+func (m *memoryBucketDB) RatelimitBucketUpsert(ctx context.Context, arg db.RatelimitBucketUpsertParams) error {
+	m.mu.Lock()
+	defer m.mu.Unlock()
+	m.upsertCallCount++
+	key := arg.Namespace + ":" + arg.Identifier + ":" + strconv.FormatUint(arg.BucketStartMs, 10)
+	row := m.rows[key]
+	if row.ID == "" {
+		row.ID = arg.ID
+		row.WorkspaceID = arg.WorkspaceID
+		row.Namespace = arg.Namespace
+		row.Identifier = arg.Identifier
+		row.Region = arg.Region
+		row.BucketStartMs = arg.BucketStartMs
+		row.BucketEndMs = arg.BucketEndMs
+		row.LimitValue = arg.LimitValue
+		row.DurationMs = arg.DurationMs
+		row.ExpiresAt = arg.ExpiresAt
+		row.CreatedAt = time.Now()
+	}
+	row.Accepted += arg.Accepted
+	row.Denied += arg.Denied
+	row.Cost += arg.Cost
+	row.LastRequestAt = arg.LastRequestAt
+	row.UpdatedAt = time.Now()
+	m.rows[key] = row
+	return nil
+}
+
+func (m *memoryBucketDB) RatelimitBucketGet(ctx context.Context, arg db.RatelimitBucketGetParams) (db.RatelimitBucket, error) {
+	m.mu.Lock()
+	defer m.mu.Unlock()
+	key := arg.Namespace + ":" + arg.Identifier + ":" + strconv.FormatUint(arg.BucketStartMs, 10)
+	row, ok := m.rows[key]
+	if !ok {
+		return db.RatelimitBucket{}, sql.ErrNoRows
+	}
+	return row, nil
+}
+
+func (m *memoryBucketDB) RatelimitBucketListActiveForHydration(ctx context.Context, arg db.RatelimitBucketListActiveForHydrationParams) ([]db.RatelimitBucket, error) {
+	m.mu.Lock()
+	defer m.mu.Unlock()
+	rows := make([]db.RatelimitBucket, 0, len(m.rows))
+	for _, row := range m.rows {
+		if row.ExpiresAt >= arg.NowMs {
+			rows = append(rows, row)
+		}
+	}
+	return rows, nil
+}
+
+func (m *memoryBucketDB) RatelimitBucketHydrationRunCreate(ctx context.Context, id string, region string) error {
+	m.mu.Lock()
+	defer m.mu.Unlock()
+	m.hydrationRuns[id] = 0
+	return nil
+}
+
+func (m *memoryBucketDB) RatelimitBucketHydrationRunComplete(ctx context.Context, id string, rowsLoaded int32) error {
+	m.mu.Lock()
+	defer m.mu.Unlock()
+	m.hydrationRuns[id] = rowsLoaded
+	return nil
+}
+
+func TestPersistedBucket_WritesAcceptedDecision(t *testing.T) {
+	t.Parallel()
+
+	store := newPersistedBucketStore(newMemoryBucketDB(), "iad1")
+	req := persistedBucketWrite{
+		WorkspaceID: "ws_test",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        1,
+		Accepted:    true,
+		RequestTime: time.Date(2026, 5, 16, 10, 0, 15, 0, time.UTC),
+	}
+
+	store.write(context.Background(), req)
+	row, ok := store.get(context.Background(), req.Namespace, req.Identifier, req.RequestTime)
+	require.True(t, ok)
+	require.Equal(t, "ws_test", row.WorkspaceID)
+	require.Equal(t, "tokens", row.Namespace)
+	require.Equal(t, "user_123", row.Identifier)
+	require.Equal(t, uint64(1), row.Accepted)
+	require.Equal(t, uint64(1), row.Cost)
+	require.Equal(t, "iad1", row.Region)
+}
+
+func TestPersistedBucket_IncrementsExistingMinute(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	store := newPersistedBucketStore(mem, "iad1")
+	req := persistedBucketWrite{
+		WorkspaceID: "ws_test",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        1,
+		Accepted:    true,
+		RequestTime: time.Date(2026, 5, 16, 10, 0, 15, 0, time.UTC),
+	}
+
+	store.write(context.Background(), req)
+	store.write(context.Background(), req)
+
+	row, ok := store.get(context.Background(), req.Namespace, req.Identifier, req.RequestTime)
+	require.True(t, ok)
+	require.Equal(t, uint64(2), row.Accepted)
+	require.Equal(t, uint64(2), row.Cost)
+	require.Equal(t, 2, mem.upsertCallCount)
+}
+
+func TestPersistedBucket_HydratesRecentRows(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	store := newPersistedBucketStore(mem, "iad1")
+	req := persistedBucketWrite{
+		WorkspaceID: "ws_test",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        3,
+		Accepted:    true,
+		RequestTime: time.Date(2026, 5, 16, 10, 0, 15, 0, time.UTC),
+	}
+
+	store.write(context.Background(), req)
+	rows, err := store.hydrate(context.Background(), 100)
+	require.NoError(t, err)
+	require.Len(t, rows, 1)
+	require.Equal(t, "ws_test", rows[0].WorkspaceID)
+	require.Equal(t, "tokens", rows[0].Namespace)
+	require.Equal(t, "user_123", rows[0].Identifier)
+	require.Equal(t, int64(3), rows[0].Count)
+}
+
+func TestPersistedBucket_NamespaceReuseAcrossWorkspaces(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	store := newPersistedBucketStore(mem, "iad1")
+	at := time.Date(2026, 5, 16, 10, 0, 15, 0, time.UTC)
+
+	store.write(context.Background(), persistedBucketWrite{
+		WorkspaceID: "ws_a",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        1,
+		Accepted:    true,
+		RequestTime: at,
+	})
+	store.write(context.Background(), persistedBucketWrite{
+		WorkspaceID: "ws_b",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        1,
+		Accepted:    true,
+		RequestTime: at,
+	})
+
+	row, ok := store.get(context.Background(), "tokens", "user_123", at)
+	require.True(t, ok)
+	require.Equal(t, uint64(2), row.Cost)
+	require.Equal(t, "ws_a", row.WorkspaceID)
+	require.Len(t, mem.rows, 1)
+}
+
+func TestPersistedBucket_UsesCurrentMinute(t *testing.T) {
+	t.Parallel()
+
+	start, end := bucketWindowForRequest(time.Date(2026, 5, 16, 10, 31, 42, 0, time.UTC))
+
+	require.False(t, start.IsZero())
+	require.Equal(t, time.Minute, end.Sub(start))
+	require.Equal(t, 0, start.Second())
+	require.Equal(t, 0, start.Nanosecond())
+}
+
+func TestService_HydratesPersistedBucketsIntoCounters(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	store := newPersistedBucketStore(mem, "iad1")
+	req := persistedBucketWrite{
+		WorkspaceID: "ws_test",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        5,
+		Accepted:    true,
+		RequestTime: time.Now(),
+	}
+	store.write(context.Background(), req)
+
+	svc := &service{
+		persistedBuckets: store,
+		counters:         sync.Map{},
+	}
+	svc.hydratePersistedBuckets(context.Background())
+
+	rows, err := store.hydrate(context.Background(), 100)
+	require.NoError(t, err)
+	require.Len(t, rows, 1)
+	key := hydrateCounterKey(rows[0])
+	counter := svc.loadCounter(key)
+	require.Equal(t, int64(5), counter.val.Load())
+}
+
+func TestBucketID_IsStableForSubjectAndMinute(t *testing.T) {
+	t.Parallel()
+
+	at := time.Date(2026, 5, 16, 10, 31, 42, 0, time.UTC)
+	start, _ := bucketWindowForRequest(at)
+
+	first := bucketID("tokens", "user_123", start)
+	second := bucketID("tokens", "user_123", start)
+	require.Equal(t, first, second)
+	require.NotEmpty(t, first)
+}
+
+func TestBucketID_ChangesByIdentifier(t *testing.T) {
+	t.Parallel()
+
+	at := time.Date(2026, 5, 16, 10, 31, 42, 0, time.UTC)
+	start, _ := bucketWindowForRequest(at)
+
+	first := bucketID("tokens", "user_123", start)
+	second := bucketID("tokens", "user_456", start)
+	require.NotEqual(t, first, second)
+}
+
+func TestPersistedBucket_DeniedDecisionRecorded(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	store := newPersistedBucketStore(mem, "iad1")
+	at := time.Date(2026, 5, 16, 10, 0, 15, 0, time.UTC)
+
+	store.write(context.Background(), persistedBucketWrite{
+		WorkspaceID: "ws_test",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       1,
+		Duration:    time.Minute,
+		Cost:        1,
+		Accepted:    false,
+		RequestTime: at,
+	})
+
+	row, ok := store.get(context.Background(), "tokens", "user_123", at)
+	require.True(t, ok)
+	require.Equal(t, uint64(0), row.Accepted)
+	require.Equal(t, uint64(1), row.Denied)
+}
+
+func TestPersistedBucket_DebugSubjectReturnsCost(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	store := newPersistedBucketStore(mem, "iad1")
+	at := time.Date(2026, 5, 16, 10, 0, 15, 0, time.UTC)
+
+	store.write(context.Background(), persistedBucketWrite{
+		WorkspaceID: "ws_test",
+		Namespace:   "tokens",
+		Identifier:  "user_123",
+		Limit:       10,
+		Duration:    time.Minute,
+		Cost:        4,
+		Accepted:    true,
+		RequestTime: at,
+	})
+
+	count, ok := store.debugSubject(context.Background(), "tokens", "user_123", at)
+	require.True(t, ok)
+	require.Equal(t, int64(4), count)
+}
+
+func TestPersistedBucket_ExpiredRowsAreIgnored(t *testing.T) {
+	t.Parallel()
+
+	mem := newMemoryBucketDB()
+	start := time.Now().Add(-10 * time.Minute).Truncate(time.Minute)
+	mem.rows["tokens:user_123:"+strconv.FormatInt(start.UnixMilli(), 10)] = db.RatelimitBucket{
+		ID:            "rlb_old",
+		WorkspaceID:   "ws_test",
+		Namespace:     "tokens",
+		Identifier:    "user_123",
+		Region:        "iad1",
+		BucketStartMs: uint64(start.UnixMilli()),
+		BucketEndMs:   uint64(start.Add(time.Minute).UnixMilli()),
+		LimitValue:    10,
+		DurationMs:    uint64(time.Minute.Milliseconds()),
+		Cost:          9,
+		ExpiresAt:     uint64(start.Add(time.Minute).UnixMilli()),
+	}
+
+	store := newPersistedBucketStore(mem, "iad1")
+	rows, err := store.hydrate(context.Background(), 100)
+	require.NoError(t, err)
+	require.Empty(t, rows)
+}
```

## Intended Flaws

### Flaw 1: Persisted Bucket Identity Is Not Scoped To The Rate-Limit Contract

- `type`: `tenant_boundary`
- `location`: `pkg/mysql/schema/ratelimit_minute_buckets.sql:18-22`, `pkg/db/queries/ratelimit_buckets.sql:43-58`, `pkg/db/queries/ratelimit_buckets.sql:130-143`, `internal/services/ratelimit/persisted_bucket.go:50-62`, `internal/services/ratelimit/persisted_bucket.go:193-202`, `internal/services/ratelimit/persisted_bucket_test.go:147-183`
- `learner_prompt`: What uniquely identifies a rate-limit bucket in the existing limiter, and does the new persisted table preserve that identity?

Expected answer:

- `identify`: The persisted bucket key is only `(namespace, identifier, bucket_start_ms)`. The table stores `workspace_id`, `region`, `duration_ms`, and `limit_value`, but the unique index, bucket ID, read query, subject query, and test double all ignore `workspace_id`. They also ignore the full existing `counterKey` contract of `(workspaceID, namespace, identifier, durationMs, sequence)`, and the region field is stored as diagnostic text rather than being part of the persistence semantics.
- `impact`: Two workspaces that both use namespace `tokens` and identifier `user_123` will write to the same persisted row. A restart can hydrate workspace B with workspace A's usage, causing cross-customer throttling or accidental allowance depending on which row was last written. Different duration limits for the same subject can also overwrite each other's window metadata. Cross-region behavior becomes muddled because this table now acts like a shared enforcement surface without matching the existing origin/blocklist key contract.
- `fix_direction`: Make the persisted bucket identity match the limiter identity. At minimum use a compound key over `workspace_id`, `namespace`, `identifier`, `duration_ms`, and `sequence` or `bucket_start_ms`. If the persisted row represents local regional state before origin reconciliation, include `region` in that identity and merge deliberately during hydration. Every get/list/upsert/debug query must accept the same scoped key, and tests must assert that identical namespace and identifier values in different workspaces never collide.

Hints:

1. Compare the new unique index to `counterKey` in the existing limiter at `internal/services/ratelimit/keys.go`.
2. In this codebase, `Namespace` is not globally unique.
3. Read `NamespaceReuseAcrossWorkspaces` as a product scenario. What should two workspaces sharing a namespace string prove about the key shape?

### Flaw 2: Bucket Windows Use Local Wall-Clock Time Instead Of The Request Sequence Contract

- `type`: `time_window_contract`
- `location`: `internal/services/ratelimit/persisted_bucket.go:64-83`, `internal/services/ratelimit/persisted_bucket.go:105-136`, `internal/services/ratelimit/persisted_bucket.go:159-166`, `internal/services/ratelimit/ratelimit.go:227-240`, `internal/services/ratelimit/origin.go:69-75`, `internal/services/ratelimit/persisted_bucket_test.go:185-196`
- `learner_prompt`: The existing limiter computes windows from `req.Time` and `req.Duration`. What does the persisted-bucket path use?

Expected answer:

- `identify`: `bucketWindowForRequest` ignores the supplied `requestTime` once it has a non-zero value and uses `time.Now().Truncate(time.Minute)`. Writes use `LastRequestAt: time.Now()`, hydration reads compare against `time.Now()`, and `prepareCheck` may replace the request-derived sequence with a row whose `bucket_start_ms` was derived from the writer's local clock. This breaks the existing `calculateSequence(req.Time, req.Duration)` contract.
- `impact`: A request accepted at `10:00:59.900` can be persisted into `10:01` if replayed or written by a slightly skewed process. Different regions can split the same logical window across different minute rows. Tests become timing-dependent. More importantly, hydration can raise the wrong in-memory counter after restart, so customers see inconsistent remaining counts and reset times even when Redis/origin would have converged correctly.
- `fix_direction`: Use the canonical rate-limit sequence everywhere. Derive persisted buckets from `sequence := calculateSequence(req.Time, req.Duration)` and store that sequence plus duration, not a separate local-clock minute. `bucket_start_ms` should be `sequence * durationMs` if it is kept at all. Use the injected service clock for service-owned time, but never recompute a request's window from `time.Now()` after validation. Replayed requests should carry and persist the original accepted request time.

Hints:

1. Search the diff for `time.Now()` in the persistence path.
2. The function takes `requestTime`, but what value does it actually truncate?
3. Existing origin sync in `internal/services/ratelimit/origin.go` asserts request time is non-zero because replay must keep the original window from `calculateSequence(req.Time, req.Duration)`.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the persisted bucket identity is weaker than the existing limiter key. Answers that only say "missing workspace_id in one query" are incomplete unless they connect it to cross-tenant counter pollution and duration/region semantics.

For flaw 2, a correct answer must identify the local-clock window violation. Answers that only say "time.Now makes tests flaky" are incomplete unless they explain how it changes enforcement windows and restart hydration.

### Product-Level Change

The PR tries to make rate limiting more resilient to regional restarts by persisting recent local bucket counts. That product goal is reasonable: if a gateway restarts under active traffic, it should not suddenly forget the last few accepted requests.

### Changed Contracts

- Counter identity contract: persisted buckets become another representation of the limiter's counter key.
- Time-window contract: persisted rows now participate in choosing the active window sequence.
- Recovery contract: startup hydration can raise local counters before Redis origin replay catches up.
- Cross-region contract: the persistence path now sits near existing origin sync and denial propagation behavior.
- Operational contract: MySQL writes are introduced into a hot request path.

### Failure Modes

Workspace A and workspace B both define namespace `tokens` and rate limit identifier `user_123`. Workspace A sends 900 requests. Workspace B sends one request after a gateway restart. Because the persisted bucket key ignores workspace, B hydrates A's count and gets throttled even though B did not consume that quota.

A gateway accepts a request with `req.Time` at the end of a minute, then the async replay path writes the persisted bucket after the wall clock crosses the minute boundary. The in-memory limiter and Redis origin count the request in sequence N, but MySQL stores it in sequence N+1. After restart, hydration raises the wrong counter and customers see incorrect remaining/reset values.

### Reviewer Thought Process

A strong reviewer starts by asking, "What is the identity of this thing in the existing system?" The existing code answers that clearly: workspace, namespace, identifier, duration, and sequence. Any new table that represents the same concept must preserve that identity unless the PR explicitly changes the contract.

Then the reviewer checks time. Rate limiters are mostly time-window machines. If one part of the system uses request time and another uses local write time, the same request can land in different windows depending on retries, replays, skew, or region.

### Better Implementation Direction

- Store `workspace_id`, `namespace`, `identifier`, `duration_ms`, and `sequence` as the persisted bucket key.
- Decide whether persisted buckets are regional local state or global recovered state. If regional, include `region` and merge with origin intentionally. If global, document why the existing origin counter is not enough.
- Derive `bucket_start_ms` from `sequence * duration_ms`, not from `time.Now().Truncate(time.Minute)`.
- Pass workspace and duration into every read path, including diagnostics.
- Hydrate counters only into matching `counterKey` values.
- Add tests for two workspaces sharing namespace and identifier, two durations sharing subject, request time near a boundary, replay after boundary rollover, and two regions writing the same subject.

## Why This Case Exists

This case teaches the reviewer to protect core service contracts when a PR adds persistence. The code "works" in a single workspace, single region, happy-path test, but it changes the meaning of a rate-limit counter. Great engineers catch that before production customers become each other's quota.
